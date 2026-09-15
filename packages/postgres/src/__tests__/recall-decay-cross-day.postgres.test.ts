import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Clock, Ctx } from "@mnemora/core";
import { createRuntime, DEFAULT_HALF_LIFE_HOURS, defaultDecayStrategy } from "@mnemora/core";
import { DeterministicEmbeddingProvider, DeterministicLLMProvider } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { sha256Hex } from "../content-hash.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 北極星 項目1「言ったことを、次の日も覚えている。」（docs/north-star.md:28）を、
 * **本物の Postgres + `Runtime.recall()`** を通して実測する（Issue #302）。
 *
 * これまでの検証は数式だけだった:
 * `floorAt()` = recordedAt + halfLifeHours × log2(strength/threshold)
 * （`packages/core/src/strategies/decay.ts`）に既定値
 * （`DEFAULT_HALF_LIFE_HOURS=720`・`DEFAULT_DECAY_THRESHOLD=0.05`・`strength=1`）を
 * 当てはめると `decay_floor_at ≈ 作成 + 約129.6日` になる、というコードパスの追跡であって、
 * `runtime.observe()` → `runtime.recall()` を実際に走らせて確かめたことは一度も無かった
 * （PR #286 の `recall-decay-gate.test.ts` はインメモリの `createFakeRuntimeStores()` で
 * Postgres を通らず、Postgres 側で `decayFloorAtAfter` を見ているのは
 * `vector-search-hnsw.test.ts` の1件のみで `VectorStore.search()` 単体・時間経過なし）。
 *
 * ここでは `deps.clock`（`RuntimeDeps.clock`、既定は `systemClock`）を可変にした
 * `MutableClock`（`examples/chat/src/mutable-clock.ts` の `MutableClock`/`createMutableClock`
 * と同じ形——別パッケージなのでここに複製する）を注入し、実時間を待たずに
 * 「日をまたいだ」「忘却ゲートの既定余裕を跨いだ」状態を作って測る。
 *
 * ⚠ `packages/postgres` の `outbox.available_at` はアプリの `Clock` を読まず、
 * Postgres 側の SQL `now()` で入る（`memory-store.ts` の `INSERT INTO outbox` /
 * `examples/chat/src/mutable-clock.ts` の docstring）。⟹ `runtime.tick()`（embed の消化）は
 * **必ずクロックを実時刻付近に置いた状態で呼ぶ**——過去や未来へ振った直後に
 * `tick()` を呼ぶと `available_at <= opts.now` が成り立たず embed ジョブを claim できない
 * （`outbox-store.ts` の `claimBatch`）。**ローカル Postgres で実際にこの失敗を再現した**
 * （`observe()` の直前に取った `t0` をそのまま `tick()` に渡すと、`observe()` の INSERT が
 * 実際にコミットされる実時刻のほうがわずかに後になり、`available_at > opts.now` で
 * 0件しか claim できなかった）。⟹ このファイルでは `tick()` の**直前**に必ず
 * `clock.set(new Date())` で取り直す（`archive-sweep-cost.ts` と同じ対処）。
 *
 * ⭐ **実測で分かった、忘却ゲート（`decayGateActive`）と段2のスコア減衰は別物である**
 * （`(乙)` の歯で検算した）。`decayGateActive` は段1・SQL 側の**硬い**除外だが、
 * `strategies/scoring.ts` の `total = affinity × decay × tagMatch × freshness × strength`
 * も同じ `defaultDecayStrategy.strengthAt()` を使っており、`decayFloorAt` を過ぎた
 * Memory は `includeFullyDecayed: true` でゲートを外しても**既定の `scoreThreshold`
 * （0.1）では below_threshold として落ちる**（`decay`/`freshness` が ≈threshold(0.05) 以下
 * になるため）。⟹ ゲート単体の効果を切り出すには `scoreThreshold: 0` を併用する必要がある
 * ——`(乙)` はこの2つを分けて検算している。
 *
 * **確かめていないこと**: この歯は `channels` を指定しない既定（ANN のみ、
 * `DEFAULT_RECALL_CHANNELS`）でしか測っていない。語彙チャンネル（lexical）は
 * `LexicalFilter` が `decayFloorAtAfter` を持たず、忘却ゲートは全チャンネル共通の
 * 後置フィルタ（`recall-runtime.ts` の `decayFilteredCount`）で掛かる——ANN 単体とは
 * 別の経路であり、ここでは検査していない。
 */

