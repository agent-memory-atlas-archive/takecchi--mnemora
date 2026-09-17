import { afterAll, describe, expect, it } from "vitest";
import { fixedClock } from "@mnemora/core";
import { cassettePathFor, loadCassette } from "../cassette-io.js";
import { PROBES } from "../probe-set.js";
import { runRetrievalQualityArm } from "../retrieval-quality.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { closeTestClient, requireDatabaseUrl, resetTestDatabase } from "./test-db.js";

/**
 * 固定した品質回帰ケース(Issue #497、ADR 0227)。
 *
 * **既存の `retrieval-quality.postgres.test.ts`(擬似 provider)・`retrieval` サブコマンド
 * (実測用ベンチ、`scripts/retrieval-quality-summary.mjs` は exit 0 のまま)のどちらとも
 * 別の役割**——ここだけが「失敗したら `example-chat` ジョブを非成功にする」歯である。
 * `scripts/retrieval-quality-summary.mjs`・`retrieval-baseline.json`・
 * `compare-baseline.json`・`probe-set.ts` の既存 probe は一切変更していない
 * (ADR 0227「採らなかった案」)。
 *
 * **固定する3つ**: provider = `recorded`(カセット再生。ADR 0051。`deterministic` には
 * しない——意味的品質を測るという ADR 0088/ADR 0224 §2.2 の要求による)、
 * 時計 = `fixedClock`(下のコメント参照)、入力 = 既存の `probe-set.ts` の
 * `PROBES`/`buildProbeSetConversation`(seed 固定・ADR 0058 §1.4 で凍結済み。1件も
 * 足さない・変えない)。
 *
 * **守る振る舞い**: 各 probe について、probe 定義の時点で決まっている gold
 * (`probe.fact`)が `recall()` の返す既定候補(limit=10)に入っていること。
 * **gold/distractor の指定は `probe-set.ts` が probe を定義した時点の設計であり、
 * 順位付け実装の出力から作った正解ではない**(ADR 0224 §2.2 の1番)。
 *
 * **集計値(MRR・hit@1 の件数)には閾値を置かない**(ADR 0088 §2.1 / ADR 0033 §3 —
 * n=7 では順位が1つ動くだけで hit@1 が 4/7→3/7 になり、閾値は「本当の退行」と
 * 「n=7 の標本の薄さ」を区別できない)。**この歯は probe ごとの個別判定にしている**
 * ため、上の理由は当たらない——1 probe の goldRank の有無は他の6 probe の結果と
 * 無関係に決まり、「1つ動くと全体の分数が変わる」という閾値特有の脆さを持たない
 * (ADR 0227 参照)。
 *
 * **K を「既定の recall() limit(=10、`packages/core` の `DEFAULT_RECALL_LIMIT` 相当)」
 * にした理由**: 実測(下記)では 7 probe の goldRank は 1/1/2/6/1/1/2 で、全件が
 * 既定の limit=10 の内側に収まっていた。ここで「6」のような実測順位そのものを
 * 焼き込まない——ADR 0201 決定3が「固定した実測値を焼き込むと正当な変更で意味なく
 * 赤くなる」としているのと同じ理由で、正当な reranking の変更(例えば `diet` の
 * 順位が6位から8位へ動く)が製品として許容範囲でもこの歯を赤くしてしまう。
 * 「候補に入っているか」(=recall() 自身が既定で切る境界)だけを固定すれば、
 * 順位の変動そのものは検査の対象にせず、**情報が候補集合から丸ごと落ちたときだけ**
 * 赤くなる。
 *
 * ⚠ **`fixedClock` は実行時点より確実に未来の日付にすること。**
 * `packages/postgres/src/outbox-store.ts` の `claimBatch` は
 * `available_at <= opts.now`(`opts.now` は注入した `Clock.now()`)で embed ジョブを
 * 絞るが、`available_at` の既定値は `packages/postgres/src/memory-store.ts` の
 * `INSERT INTO outbox (...) VALUES (..., now(), ...)` —— **DB 自身の実時刻**である。
 * 固定時計を過去(例: 2026-01-01)にすると、`available_at`(実行時の実時刻)が
 * 常に `opts.now`(過去に固定した値)より後になり、`tick()` は `processed: 0` を
 * 返し続けて embed ジョブが一生 claim されない——**例外にならず、`recalledRows` が
 * 全 probe で静かに 0 になる**(実測で踏んだ。2026-01-01 を指定したところ
 * 7 probe すべて `goldRank=null` になった)。この歯自身が「候補が0件でないこと」を
 * 別途確認しないのは、まさにこの踏み間違いが起きれば全 probe が `goldRank=null` で
 * 落ちる(=歯自体が赤くなる)ため、無音の緑を作らないからである。
 */
describe(
  "examples/chat: retrieval の固定回帰ケース(recorded provider・固定時計・本物の Postgres。" +
    "Issue #497、ADR 0227)",
  () => {
    it("PROBES の全7件で、gold が recall() の既定候補(limit=10)に入っている", async () => {
      await resetTestDatabase();

      const cassette = loadCassette(cassettePathFor("retrieval"));

      // 実行時点(2026年台)より確実に未来の固定時刻。理由は上のファイル doc を参照。
      const clock = fixedClock(new Date("2030-01-01T00:00:00.000Z"));

      const handle = await createExampleRuntime(
        requireDatabaseUrl(),
        // **`OPENAI_API_KEY` の有無を見ない**——明示的に "recorded" を指定するので、
        // 実行環境にたまたまキーが在っても黙って実 API へは倒れない
        // (`selectLLMMode`/`selectEmbeddingMode` は `MNEMORA_LLM`/`MNEMORA_EMBEDDING`
        // を最優先で見るため。`providers.ts` 参照)。
        { MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" },
        { cassette },
        clock,
      );
      try {
        expect(handle.llmMode).toBe("recorded");
        expect(handle.embeddingMode).toBe("recorded");

        const report = await runRetrievalQualityArm({
          armLabel: "fixed-regression",
          tenantId: `retrieval-quality-regression-${Date.now()}`,
          runtime: handle.runtime,
          memoryStore: handle.memoryStore,
          llmMode: handle.llmMode,
          embeddingMode: handle.embeddingMode,
        });

        expect(report.probes).toHaveLength(PROBES.length);

        for (const probe of report.probes) {
          expect(
            probe.goldRank,
            `probe "${probe.probeId}" の gold が recall() の既定候補(limit=10)から落ちた` +
              `(goldRank=${probe.goldRank})。必要な記憶または情報が失われた可能性がある` +
              "——recall() のフィルタ・probe-set.ts の gold の内容・ingest の経路を確認すること。",
          ).not.toBeNull();
        }
      } finally {
        await handle.close();
      }
    });
  },
);

afterAll(async () => {
  await closeTestClient();
});
