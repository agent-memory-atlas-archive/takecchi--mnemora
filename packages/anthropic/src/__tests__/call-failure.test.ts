import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Ctx } from "@mnemora/core";
import { AnthropicLLMProviderError } from "../errors.js";
import { AnthropicLLMProvider } from "../llm-provider.js";

/**
 * **`LLMProvider` の interface が逐語で約束していて、一度も測られていなかった1行の歯**
 * （Issue #389 / ADR 0198）。`packages/core/src/interfaces/llm-provider.ts` の契約:
 *
 * > - タイムアウト・レート制限・失敗時は例外を投げる。`LLMProvider` 自体はリトライを
 * >   内蔵しない（責務の混在を避ける）。
 *
 * 🔴 **既存の歯が測っていたのは「応答が返った後の異常」だけだった**——JSON 構文エラー・
 * `ZodError`・`no_content`・`refusal`・`truncated`。**SDK の呼び出し自体が reject する側は
 * 1本も無かった**（【実測】Issue #389 へのコメント: この2パッケージのテストに
 * `mockRejected` が0件）。⟹ **ここがその側である。**
 *
 * ⛔ **`packages/testkit` に適合 suite を作っていない。**それを作るかどうか・契約を
 * どの粒度で切るかは Issue #389 の未決の設計判断であり、この歯はそこへ踏み込まない
 * （ADR 0198「採らなかった案」）。⟹ **`@mnemora/openai` 側にも同じ形の歯を置いてある**
 * （`packages/openai/src/__tests__/call-failure.test.ts`）。**片方だけ直さないこと。**
 *
 * ⚠ **測っているのは「この wrapper がリトライしないこと」であって、「production の
 * 経路がリトライしないこと」ではない。** `client` を注入しているため、`new Anthropic()`
 * が既定で持つ SDK 内部のリトライはここを通らない（ADR 0198「確かめていないこと」）。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

const sampleSchema = z.object({ content: z.string() });

const prompt = { messages: [{ role: "user" as const, content: "hi" }] };

function providerWithRejecting(error: unknown) {
  const create = vi.fn().mockRejectedValue(error);
  const provider = new AnthropicLLMProvider({
    model: "claude-test",
    client: { messages: { create } } as never,
  });
  return { create, provider };
}

/** レート制限・タイムアウトを模した例外。⚠ **SDK の本物のエラークラスではない**
 * （ADR 0198「確かめていないこと」）——この wrapper は例外の種類で分岐していないので、
 * 種類を変えても同じ道を通る、という主張をここで固定している。 */
class FakeRateLimitError extends Error {
  readonly status = 429;
  constructor() {
    super("429 rate_limit_error");
    this.name = "RateLimitError";
  }
}
class FakeTimeoutError extends Error {
  constructor() {
    super("Request timed out.");
    this.name = "APIConnectionTimeoutError";
  }
}

describe("AnthropicLLMProvider — 呼び出し自体が失敗したとき（core の interface の契約）", () => {
  it("complete: SDK の呼び出しが reject したら、その例外をそのまま伝播し、リトライしない", async () => {
    const sentinel = new Error("boom");
    const { create, provider } = providerWithRejecting(sentinel);

    // 🔴 **同一性で見る。**`toThrow(/boom/)` だと、wrapper が別の Error へ包み直しても
    // メッセージさえ同じなら通ってしまう。
    await expect(provider.complete(ctx, prompt)).rejects.toBe(sentinel);
    // ⛔ 「無い」の種類を潰さない——転送の失敗を `no_content` へ化けさせないこと。
    await expect(
      providerWithRejecting(sentinel).provider.complete(ctx, prompt),
    ).rejects.not.toBeInstanceOf(AnthropicLLMProviderError);

    // ⭐ **リトライを内蔵しない。**ちょうど1回。
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("completeStructured: SDK の呼び出しが reject したら、その例外をそのまま伝播し、リトライしない", async () => {
    const sentinel = new Error("boom");
    const { create, provider } = providerWithRejecting(sentinel);

    await expect(provider.completeStructured(ctx, { prompt, schema: sampleSchema })).rejects.toBe(
      sentinel,
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("レート制限・タイムアウトを模した例外でも、種類を問わず同じように伝播する", async () => {
    for (const error of [new FakeRateLimitError(), new FakeTimeoutError()]) {
      const forComplete = providerWithRejecting(error);
      await expect(forComplete.provider.complete(ctx, prompt)).rejects.toBe(error);
      expect(forComplete.create).toHaveBeenCalledTimes(1);

      const forStructured = providerWithRejecting(error);
      await expect(
        forStructured.provider.completeStructured(ctx, { prompt, schema: sampleSchema }),
      ).rejects.toBe(error);
      expect(forStructured.create).toHaveBeenCalledTimes(1);
    }
  });

  it("⭐ 陰性対照: 成功する呼び出しでも create はちょうど1回（回数の主張が空回りしていないこと）", async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const provider = new AnthropicLLMProvider({
      model: "claude-test",
      client: { messages: { create } } as never,
    });

    await expect(provider.complete(ctx, prompt)).resolves.toEqual({ content: "ok" });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
