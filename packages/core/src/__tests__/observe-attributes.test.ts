import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// `@mnemora/testkit` には依存しない（`packages/core` 自身のテストなので）。

const NOW = new Date("2099-01-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime(opts?: { llmFails?: boolean }) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: stores.lexicalStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
        if (opts?.llmFails) {
          throw new Error("simulated llm failure");
        }
        return req.schema.parse({
          memories: [{ content: "抽出結果", provenanceKind: "stated" }],
        }) as T;
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

describe("runtime.observe() — attributes が Memory まで素通しされる（Issue #152、ADR 0312）", () => {
  it("observe({ kind: 'utterance', attributes }) が Memory.attributes に到達する", async () => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "この情報は社内限定です",
      attributes: { visibility: "internal" },
    });

    expect(result.memoryIds.length).toBeGreaterThan(0);
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.attributes).toEqual({ visibility: "internal" });
  });

  it("attributes を渡さない observe() は Memory.attributes が {} になる（非破壊・runtime は常に {} 以上を書く）", async () => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "属性を渡さない発話",
    });

    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.attributes).toEqual({});
  });

  it("ObserveEventInput / ObserveDocumentInput でも同じ経路で伝わる", async () => {
    const { runtime, stores } = buildRuntime();

    const eventResult = await runtime.observe(ctx, {
      kind: "event",
      name: "signup",
      attributes: { source: "partner-x" },
    });
    const eventMemory = await stores.memoryStore.get(ctx, eventResult.memoryIds[0]!);
    expect(eventMemory?.attributes).toEqual({ source: "partner-x" });

    const documentResult = await runtime.observe(ctx, {
      kind: "document",
      content: "文書の中身",
      attributes: { classification: "confidential" },
    });
    const documentMemory = await stores.memoryStore.get(ctx, documentResult.memoryIds[0]!);
    expect(documentMemory?.attributes).toEqual({ classification: "confidential" });
  });

  it("LLM 呼び出しが失敗し全文フォールバックへ倒れた場合も attributes を継承する", async () => {
    const { runtime, stores } = buildRuntime({ llmFails: true });

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "フォールバック経路の発話",
      attributes: { visibility: "internal" },
    });

    expect(result.extraction).toBe("llm_failed_whole_observation");
    expect(result.memoryIds.length).toBeGreaterThan(0);
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.attributes).toEqual({ visibility: "internal" });
  });

  it("extract: 'deferred' でも Observation.attributes に残り、後続の抽出で Memory へ到達する", async () => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "deferred な発話",
      attributes: { visibility: "internal" },
      extract: "deferred",
    });

    expect(result.memoryIds).toEqual([]);
    const observation = await stores.memoryStore.getObservation(ctx, result.observationId);
    expect(observation?.attributes).toEqual({ visibility: "internal" });

    // outbox 経由の抽出（`processExtractJob` 相当）: deferred 経路は DB から読み直した
    // Observation だけを使って抽出する（`Observation.attributes` の doc コメント参照）。
    const tickResult = await runtime.tick(ctx, { leaseMs: 60_000, kinds: ["extract"] });
    expect(tickResult.processed).toBe(1);

    const memories = await stores.memoryStore.listBySourceObservation(
      ctx,
      result.observationId,
      "v1",
    );
    expect(memories.length).toBeGreaterThan(0);
    expect(memories[0]?.attributes).toEqual({ visibility: "internal" });
  });

  it("attributes のキー数・キー長・値長の上限を超えると parse() の時点で例外になる", async () => {
    const { runtime } = buildRuntime();

    const tooManyKeys: Record<string, string> = {};
    for (let i = 0; i < 17; i += 1) {
      tooManyKeys[`k${i}`] = "v";
    }
    await expect(
      runtime.observe(ctx, { kind: "utterance", text: "x", attributes: tooManyKeys }),
    ).rejects.toThrow();

    await expect(
      runtime.observe(ctx, {
        kind: "utterance",
        text: "x",
        attributes: { ["k".repeat(65)]: "v" },
      }),
    ).rejects.toThrow();

    await expect(
      runtime.observe(ctx, {
        kind: "utterance",
        text: "x",
        attributes: { k: "v".repeat(257) },
      }),
    ).rejects.toThrow();
  });

  // 上限は ADR 0312 の上限の表のとおり両端を含む（キー数は最大16、キー長は1〜64、値長は0〜256で空文字は許す）。
  it.each([
    [
      "キーが16個ちょうど",
      Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"])),
    ],
    ["キーが64文字ちょうど", { ["k".repeat(64)]: "v" }],
    ["値が256文字ちょうど", { k: "v".repeat(256) }],
    ["値が空文字", { k: "" }],
  ])("attributes の上限ちょうどは受け付け、Memory まで届く: %s", async (_label, attributes) => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.observe(ctx, { kind: "utterance", text: "x", attributes });

    expect(result.memoryIds.length).toBeGreaterThan(0);
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.attributes).toEqual(attributes);
  });
});