function createMutableClock(initial: Date): Clock & { set(at: Date): void } {
  let current = initial;
  return {
    now: () => current,
    set: (at: Date) => {
      current = at;
    },
  };
}

async function buildTestRuntime(clock: Clock) {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: new PostgresOutboxStore(db),
    vectorStore,
    eventStore: new PostgresEventStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: new DeterministicLLMProvider(),
    embeddingProvider: new DeterministicEmbeddingProvider(TEST_EMBEDDING_SPACE),
    hashContent: sha256Hex,
    clock,
  });
  return { runtime, memoryStore };
}

describe("runtime.recall() が decay を跨いで実際にどう振る舞うか — 本物の Postgres（Issue #302）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("(甲) observe() した内容は、+24h 後の recall() でも返る（decay_floor_at をまだ跨がない）", async () => {
    await resetTestDatabase();
    const ctx: Ctx = { tenantId: `tenant-decay-next-day-${randomUUID()}` };
    const t0 = new Date();
    const clock = createMutableClock(t0);
    const { runtime } = await buildTestRuntime(clock);

    const text = `昨日言ったこと ${randomUUID()}`;
    const observed = await runtime.observe(ctx, { kind: "utterance", text });
    const memoryId = observed.memoryIds[0]!;

    // embed を消化する直前に、クロックを実時刻へ**取り直す**（`t0` のまま使い回さない）。
    // ⚠ 実測で踏んだ罠: `outbox.available_at` は Postgres 側の SQL `now()` で入るため、
    // `observe()` の INSERT が実際にコミットされる時刻は `t0` よりわずかに後になる。
    // `opts.now`（`claimBatch` の `available_at <= opts.now` 判定に使われる）を `t0` の
    // ままにしておくと `available_at > opts.now` になり、embed ジョブを1件も claim
    // できない（`tickResult.processed` が 0 のまま）——実際にローカル Postgres でこの
    // 失敗を再現した。`archive-sweep-cost.ts` が `tick()` の直前に必ず
    // `clock.set(new Date())` で取り直しているのと同じ理由・同じ対処。
    clock.set(new Date());
    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(tickResult.processed).toBe(1);

    // 前提の検算: 既定の忘却ゲートの余裕（≈ +129.6日）は +24h よりずっと先である
    // （Issue #302 の数式をこの歯自身でも検算する。数式だけに頼らない）。
    const floorAt = defaultDecayStrategy.floorAt({
      recordedAt: t0,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: DEFAULT_HALF_LIFE_HOURS,
    });
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(floorAt.getTime()).toBeGreaterThan(t0.getTime() + oneDayMs);

    // 「次の日」へ進める。occurredAt/recordedAt には触れない——clock だけを進める。
    clock.set(new Date(t0.getTime() + oneDayMs));

    const result = await runtime.recall(ctx, { text, limit: 10 });
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(memoryId);

    // 忘却ゲート自体は既定で有効なまま（ADR 0153）——+24h ではまだ何も落とさないことを
    // stages 側からも見る（「ゲートが働いていないから通った」のではないことの確認）。
    const candidateGen = result.explain.stages.find((s) => s.stage === "candidate_generation");
    const detail = candidateGen?.detail as { decayGate?: string } | undefined;
    expect(detail?.decayGate).toBe("pushed_down");
  });

  it("(乙) 忘却ゲートの既定余裕（作成+約129.6日）を跨いだ後は recall() で落ちる（decayGateActive の除外）", async () => {
    await resetTestDatabase();
    const ctx: Ctx = { tenantId: `tenant-decay-gate-${randomUUID()}` };
    const t0 = new Date();
    const clock = createMutableClock(t0);
    const { runtime } = await buildTestRuntime(clock);

    const text = `いずれ忘れられる発話 ${randomUUID()}`;
    const observed = await runtime.observe(ctx, { kind: "utterance", text });
    const memoryId = observed.memoryIds[0]!;

    // embed を消化する直前にクロックを実時刻へ取り直す（(甲) と同じ理由・同じ罠）。
    clock.set(new Date());
    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(tickResult.processed).toBe(1);

    const floorAt = defaultDecayStrategy.floorAt({
      recordedAt: t0,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: DEFAULT_HALF_LIFE_HOURS,
    });
    // 余裕を跨いだことが揺るがないよう、境界ちょうどではなく +1日を足す。
    const afterFloor = new Date(floorAt.getTime() + 24 * 60 * 60 * 1000);
    clock.set(afterFloor);

    const gated = await runtime.recall(ctx, { text, limit: 10 });
    const gatedIds = gated.memories.map((m) => m.memoryId);
    expect(gatedIds).not.toContain(memoryId);

    // ⚠ ここでは `omitted` に `{kind:"filtered", condition:"decayed"}` は現れない。
    // **確かめた実態**（`recall-runtime.ts` を読んで追跡した）: 既定チャンネル（ANN のみ）では
    // `decayFloorAtAfter` を段1の `VectorStore.search()` の filter として渡しており
    // （ADR 0153）、この Memory は Postgres 側の SQL で候補集合にすら入らない。
    // 後置フィルタ（`decayFilteredCount` → `omitted.push({kind:"filtered",
    // condition:"decayed", countKind:"lower_bound"})`）は「ANN の候補として一度返ってきた
    // ものを、それでも念のため落とす」ときにしか鳴らない——語彙チャンネル
    // （`LexicalFilter` は `decayFloorAtAfter` を持たない）が
    // 混ざったときの非対称を塞ぐための保険であって、ANN 単体の既定経路では
    // 一度も鳴らない。⟹ ここで「消えたこと」は、`omitted` の中身ではなく
    // 下の対照実験（`includeFullyDecayed: true` + `scoreThreshold: 0` で戻ってくること）で示す。
    expect(gated.omitted.some((o) => o.kind === "filtered" && o.condition === "decayed")).toBe(
      false,
    );
    const gatedCandidateGen = gated.explain.stages.find((s) => s.stage === "candidate_generation");
    const gatedDetail = gatedCandidateGen?.detail as { decayGate?: string } | undefined;
    expect(gatedDetail?.decayGate).toBe("pushed_down");

    // ⚠ 実測で分かったこと（設計当初は想定していなかった）: `includeFullyDecayed: true` で
    // ゲートを外しても、**既定の scoreThreshold（0.1）のままでは戻ってこない。**
    // 段2の再スコア（`strategies/scoring.ts`）の `total = affinity × decay × tagMatch ×
    // freshness × strength` のうち `decay`/`freshness` はどちらも
    // `defaultDecayStrategy.strengthAt()` そのもので、floorAt を過ぎた時点では
    // ≈threshold（0.05）以下——ゲートとは**別の理由**（below_threshold、段2のソフトな
    // 足切り）で落ちる。⟹ ゲート単体の効果を切り出すには `scoreThreshold: 0` で
    // このソフトな足切りを外す必要がある。まずそれ自体を検算する。
    const ungatedDefaultThreshold = await runtime.recall(ctx, {
      text,
      limit: 10,
      includeFullyDecayed: true,
    });
    const ungatedDefaultThresholdIds = ungatedDefaultThreshold.memories.map((m) => m.memoryId);
    expect(ungatedDefaultThresholdIds).not.toContain(memoryId);
    expect(ungatedDefaultThreshold.omitted.some((o) => o.kind === "below_threshold")).toBe(true);

    // 対照実験（本題）: `includeFullyDecayed: true` **かつ** `scoreThreshold: 0` で
    // 段2のソフトな足切りも外すと戻ってくる。gate 側は `scoreThreshold` を通っていない
    // （段1・SQL 側の話）ので、`scoreThreshold: 0` にしても gated 側の結果は変わらないはず
    // ——それも合わせて検算する（下の `gatedZeroThreshold`）。
    const gatedZeroThreshold = await runtime.recall(ctx, { text, limit: 10, scoreThreshold: 0 });
    const gatedZeroThresholdIds = gatedZeroThreshold.memories.map((m) => m.memoryId);
    expect(gatedZeroThresholdIds).not.toContain(memoryId);

    const ungated = await runtime.recall(ctx, {
      text,
      limit: 10,
      includeFullyDecayed: true,
      scoreThreshold: 0,
    });
    const ungatedIds = ungated.memories.map((m) => m.memoryId);
    expect(ungatedIds).toContain(memoryId);
    const ungatedCandidateGen = ungated.explain.stages.find(
      (s) => s.stage === "candidate_generation",
    );
    const ungatedDetail = ungatedCandidateGen?.detail as { decayGate?: string } | undefined;
    expect(ungatedDetail?.decayGate).toBe("disabled");
  });
});
