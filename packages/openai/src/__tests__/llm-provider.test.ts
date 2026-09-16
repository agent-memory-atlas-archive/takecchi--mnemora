import { describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";
import type { Ctx } from "@mnemora/core";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * **正直に書く**: `client` は手書きの偽物であり、本物の OpenAI API を叩かない。
 * ここで検査しているのは (a) `completeStructured` が正しい `response_format` を
 * 組み立てて渡すこと、(b) 返ってきた JSON（`null` を含む strict モード形）を
 * core の zod スキーマへ戻す変換（`stripNulls`）が正しいこと、(c) 異常系で
 * 例外を投げること。「LLM が実際に良い抽出結果を返すか」はここでは検査できない
 * （live テスト参照）。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

const sampleSchema = z.object({
  content: z.string(),
  digest: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

describe("OpenAILLMProvider.complete", () => {
  it("最初の choice の content を返す", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "こんにちは" } }],
    });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { completions: undefined, chat: { completions: { create } } } as never,
    });
    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });
    expect(result).toEqual({ content: "こんにちは" });
  });

  it("choice が無ければ空文字を返す（例外にしない）", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [] });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });
    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });
    expect(result).toEqual({ content: "" });
  });
});

describe("OpenAILLMProvider.completeStructured", () => {
  it("response_format に翻訳済みの json_schema を渡す", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ content: "本文", digest: null, tags: null }) } },
      ],
    });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });

    await provider.completeStructured(ctx, {
      prompt: { messages: [{ role: "user", content: "hi" }] },
      schema: sampleSchema,
    });

    expect(create).toHaveBeenCalledTimes(1);
    const callArgs = create.mock.calls[0]![0];
    expect(callArgs.response_format.type).toBe("json_schema");
    expect(callArgs.response_format.json_schema.strict).toBe(true);
    expect(callArgs.response_format.json_schema.schema.required).toEqual(
      expect.arrayContaining(["content", "digest", "tags"]),
    );
  });

  it("OpenAI が null を返した optional フィールドを、core のスキーマでは省略として扱う", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ content: "本文", digest: null, tags: null }) } },
      ],
    });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });

    const result = await provider.completeStructured(ctx, {
      prompt: { messages: [{ role: "user", content: "hi" }] },
      schema: sampleSchema,
    });

    expect(result).toEqual({ content: "本文" });
    expect("digest" in result).toBe(false);
  });

  it("content が空文字/欠落なら例外を投げる", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "" } }] });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });

    // このテストの契約は「何らかの例外を投げること」だけであり、`kind` までは
    // 主張していない（テスト名が「例外を投げる」としか言っていない）。空応答が
    // `OpenAILLMProviderError(kind: "no_content")` になることは `refusal.test.ts`
    // が `error.kind`/`error.message` の両方で精密に検証している——ここで型を
    // 足すのは、その検証を弱い形で重複させ、内部表現に結合するだけになる
    // （Issue #168 の項目「.toThrow() に引数が無い4箇所」の判定: ここは対象外）。
    await expect(
      provider.completeStructured(ctx, {
        prompt: { messages: [{ role: "user", content: "hi" }] },
        schema: sampleSchema,
      }),
    ).rejects.toThrow();
  });

  it("返ってきた JSON がスキーマに適合しなければ例外を投げる（必須フィールド欠落）", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ digest: "要旨だけ" }) } }],
    });
    const provider = new OpenAILLMProvider({
      model: "gpt-test",
      client: { chat: { completions: { create } } } as never,
    });

    // テスト名が「スキーマに適合しなければ」と失敗理由を明示している——
    // `req.schema.parse(...)`（llm-provider.ts）が投げるのは zod の ZodError であり、
    // 別の理由（`no_content` 等）で失敗しても緑になってはいけない。
    await expect(
      provider.completeStructured(ctx, {
        prompt: { messages: [{ role: "user", content: "hi" }] },
        schema: sampleSchema,
      }),
    ).rejects.toThrow(ZodError);
  });
});
