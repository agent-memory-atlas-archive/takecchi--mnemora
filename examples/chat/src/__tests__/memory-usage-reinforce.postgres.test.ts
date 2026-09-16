import { afterAll, describe, expect, it } from "vitest";
import { defaultDecayStrategy } from "@mnemora/core";
import type { Ctx } from "@mnemora/core";
import { buildConversation } from "../scenario.js";
import { ingestConversation, queryRecall, reportMemoryUsage } from "../mnemora-path.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { createMutableClock } from "../mutable-clock.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * ⭐ Issue #301 / ADR 0163 の核心の歯。
 *
 * `examples/chat` が `reportMemoryUsage`（`mnemora-path.ts`）を実際に配線するまで、
 * `observe({kind:'memory_usage'})` はどこからも呼ばれず、`reinforce`
 * （`packages/core/src/runtime.ts` の `handleMemoryUsage`）が実アプリで一度も
 * 発火しなかった（Issue #301 本文）。**単体テストの緑だけで「効いた」と報告しない**
 * ——ここでは本物の Postgres に対して実際に `recall → 使用報告 → 読み戻し` を行い、
 * 「使われた記憶」と「使われなかった記憶」で `last_reinforced_at`/`decay_floor_at`、
 * そして同一時刻に対する `decay`（`defaultDecayStrategy.strengthAt`）の値が
 * 実際に分かれることを実測する。
 *
 * **仕掛け**:
 * 1. `buildConversation(15)` で user 発話16件（fact 1 + filler 15）を ingest する。
 *    `recall()` の既定 `limit` は10（`DEFAULT_RECALL_LIMIT`）——16件中10件だけが
 *    返り、残り6件は一度も候補として提示されない「対照群」になる。
 * 2. 1回目の `recall()` → `reportMemoryUsage()` で、返った10件を使用報告する
 *    （この時点ではまだ clock を進めていないため、reinforce の基準時刻は
 *    `recordedAt` と同時刻——ここではまだ差が付かない）。
 * 3. `MutableClock` を +200時間進め、同じクエリで2回目の `recall()` を撃つ
 *    （decay は全件同じ基準時刻からまだ一様に進んでいるため、ここでもまだ
 *    ANN の順位は実質変わらず、同じ10件が返るはず——前提として assert する）。
 *    その返り値をもう一度 `reportMemoryUsage()` で報告する。これで「使われた」
 *    10件の `last_reinforced_at` が t0 から t1（+200h）へ進む。
 * 4. `MutableClock` をさらに +200時間（t0 から通算 +400h）進め、
 *    「使われた」10件のうちの1件と、一度も返らなかった「使われなかった」6件の
 *    うちの1件を `memoryStore.get()` で読み戻す。
 *
 * **主張**:
 * - `recall_usages` に実際に行が入っている（`pool.query` で直接数える）。
 * - 使われた側は `last_reinforced_at` が t1（reinforce が実際に発火した時刻）に
 *   なっており、使われなかった側は `last_reinforced_at` が依然 `null`
 *   （一度も reinforce されていない）。
 * - 使われた側の `decay_floor_at` が使われなかった側より後ろにずれている
 *   （reinforce が decay の基準点を先送りにした、という ADR 0010 の契約どおり）。
 * - t2（+400h）時点で `defaultDecayStrategy.strengthAt` を計算すると、
 *   使われた側のほうが高い（＝より遠ざかっていない）——これが北極星の
 *   「使われない記憶が、静かに遠ざかる」の*選別*が実際に効いていることの実測。
 *   **数値は console.log で CI ログに残す**（issue の「単体テストの緑だけで
 *   『効いた』と報告しない」という明示に応じるため）。
 */
