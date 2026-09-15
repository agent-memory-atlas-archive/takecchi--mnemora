import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PROBES, buildProbeSetConversation, findTopicKeywordViolations } from "../probe-set.js";
import { armHeadline, resolveExternalId, runRetrievalQualityArm } from "../retrieval-quality.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { formatNoApiCallsNotice } from "../usage-meter.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * retrieval-quality の「仕組み」だけを、擬似 provider(arm A 相当)だけで検査する
 * (PR 本文 (F))。
 *
 * **⚠ 品質の数値(MRR が幾つ以上、goldRank が何位以内、等)は assert しない。**
 * `DeterministicEmbeddingProvider` は文字コードの合計から機械的にベクトルを作るだけで
 * 意味的な類似度を持たない(`packages/testkit` 自身のコメントの通り)。ここで固定して
 * しまうと、後で本物の embedding/LLM の数字が悪かったときにこの歯が「ずっと緑」のまま
 * 嘘をつく。検査するのは以下の3点——(1) gold の系譜が memory → observation まで
 * 実際に辿れること、(2) haystack が probe の話題語と機械的に重ならないこと、
 * (3) outbox が実際に干上がるまで処理され、既定の `tick()` 1回では処理しきれない
 * 件数だったこと(背景2)——という「仕組み」だけである。
 *
 * **⚠ 本物の API は叩かない**。`MNEMORA_LLM`/`MNEMORA_EMBEDDING` を明示的に
 * `"deterministic"` に固定して `createExampleRuntime` を呼ぶ——実行環境に
 * たまたま `OPENAI_API_KEY` が設定されていても、この歯は本物には倒れない。
 */
