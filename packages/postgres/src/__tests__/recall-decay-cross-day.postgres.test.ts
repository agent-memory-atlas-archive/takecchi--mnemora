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

    // ⭐⭐ Issue #329 / [ADR 0173](../../../../docs/decisions/0173-decayed-omission-counted-by-aggregate-scope.md):
    // **この歯は反転している。**PR #324 当時ここは `toBe(false)` だった——既定の ANN 単独
    // 経路では `decayFloorAtAfter` を段1の SQL へ押し下げるので、落ちた記憶は候補集合に
    // すら入らず、後置フィルタ（当時の `decayFilteredCount`）は一度も鳴らなかったためである。
    //
    // **なぜ反転が正しいのか**（詳細は ADR 0173。ここには要約だけ置く）:
    // - 当時の期待の出所は仕様でも ADR でもなく**当時の実装を追跡した結果**だった
    //   （旧コメントが「確かめた実態（`recall-runtime.ts` を読んで追跡した）」と自認していた）。
    // - その実態は **ADR 0153 が自分で「引き受けた負債」2 として明記したもの**と同一である。
    //   ⟹ この歯が固定していたのは**負債の現在値**であり、負債を返した以上それは動く。
    // - そしてその状態は、北極星 項目6（「見つからなかった」と「探していない」を、同じ顔で
    //   返さない）と正面から衝突していた。`AGENTS.md`「正典と実装が食い違ったら、
    //   バグなのは実装のほうである」。
    //
    // ⟹ **この歯の役割が変わった。**「減衰しきった記憶が消える事実の記録」から、
    // **「段1の押し下げと段5の集約が同じ述語を見ていることの検算」**へ。
    // 押し下げは1バイトも外していない（下の `decayGate === "pushed_down"` がそれを固定する）。
    const decayedOmissions = gated.omitted.filter(
      (o) => o.kind === "filtered" && o.condition === "decayed",
    );
    expect(decayedOmissions).toHaveLength(1);
    const decayedOmission = decayedOmissions[0] as {
      kind: "filtered";
      condition: "decayed";
      count: number;
      countKind: string;
    };
    // (a) count がこの scope の実際の減衰件数と一致する。この tenant には
    // `observe()` した1件しか居ないので、実測値は 1 である——scope を無視して
    // tenant 全体や DB 全体を数える実装はここで落ちる。
    expect(decayedOmission.count).toBe(1);
    // (b) countKind は "exact"（"lower_bound" から上がった。ADR 0173「戻り値の意味が変わった」）。
    expect(decayedOmission.countKind).toBe("exact");
    // 押し下げは外していない——候補集合そのものから除かれたままであることを stages で固定する。
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

    // (c) ⭐ Issue #329 / ADR 0173: `includeFullyDecayed: true` のときは逆に、この
    // omission が**積まれない**——ゲートを外したのだから「ゲートで落ちた」は 0 件である。
    // これを固定しないと、「常に1件積む」だけの実装でも (a)(b) が通ってしまう。
    expect(ungated.omitted.some((o) => o.kind === "filtered" && o.condition === "decayed")).toBe(
      false,
    );
    expect(
      ungatedDefaultThreshold.omitted.some(
        (o) => o.kind === "filtered" && o.condition === "decayed",
      ),
    ).toBe(false);
  });

  /**
   * ⭐⭐ Issue #329 / ADR 0173: **活動時計（`decay_clock: 'activity'` / `'either'`）でも、
   * 段1の押し下げと段5の集約が同じ述語を見ていること。**
   *
   * ⚠ **ADR 0173 の実測（latency / EXPLAIN / 候補の質）は全行 `wall` でしか取っていない。**
   * この軸は歯で埋める、というのがマネージャーの指示であり、これがその歯である。
   * **本物の Postgres でしか測れない**——`decay_floor_seq` は `bigint` 列であり、
   * `count(*) FILTER` の NULL 三値論理（`decay_floor_seq IS NULL` は沈まない側、
   * ADR 0165 決めたこと4）も SQL 側の振る舞いだからである。
   */
  it("(丙) 活動時計のテナントでも、段1の押し下げと段5の集約が同じ述語で一致する（ADR 0165 の2軸）", async () => {
    await resetTestDatabase();
    const ctx: Ctx = { tenantId: `tenant-decay-activity-${randomUUID()}` };
    const now = new Date();
    const clock = createMutableClock(now);
    const { runtime, memoryStore } = await buildTestRuntime(clock);
    const { db } = await getTestClient();
    const tenantSettingsStore = new PostgresTenantSettingsStore(db);

    // 壁時計では絶対に沈まない（+100年）。活動時計の軸だけで判定されなければならない。
    const farFuture = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 365 * 100);
    // 壁時計では既に沈んでいる。'activity' では**無視**されなければならない。
    const farPast = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 365);

    const seed = async (overrides: {
      decayFloorAt: Date;
      decayFloorSeq: number | null;
      hash: string;
    }) =>
      memoryStore.createMemory(ctx, {
        tenantId: ctx.tenantId,
        subjectId: null,
        sourceObservationId: null,
        extractorVersion: null,
        content: `活動時計の歯 ${overrides.hash}`,
        contentHash: `${ctx.tenantId}-${overrides.hash}`,
        digest: overrides.hash,
        digestSource: "llm",
        provenance: { kind: "imported", batchId: "activity-clock-fixture" },
        tags: [],
        occurredAt: null,
        recordedAt: now,
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours: DEFAULT_HALF_LIFE_HOURS,
        decayFloorAt: overrides.decayFloorAt,
        decayBaseSeq: 0,
        decayFloorSeq: overrides.decayFloorSeq,
        embeddingStatus: "skipped",
      });

    // activity_seq はこのテナントではまだ1本も進んでいない（nowSeq = 0）。
    expect(await tenantSettingsStore.getActivitySeq(ctx)).toBe(0);

    // 壁=生 / 活=死（0 > 0 は false）: 'activity' でも 'either' でも……
    await seed({ decayFloorAt: farFuture, decayFloorSeq: 0, hash: "wall-alive-activity-dead" });
    // 壁=死 / 活=生
    await seed({ decayFloorAt: farPast, decayFloorSeq: 100, hash: "wall-dead-activity-alive" });
    // 壁=死 / 活=死
    await seed({ decayFloorAt: farPast, decayFloorSeq: 0, hash: "wall-dead-activity-dead" });
    // 壁=死 / 活は床が無い（NULL）——ADR 0165 決めたこと4 で「この軸では沈まない」。
    await seed({ decayFloorAt: farPast, decayFloorSeq: null, hash: "wall-dead-activity-null" });

    const decayedCount = async (): Promise<number> => {
      // ⚠ `text` を渡すと埋め込みが要る。ここで見たいのは段5の集約なので、
      //   ベクトルを直接渡して段1を走らせる（上の4件は embeddingStatus: 'skipped' で
      //   ベクトルを持たないため、`memories` には1件も返らない——それでよい）。
      const result = await runtime.recall(ctx, { vector: [0, 0, 1], limit: 10 });
      const omission = result.omitted.find(
        (o) => o.kind === "filtered" && o.condition === "decayed",
      ) as { count: number; countKind: string } | undefined;
      if (omission === undefined) return 0;
      expect(omission.countKind).toBe("exact");
      return omission.count;
    };

    // 'wall'（既定）: 壁時計だけを見る ⟹ farPast の3件。
    expect(await decayedCount()).toBe(3);

    // 'activity': 活動時計だけを見る ⟹ decayFloorSeq が 0（= nowSeq 以下）の2件。
    // NULL の1件は沈まない。壁時計の farPast は一切効かない。
    // ⚠ `decay_clock != 'wall'` のテナントでは recall のたびに activity_seq が +1 する
    //   （ADR 0165 決めたこと5）。`decayFloorSeq: 100` はそれでも当分沈まない。
    await tenantSettingsStore.setDecayClock(ctx, "activity");
    expect(await decayedCount()).toBe(2);

    // 'either': **OR**（どちらかが生きていれば沈まない）⟹ 両方沈んだ1件だけ。
    // ⚠ AND/OR を取り違えた集約（`NOT wall OR NOT seq`）はここで 3 を返して赤くなる。
    //   **これが段1の押し下げ（`vector-store.ts` の `decayFloorAnyAxis`）と段5の集約が
    //   同じ述語であることの検算そのものである。**
    await tenantSettingsStore.setDecayClock(ctx, "either");
    expect(await decayedCount()).toBe(1);

    // 鳴ってはいけない側: ゲートを外せば、どの時計でも 0 件。
    const ungated = await runtime.recall(ctx, {
      vector: [0, 0, 1],
      limit: 10,
      includeFullyDecayed: true,
    });
    expect(ungated.omitted.some((o) => o.kind === "filtered" && o.condition === "decayed")).toBe(
      false,
    );
  });
});
