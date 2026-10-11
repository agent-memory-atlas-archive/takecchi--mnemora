import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// `ObserveEventInput.extractData`・`ObserveDocumentInput.extractTitle` の TSDoc:
// 「既定は false（渡さない）。true のときだけ payload に印が保存される（false・省略のときは payload にこの欄自体が増えない）」。
// `false` を明示した入力も受け付け、省略と同じ形で保存されることを見る。

const ctx: Ctx = { tenantId: "tenant-extract-opt-in-false" };

function buildRuntime() {
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
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
        req.schema.parse({ memories: [{ content: "抽出結果", provenanceKind: "stated" }] }) as T,
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => new Date("2099-01-01T00:00:00.000Z") },
  });
  return { runtime, stores };
}

describe("observe の extractData・extractTitle は false を明示しても受け付け、省略と同じ payload になる", () => {
  it("event の extractData: false", async () => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.observe(ctx, {
      kind: "event",
      name: "signup",
      data: { plan: "pro" },
      extractData: false,
    });

    const observation = await stores.memoryStore.getObservation(ctx, result.observationId);
    expect(observation?.payload).not.toHaveProperty("extractData");
  });

  it("document の extractTitle: false", async () => {
    const { runtime, stores } = buildRuntime();

    const result = await runtime.observe(ctx, {
      kind: "document",
      title: "題",
      content: "本文",
      extractTitle: false,
    });

    const observation = await stores.memoryStore.getObservation(ctx, result.observationId);
    expect(observation?.payload).not.toHaveProperty("extractTitle");
  });
});