describe("examples/chat: retrieval-quality の仕組み(擬似 provider・本物の Postgres)", () => {
  it("resolveExternalId は observe() した externalId まで memory → observation を遡れる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    });
    try {
      expect(handle.llmMode).toBe("deterministic");
      expect(handle.embeddingMode).toBe("deterministic");

      const ctx: Ctx = { tenantId: "retrieval-quality-test-traceback" };
      const observed = await handle.runtime.observe(ctx, {
        kind: "utterance",
        text: "これは系譜を辿るための検査用の発話です。",
        externalId: "test-external-42",
      });
      expect(observed.memoryIds).toHaveLength(1);

      const externalId = await resolveExternalId(handle.memoryStore, ctx, observed.memoryIds[0]!);
      expect(externalId).toBe("test-external-42");

      // 存在しない memoryId では null を返す(黙って何かに読み替えない)。
      //
      // ⚠ ここで渡すのは「UUID として妥当だが存在しない」id である。当初は
      // "does-not-exist" という文字列を渡していたが、`PostgresMemoryStore.get` は
      // uuid 列への比較をそのまま投げるため `invalid input syntax for type uuid` で
      // 例外になり、この検査自体が落ちた。`resolveExternalId` 側で例外を握り潰す案は
      // 採らない——DB の異常を「辿れなかった」に読み替えると、系譜が壊れていることを
      // 見逃す。**辿れない(null)と、壊れている(例外)は別物である。**
      const missing = await resolveExternalId(
        handle.memoryStore,
        ctx,
        "00000000-0000-4000-8000-000000000000",
      );
      expect(missing).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it("buildProbeSetConversation の haystack は probe の話題語と機械的に重ならない", () => {
    const utterances = buildProbeSetConversation(30);
    const haystackTexts = utterances.filter((u) => u.kind === "haystack").map((u) => u.text);
    expect(haystackTexts).toHaveLength(30);
    expect(findTopicKeywordViolations(haystackTexts)).toEqual([]);

    // 1件ずつ内容が違う(同じ文が繰り返されると擬似 embedding が同一ベクトルになり、
    // 順位付けの試験にならないため)。
    expect(new Set(haystackTexts).size).toBe(haystackTexts.length);

    // gold は冒頭付近、haystack はその後ろ(externalId の並び順で確認する)。
    const goldIndices = utterances
      .map((u, i) => (u.kind === "gold" ? i : -1))
      .filter((i) => i >= 0);
    const firstHaystackIndex = utterances.findIndex((u) => u.kind === "haystack");
    for (const goldIndex of goldIndices) {
      expect(goldIndex).toBeLessThan(firstHaystackIndex);
    }
  });

  it(
    "runRetrievalQualityArm は outbox を干上がるまで処理し、既定の tick() 1回では " +
      "処理しきれない件数だったことを報告し、probe ごとの指標を計算する",
    async () => {
      await resetTestDatabase();
      await getTestClient();
      const handle = await createExampleRuntime(requireDatabaseUrl(), {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      });
      try {
        // haystackSize=55: 7 probe × (gold+distractor) の14件と合わせて69件。
        // `DeterministicLLMProvider` は1発話につき必ず1件の Memory を作るため、
        // embed ジョブも69件になる——`packages/core/src/runtime.ts` の
        // `DEFAULT_TICK_LIMIT`(50)を確実に超える件数にしてあり、既定の tick() を
        // 1回しか呼ばない実装(`mnemora-path.ts` の `ingestConversation`)だったら
        // 51件目以降が埋め込まれないまま残ることを、この歯自身が実際に踏んで示す。
        const haystackSize = 55;
        const report = await runRetrievalQualityArm({
          armLabel: "test-arm-a",
          tenantId: "retrieval-quality-test-arm-a",
          runtime: handle.runtime,
          memoryStore: handle.memoryStore,
          llmMode: handle.llmMode,
          embeddingMode: handle.embeddingMode,
          haystackSize,
        });

        const expectedObservationCount = PROBES.length * 2 + haystackSize;
        expect(report.ingest.observationCount).toBe(expectedObservationCount);

        // 干上がるまで処理し切っている(1件も pending のまま残っていない)。
        expect(report.ingest.drain.totalProcessed).toBe(expectedObservationCount);
        expect(report.ingest.drain.totalFailed).toBe(0);

        // 既定の tick() 1回(limit=50)では処理しきれない件数だった、という背景2の再現。
        expect(report.ingest.drain.firstTickProcessed).toBe(50);
        expect(report.ingest.drain.ticks).toBeGreaterThanOrEqual(2);
        expect(report.ingest.singleTickWouldHaveStalled).toBe(true);

        // probe ごとの指標が計算されている(仕組みの検査——値そのものは assert しない)。
        expect(report.probes).toHaveLength(PROBES.length);
        for (const probe of report.probes) {
          expect(Array.isArray(probe.omittedKinds)).toBe(true);
          // 全発話が1件ずつ Memory になり、期限切れ等のフィルタも無いので、
          // スコープ内総数は常に総 Observation 数と一致するはず(擬似 provider・
          // 埋め込み完了後の同一スコープなので数え方のブレは無い)。
          expect(probe.totalInScope).toBe(expectedObservationCount);
          // hit10 は goldRank が存在することと同値(既定 limit=10)。
          expect(probe.hit10).toBe(probe.goldRank !== null);
          expect(probe.reciprocalRank).toBe(probe.goldRank !== null ? 1 / probe.goldRank : 0);
        }

        // MRR は常に [0, 1] に収まる(何位に来たかという「値」そのものは assert しない)。
        for (const mrr of [report.mrrOverall, report.mrrLexicalControl, report.mrrNonLexical]) {
          expect(mrr).toBeGreaterThanOrEqual(0);
          expect(mrr).toBeLessThanOrEqual(1);
        }

        // 擬似 provider で走ったことが、レポートの文面からも明示されている
        // (0 を黙って出さない、という PR 本文 (A) の要求のテスト)。
        // ADR 0051 でモードを引数に取るようになったため、この arm の実際のモードを渡す。
        expect(report.usageReport).toBe(
          formatNoApiCallsNotice({
            llmMode: report.llmMode,
            embeddingMode: report.embeddingMode,
          }),
        );
      } finally {
        await handle.close();
      }
    },
  );

  /**
   * ⭐ 向きを反転させた歯(ADR 0108)。
   *
   * **他の歯はすべて「いま赤く、直ったら緑」だが、これは逆である**——
   * **「いま緑で、前提が黙って変わったら赤」**。測っているのは欠陥ではなく、
   * **このベンチの構成そのもの**: `runRetrievalQualityArm` は `recall()` に
   * `text` 以外を渡さない(このファイル冒頭のコメント「パラメータは既定のまま変えない」)
   * ——`channels` を渡していないので、`packages/core` の既定
   * `DEFAULT_RECALL_CHANNELS`(`["ann"]`)だけで recall しており、`examples/chat` の
   * `Runtime` には `LexicalStore` が配線されていない(`runtime-factory.ts` を grep すると
   * `lexicalStore`/`LexicalStore` の言及が0件)。
   *
   * ⟹ **返ってきた候補行に `score.lexicalMatch` 欄が1行も現れないはずである。**
   * この歯はそれを実際の DB・実際の `recall()` に対して測る(grep 的な静的検査ではなく、
   * 実際の挙動を測る歯を優先する、という指示に沿う)。
   */
  it(
    "🔴 [ADR 0108] 既定の channels(=ann のみ)では、返った候補のどの行にも " +
      "score.lexicalMatch 欄が現れない — 現れたらこの歯が赤くなる",
    async () => {
      await resetTestDatabase();
      await getTestClient();
      const handle = await createExampleRuntime(requireDatabaseUrl(), {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      });
      try {
        const report = await runRetrievalQualityArm({
          armLabel: "test-arm-adr-0108",
          tenantId: "retrieval-quality-test-arm-adr-0108",
          runtime: handle.runtime,
          memoryStore: handle.memoryStore,
          llmMode: handle.llmMode,
          embeddingMode: handle.embeddingMode,
          haystackSize: 20,
        });

        const totalRecalledRows = report.probes.reduce((sum, p) => sum + p.recalledRows, 0);
        const totalLexicalMatchRows = report.probes.reduce((sum, p) => sum + p.lexicalMatchRows, 0);

        // まず、この歯自体が何も測っていない(候補が1件も返らない)状態ではないことを
        // 確かめる——そうでなければ以下の assertion が「測れなかったから通っただけ」
        // になってしまう。
        expect(totalRecalledRows).toBeGreaterThan(0);

        expect(
          totalLexicalMatchRows,
          "この歯が赤いのは、欠陥が入ったからではない。" +
            "ベンチマークが語彙チャンネルを使う構成に変わった、という意味である" +
            "(examples/chat の Runtime に LexicalStore が配線された、または " +
            "runRetrievalQualityArm が recall() へ channels:['ann','lexical'] 等を" +
            "渡すようになった)。⟹ 意図した変更なら、この歯を更新したうえで " +
            "hit@1 を測り直すこと(それがこの歯の目的である。ADR 0108)。" +
            "⛔ 歯を消すだけにしないこと。",
        ).toBe(0);
      } finally {
        await handle.close();
      }
    },
  );

  /**
   * ⭐ [ADR 0148] 上の ADR 0108 の歯と対になる歯(Issue #179)。
   *
   * **上の歯が固定するのは「既定構成(`channels` を渡さない)では通らない」ことだけである。**
   * この歯はその裏——**`channels:["ann","lexical"]` を明示すれば、`examples/chat` の
   * `Runtime` に配線された `LexicalStore`(`runtime-factory.ts`、ADR 0148)を実際に通り、
   * `score.lexicalMatch` 欄が現れる**ことを固定する。2本合わせて、既定構成・語彙構成の
   * どちらも主張を持つ状態にする(ADR 0148 決定2)。
   *
   * **なぜ `runRetrievalQualityArm`(既存の日本語 probe 7件、`../probe-set.js`)を
   * 使わないか**: 測定B(ADR 0108)と Issue #179 のコメント(2026-09-13、takecchi)が
   * 実測・訂正した通り、postgres 実装はクエリ側の語をトークン化する前提が
   * **本文側のトークン境界**(日本語は文ごと1トークンになり、非ASCII 除去はその帰結
   * であって独立した原因ではない)にあり、日本語の自然文クエリは `channels` に
   * `"lexical"` を足しても段1で0件のままである——これは配線の欠陥ではない
   * (Issue #179「⟹ 原因は3つではなく2つ」表を参照)。
   *
   * ⟹ この歯は測定Bが実測した ASCII クエリ(`"TypeScript"`)と同種の入力を使い、
   * **配線が実際に効くこと**そのものを示す。probe 集合・日本語トークナイザの限界には
   * 触れない(ADR 0148「確かめていないこと」)。
   */
  it(
    "🟢 [ADR 0148] channels:['ann','lexical'] を明示すれば、ASCII クエリで " +
      "score.lexicalMatch 欄が現れる — examples/chat の Runtime に LexicalStore が" +
      "配線されていることを直接示す",
    async () => {
      await resetTestDatabase();
      await getTestClient();
      const handle = await createExampleRuntime(requireDatabaseUrl(), {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      });
      try {
        const ctx: Ctx = { tenantId: "retrieval-quality-test-lexical-channel" };
        await handle.runtime.observe(ctx, {
          kind: "utterance",
          text: "We are using TypeScript for this project's backend.",
          externalId: "lexical-channel-ascii-fact",
        });

        const result = await handle.runtime.recall(ctx, {
          text: "TypeScript",
          channels: ["ann", "lexical"],
        });

        // まず、この歯自体が何も測っていない(候補が1件も返らない)状態ではないことを
        // 確かめる(ADR 0108 の歯と同じ番人)。
        expect(result.memories.length).toBeGreaterThan(0);

        const lexicalMatchRows = result.memories.filter((m) => m.score.lexicalMatch !== undefined);
        expect(
          lexicalMatchRows.length,
          "この歯が赤いのは、examples/chat の Runtime から LexicalStore の配線が" +
            "外れた(runtime-factory.ts の createRuntime() に lexicalStore を渡さなく" +
            "なった)、または packages/core 側の語彙チャンネルの契約が壊れたことを意味する。" +
            "⟹ ADR 0148 の主張(配線されている)が崩れている。",
        ).toBeGreaterThan(0);
        // 被覆率は (0, 1] の値を取る(ADR 0092)——0 や負値ではない。
        for (const memory of lexicalMatchRows) {
          expect(memory.score.lexicalMatch).toBeGreaterThan(0);
          expect(memory.score.lexicalMatch).toBeLessThanOrEqual(1);
        }
      } finally {
        await handle.close();
      }
    },
  );

  /**
   * ⭐ [ADR 0148] `runRetrievalQualityArm` の `options.channels` が、実際に `recall()`
   * まで届いていることの間接的な証拠(Issue #179)。
   *
   * **なぜ直接 `score.lexicalMatch` の有無で確かめないか**: 上の歯が ASCII クエリで
   * 直接示した通り、`channels` が実際に `recall()` に渡っていることは既に確かめてある。
   * ここで確かめたいのは別のこと——`runRetrievalQualityArm` という**呼び出し口**が
   * `options.channels` を握り潰さずに転送しているかである。
   *
   * **手法**: `channels: ["lexical"]`(`"ann"` を含めない)を渡す。ANN チャンネルを
   * 落としたので、`../probe-set.js` の日本語 probe 7件は(測定B・Issue #179 の訂正が
   * 実測した通り、postgres 実装はトークン境界により日本語で段1が0件になる)**候補が
   * 1件も返らないはずである**。もし `options.channels` が `recall()` まで届いていない
   * (黙って既定 `["ann"]` のまま recall している)なら、ANN チャンネルは生きているので
   * 候補は普通に返ってしまう——**その場合はこの歯が失敗する。**
   */
  it(
    "🟢 [ADR 0148] runRetrievalQualityArm に channels:['lexical'](ann を含まない)を渡すと、" +
      "日本語 probe 7件はどれも候補0件になる — options.channels が recall() まで" +
      "実際に届いていることの証拠",
    async () => {
      await resetTestDatabase();
      await getTestClient();
      const handle = await createExampleRuntime(requireDatabaseUrl(), {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      });
      try {
        const report = await runRetrievalQualityArm({
          armLabel: "test-arm-adr-0148-lexical-only",
          tenantId: "retrieval-quality-test-arm-adr-0148-lexical-only",
          runtime: handle.runtime,
          memoryStore: handle.memoryStore,
          llmMode: handle.llmMode,
          embeddingMode: handle.embeddingMode,
          haystackSize: 20,
          channels: ["lexical"],
        });

        expect(report.channels).toEqual(["lexical"]);

        const totalRecalledRows = report.probes.reduce((sum, p) => sum + p.recalledRows, 0);
        expect(
          totalRecalledRows,
          "この歯が赤い(候補が返っている)のは、runRetrievalQualityArm が " +
            "options.channels を recall() へ渡さなくなった(既定 ['ann'] のまま走っている) " +
            "ことを意味する。⟹ ADR 0148 の配線の前提が崩れている——" +
            "'retrieval-quality.ts の recall() 呼び出しを確認すること。",
        ).toBe(0);
      } finally {
        await handle.close();
      }
    },
  );

  /**
   * ⭐ 向きを反転させた歯(ADR 0109)。ADR 0108 の歯と同じ形。
   *
   * **他の歯はすべて「いま赤く、直ったら緑」だが、これは逆である**——
   * **「いま緑で、前提が黙って変わったら赤」**。ADR 0081 が(捨てた計装で)一度だけ
   * 測った「`tagMatch`/`strength` は候補集合の上で1通りしか値を取らない
   * (順位に構造上ゼロ寄与している)」「`freshness` は `decay` の行ごと厳密な複製である」
   * という2つの実測を、恒久の歯として置き直す。
   *
   * **なぜ `tagMatch`/`strength` が1通りに固定されるか**(現状の構成に対する現物の理由):
   * - `runRetrievalQualityArm` は `recall()` に `text` 以外を渡さない
   *   (このファイル冒頭のコメント「パラメータは既定のまま変えない」)——`tags`/
   *   `subjectId` を渡していないので、`tagMatch` は候補間で差が付きようがない。
   * - `buildNewMemoryFromCandidate`(`packages/core/src/extraction.ts`)は無条件に
   *   `strength: 1` を書く——抽出が `strength` に1以外を書く経路が無い。
   *
   * **なぜ `decay`===`freshness` が行ごと厳密等価になるか**: `freshness` の起点は
   * `occurredAt ?? recordedAt`、`decay` の起点は `lastReinforcedAt ?? recordedAt`
   * (`packages/core/src/strategies/scoring.ts`)。このベンチは `observe()` に
   * `occurredAt` を渡さず、`memory_usage` の強化も起きない(`lastReinforcedAt` が
   * 埋まらない)ため、両方とも `recordedAt` 起点の同じ値になる。
   *
   * **⚠ `similarity`/`decay` の値そのもの・MRR・順位は assert しない**
   * (カセットや実行時刻に依存するため。ADR 0108 の歯と同じ規律)。
   */
  it(
    "🔴 [ADR 0109] tagMatch/strength はどの probe でも候補間で1通り(=1)、" +
      "decay===freshness は全行で厳密等価 — この前提が崩れたらこの歯が赤くなる",
    async () => {
      await resetTestDatabase();
      await getTestClient();
      const handle = await createExampleRuntime(requireDatabaseUrl(), {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      });
      try {
        const report = await runRetrievalQualityArm({
          armLabel: "test-arm-adr-0109",
          tenantId: "retrieval-quality-test-arm-adr-0109",
          runtime: handle.runtime,
          memoryStore: handle.memoryStore,
          llmMode: handle.llmMode,
          embeddingMode: handle.embeddingMode,
          haystackSize: 20,
        });

        const headline = armHeadline(report);

        const failureMeaning =
          "この歯が赤いのは欠陥が入ったからではない。ベンチの前提が変わったという" +
          "意味である——具体的には recall() に tags が渡されるようになった／" +
          "Memory.strength に 1 以外が書かれるようになった／occurredAt か " +
          "lastReinforcedAt が埋まるようになった(＝ decay と freshness の起点が" +
          "分かれた)。⟹ 意図した変更なら、この歯を更新したうえで順位を測り直すこと" +
          "(それがこの歯の目的である。ADR 0109)。⛔ 歯を消すだけにしないこと。";

        // まず、この歯自体が何も測っていない(候補が1件も返らない)状態ではないことを
        // 確かめる——そうでなければ以下の assertion が「測れなかったから通っただけ」
        // になってしまう(ADR 0108 の歯と同じ番人)。
        expect(headline.recalledRows, failureMeaning).toBeGreaterThan(0);

        for (const probe of report.probes) {
          const tagMatch = probe.termSpreads.find((s) => s.term === "tagMatch");
          expect(tagMatch, failureMeaning).toBeDefined();
          expect([tagMatch!.distinctCount, tagMatch!.min, tagMatch!.max], failureMeaning).toEqual([
            1, 1, 1,
          ]);

          const strength = probe.termSpreads.find((s) => s.term === "strength");
          expect(strength, failureMeaning).toBeDefined();
          expect([strength!.distinctCount, strength!.min, strength!.max], failureMeaning).toEqual([
            1, 1, 1,
          ]);
        }

        expect(headline.decayFreshnessDifferentRows, failureMeaning).toBe(0);
        expect(headline.decayFreshnessEqualRows, failureMeaning).toBe(headline.recalledRows);
      } finally {
        await handle.close();
      }
    },
  );
});

afterAll(async () => {
  await closeTestClient();
});