describe("examples/chat: reportMemoryUsage → reinforce が本物の Postgres 上で発火する（Issue #301）", () => {
  it("使われた記憶と使われなかった記憶で last_reinforced_at / decay_floor_at / decay に差が出る", async () => {
    await resetTestDatabase();
    await getTestClient();

    // `t0` は実時刻より60秒先を初期値にする。**過去に固定してはいけない**——
    // `outbox.available_at` は Postgres の SQL `now()`（本物の壁時計時刻）で入るが、
    // `tick()` の claim 条件 `available_at <= opts.now` の `opts.now` は
    // アプリ側の `Clock`（ここでは固定された `t0`）から来る
    // （`packages/postgres/src/outbox-store.ts`、`mutable-clock.ts` のdocstring、
    // `time-term-arm.ts` の「⭐⚠」節が実測で踏んだのと同じ罠）。`t0` を過去や
    // 現在時刻ちょうどにすると、`ingestConversation` 内の `drainEmbedTicks` が
    // 1件も claim できず、embed が永久に `pending` のまま残る
    // （実際にこの罠を踏んで確認した——後述「確かめたこと」参照）。
    const t0 = new Date(Date.now() + 60_000);
    const clock = createMutableClock(t0);
    const handle = await createExampleRuntime(requireDatabaseUrl(), {}, {}, clock);
    try {
      const ctx: Ctx = { tenantId: "example-chat-reinforce-fires" };
      // fact 1 + filler 15 = user 発話16件。既定 limit(10) を上回るので、
      // 一度も返らない「対照群」が構造的に生まれる。
      const conversation = buildConversation(15);
      expect(conversation.userUtterances.length).toBe(16);

      await ingestConversation(handle.runtime, ctx, conversation);

      // --- 1回目の recall + 使用報告(t0) ---
      const recall1 = await queryRecall(handle.runtime, ctx, conversation);
      expect(recall1.index.totalInScope).toBe(16);
      expect(recall1.memories.length).toBeLessThan(16); // 前提: 実際に絞り込みが起きている
      const usedIds1 = new Set(recall1.memories.map((m) => m.memoryId));
      const report1 = await reportMemoryUsage(handle.runtime, ctx, recall1);
      expect(report1.reported).toBe(true);

      // --- t1 = t0+200h に進めて、2回目の recall + 使用報告 ---
      const t1 = new Date(t0.getTime() + 200 * 60 * 60 * 1000);
      clock.set(t1);
      const recall2 = await queryRecall(handle.runtime, ctx, conversation);
      // 前提: 全件がまだ同じ基準時刻から一様に減衰しているため、順位はまだ動かず
      // 同じ10件が返ってくるはず(この前提が崩れたらこの歯は無意味になる)。
      const usedIds2 = new Set(recall2.memories.map((m) => m.memoryId));
      expect(usedIds2).toEqual(usedIds1);
      const report2 = await reportMemoryUsage(handle.runtime, ctx, recall2);
      expect(report2.reported).toBe(true);

      // --- recall_usages に実際に行が入ったことを直接数える ---
      const usageCountResult = await handle.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM recall_usages WHERE recall_id = ANY($1::uuid[])",
        [[recall1.recallId, recall2.recallId]],
      );
      const usageRowCount = Number(usageCountResult.rows[0]?.count ?? "0");
      console.log(
        `[Issue #301 実測] recall_usages に入った行数: ${usageRowCount}` +
          `（recall1: ${usedIds1.size}件 + recall2: ${usedIds2.size}件 の報告に対応）`,
      );
      // recall1/recall2 は同じ10件を報告している——(recall_id, memory_id) が主キーなので
      // recall_id が違えば両方とも実際に INSERT される(10+10=20行)。
      expect(usageRowCount).toBe(usedIds1.size + usedIds2.size);

      // 使用報告した Memory を1件選ぶ。
      const usedMemoryIdFirst = [...usedIds1][0];
      if (usedMemoryIdFirst === undefined) {
        throw new Error("前提が崩れている: 使用報告した Memory が無い");
      }

      // --- t2 = t0+400h まで進めてから読み戻す ---
      const t2 = new Date(t0.getTime() + 400 * 60 * 60 * 1000);
      clock.set(t2);

      const usedMemory = await handle.memoryStore.get(ctx, usedMemoryIdFirst);
      expect(usedMemory).not.toBeNull();
      expect(usedMemory!.lastReinforcedAt).not.toBeNull();
      // reinforce は2回発火した(t0近辺・t1)。最後に効くのは新しいほう(t1)。
      expect(usedMemory!.lastReinforcedAt!.getTime()).toBe(t1.getTime());

      // 対照群: totalInScope=16件のうち、一度も recall() に現れず、
      // したがって一度も使用報告されなかった Memory を、直接 SQL で1件取得する
      // (16件中10件が使用報告された側なので、残り6件のうちの1件が返るはず)。
      const controlRow = (
        await handle.pool.query<{ id: string }>(
          `SELECT id::text AS id FROM memories
           WHERE tenant_id = $1 AND status = 'active' AND id != ALL($2::uuid[])
           LIMIT 1`,
          [ctx.tenantId, [...usedIds1]],
        )
      ).rows[0];
      expect(controlRow).toBeDefined();

      const controlMemory = await handle.memoryStore.get(ctx, controlRow!.id);
      expect(controlMemory).not.toBeNull();
      // 本題: 一度も使用報告されなかった Memory は、reinforce が一度も発火していない
      // ——last_reinforced_at は作成時のまま null。
      expect(controlMemory!.lastReinforcedAt).toBeNull();

      // decay_floor_at: reinforce は基準点を先送りにする(ADR 0010)ため、
      // 使われた側のほうが後ろにずれているはず。
      console.log(
        `[Issue #301 実測] decayFloorAt 使用側=${usedMemory!.decayFloorAt.toISOString()} ` +
          `対照側=${controlMemory!.decayFloorAt.toISOString()}`,
      );
      expect(usedMemory!.decayFloorAt.getTime()).toBeGreaterThan(
        controlMemory!.decayFloorAt.getTime(),
      );

      // decay そのもの: t2 時点で strengthAt を計算すると、使われた側のほうが
      // 高い(=より遠ざかっていない)。ここが北極星の「使われない記憶が、静かに
      // 遠ざかる」の*選別*が実際に効いていることの実測値である。
      const usedStrength = defaultDecayStrategy.strengthAt(t2, {
        recordedAt: usedMemory!.recordedAt,
        lastReinforcedAt: usedMemory!.lastReinforcedAt,
        strength: usedMemory!.strength,
        halfLifeHours: usedMemory!.halfLifeHours,
      });
      const controlStrength = defaultDecayStrategy.strengthAt(t2, {
        recordedAt: controlMemory!.recordedAt,
        lastReinforcedAt: controlMemory!.lastReinforcedAt,
        strength: controlMemory!.strength,
        halfLifeHours: controlMemory!.halfLifeHours,
      });
      console.log(
        `[Issue #301 実測] t2(+400h)時点の decay(strengthAt): ` +
          `使われた側=${usedStrength} 対照側=${controlStrength} ` +
          `(差=${usedStrength - controlStrength}, 比=${usedStrength / controlStrength})`,
      );
      expect(usedStrength).toBeGreaterThan(controlStrength);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
