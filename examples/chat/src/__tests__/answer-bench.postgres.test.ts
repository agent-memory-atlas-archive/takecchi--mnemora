import { afterAll, describe, expect, it } from "vitest";
import { createAnswerBenchRuntime, runAnswerCase } from "../answer-bench.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { buildAnswerJson } from "../answer-json.js";
import { formatAnswerTable, formatAnswerQualityBanner } from "../answer-format.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `answer` サブコマンドの配線検査（本物の Postgres、Issue #506）。
 *
 * 🔴 **これは配線の検査であって、回答品質の測定ではない。** provider は
 * `env: {}`（`OPENAI_API_KEY` 無し）で `deterministic` を強制する——
 * `DeterministicLLMProvider.complete()` は渡した最後のメッセージをそのままエコーする
 * だけであり、この検査で見ているのは「両経路が同じ形の `PromptSpec` を組み立て、
 * 同じ `complete()` を経由し、入力量・呼び出し回数を正しく数えられるか」であって、
 * 「どちらの回答が正しいか」ではない。
 */
describe("examples/chat: answer（本物の Postgres、配線検査）", () => {
  it("naive/mnemora の両方が同じ system 文・同じ質問文で complete() を呼び、入力量を測れる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createAnswerBenchRuntime(requireDatabaseUrl(), {});
    try {
      expect(handle.llmMode).toBe("deterministic");
      const answerCase = ANSWER_CASE_SET_DEV[0]!;
      const result = await runAnswerCase(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        answerCase,
        "answer-bench-test-wiring",
      );

      // system 文は両経路で完全に同一(§2.2 決定2)。
      expect(result.naive.promptSpec.system).toBe(result.mnemora.promptSpec.system);
      expect(result.naive.promptSpec.system).toBeDefined();

      // どちらも質問文をそのまま末尾に含む。
      expect(result.naive.promptSpec.messages[0]?.content).toContain(answerCase.question);
      expect(result.mnemora.promptSpec.messages[0]?.content).toContain(answerCase.question);

      // 入力量は正の値で、両経路が独立に測られている(0で埋めていない)。
      expect(result.naive.inputChars).toBeGreaterThan(0);
      expect(result.mnemora.inputChars).toBeGreaterThan(0);
      expect(result.naive.inputEstimatedTokens).toBeGreaterThan(0);
      expect(result.mnemora.inputEstimatedTokens).toBeGreaterThan(0);

      // deterministic の complete() は最後のメッセージをそのままエコーするので、
      // 回答には自分自身が渡した user メッセージの内容が含まれる。
      expect(result.naive.answer).toBe(result.naive.promptSpec.messages[0]?.content);
      expect(result.mnemora.answer).toBe(result.mnemora.promptSpec.messages[0]?.content);

      // 追加費用: ingest は抽出(completeStructured)を最低1回発生させ、embed も最低1回発生する。
      // 回答生成(complete())は naive 1回 + mnemora 1回 = 2回で固定。
      expect(result.cost.extractionLLMCalls).toBeGreaterThanOrEqual(1);
      expect(result.cost.embeddingCalls).toBeGreaterThanOrEqual(1);
      expect(result.cost.answerLLMCalls).toBe(2);
    } finally {
      await handle.close();
    }
  });

  it("ケースごとに独立のテナントを使う——前のケースの記憶を引きずらない", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createAnswerBenchRuntime(requireDatabaseUrl(), {});
    try {
      const [first, second] = ANSWER_CASE_SET_DEV;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      const firstResult = await runAnswerCase(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        first!,
        "answer-bench-test-isolation",
      );
      const secondResult = await runAnswerCase(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        second!,
        "answer-bench-test-isolation",
      );
      // 別ケース・別テナントなので、mnemora 側の入力（記憶の列）は互いに独立——
      // 2件目に1件目の会話が紛れ込んでいないことを、質問文以外の部分に相手の
      // 会話文が含まれていないことで確認する。
      expect(secondResult.mnemora.promptSpec.messages[0]?.content).not.toContain(
        first!.conversation[0]!.text,
      );
      expect(firstResult.mnemora.promptSpec.messages[0]?.content).not.toContain(
        second!.conversation[0]!.text,
      );
    } finally {
      await handle.close();
    }
  });

  it("🔴 deterministic では qualityClaimable=false になり、集計(summary)が出ない・表が `—` になる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createAnswerBenchRuntime(requireDatabaseUrl(), {});
    try {
      const answerCase = ANSWER_CASE_SET_DEV[0]!;
      const result = await runAnswerCase(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        answerCase,
        "answer-bench-test-quality-gate",
      );

      const json = buildAnswerJson({
        results: [result],
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        measuredAt: new Date("2026-09-17T00:00:00.000Z"),
        commit: null,
      });
      expect(json.qualityClaimable).toBe(false);
      expect(json.summary).toBeUndefined();

      const table = formatAnswerTable([result], handle.llmMode);
      expect(table).not.toMatch(/✅|❌|❓/);
      expect(table).toContain("—");

      const banner = formatAnswerQualityBanner(handle.llmMode);
      expect(banner).toContain("回答品質は測っていない");
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
