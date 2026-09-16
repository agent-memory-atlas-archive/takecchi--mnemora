import { describe, expect, it, vi } from "vitest";
import type { Ctx, ObserveInput, ObserveResult, RecallResult, Runtime } from "@mnemora/core";
import { buildMnemoraPrompt, reportMemoryUsage } from "../mnemora-path.js";

function recallWith(memories: RecallResult["memories"]): RecallResult {
  return {
    recallId: "recall-1",
    memories,
    omitted: [],
    index: { groups: [], totalInScope: memories.length, countKind: "exact" },
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    explain: { stages: [] },
  };
}

describe("buildMnemoraPrompt", () => {
  it("memories が0件なら index の行だけになる（空の digest 行は filter で落ちる）", () => {
    const prompt = buildMnemoraPrompt(recallWith([]));
    // 空の digest 行を落とさずに join すると先頭に無駄な改行が付く。
    // ここでは「index の行そのものと完全に一致する」ことまで確認する。
    expect(prompt).toBe("(索引: スコープ内 0 件のうち 0 件を提示)");
  });

  it("memories がある場合は digest を箇条書きにし、index 行も出す", () => {
    const prompt = buildMnemoraPrompt(
      recallWith([
        {
          memoryId: "m1",
          digest: "テストの digest",
          retrievedVia: "ann",
          provenanceKind: "stated",
          score: { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 },
        },
      ]),
    );
    expect(prompt).toContain("- テストの digest");
    expect(prompt).toContain("1 件のうち 1 件");
  });
});

/**
 * `reportMemoryUsage`（Issue #301 / ADR 0163）——DB を一切使わず、`runtime.observe`
 * の呼び出し方だけを検査する配線の歯。本物の Postgres 上で `reinforce` が実際に
 * 発火することの検査は `__tests__/memory-usage-reinforce.postgres.test.ts` にある。
 */
describe("reportMemoryUsage", () => {
  function fakeRuntime(): { runtime: Runtime; observe: ReturnType<typeof vi.fn> } {
    const observe = vi.fn(async (): Promise<ObserveResult> => ({
      observationId: "obs-1",
      memoryIds: [],
      extraction: "skipped",
      extractionFailure: null,
    }));
    return { runtime: { observe } as unknown as Runtime, observe };
  }

  const ctx: Ctx = { tenantId: "t1" };

  it("memories が0件なら observe() を呼ばず、reported:false を返す", async () => {
    const { runtime, observe } = fakeRuntime();
    const result = await reportMemoryUsage(runtime, ctx, recallWith([]));
    expect(result).toEqual({ reported: false });
    expect(observe).not.toHaveBeenCalled();
  });

  it("memories が在れば、載せた memoryId 集合そのものを usedMemoryIds として observe() する", async () => {
    const { runtime, observe } = fakeRuntime();
    const memories: RecallResult["memories"] = [
      {
        memoryId: "m1",
        digest: "d1",
        retrievedVia: "ann",
        provenanceKind: "stated",
        score: { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 },
      },
      {
        memoryId: "m2",
        digest: "d2",
        retrievedVia: "ann",
        provenanceKind: "stated",
        score: { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 },
      },
    ];
    const recall = recallWith(memories);
    const result = await reportMemoryUsage(runtime, ctx, recall);

    expect(result).toEqual({ reported: true, recallId: "recall-1", usedMemoryIds: ["m1", "m2"] });
    expect(observe).toHaveBeenCalledTimes(1);
    const [calledCtx, calledInput] = observe.mock.calls[0] as [Ctx, ObserveInput];
    expect(calledCtx).toBe(ctx);
    expect(calledInput).toEqual({
      kind: "memory_usage",
      recallId: "recall-1",
      usedMemoryIds: ["m1", "m2"],
    });
  });
});
