import type { Runtime } from "@mnemora/core";
import { describe, expect, it } from "vitest";
import type { CorrectionScenario } from "../correction-scenario.js";
import { CORRECTION_SCENARIO } from "../correction-scenario.js";
import {
  checkCorrectionDemo,
  formatCorrectionDemo,
  runCorrectionDemo,
} from "../correction-demo.js";

/**
 * `runCorrectionDemo`/`checkCorrectionDemo`/`formatCorrectionDemo` の歯（Issue #303）。
 * DB/LLM/embedding を実物で叩く代わりに、`Runtime` の必要な口だけを最小の偽物で埋める
 * （`consolidation-cost-abort.test.ts` と同じ規律）。
 *
 * **この歯が測っているもの**: `runCorrectionDemo` が `markContested`/`resolveContested` に
 * *どの id を*渡すか——具体的には、`scenario.contestedPair` の宣言（`firstExternalId`/
 * `secondExternalId`/`winnerExternalId`）が、`turns` の並び順や「後に observe したほうが
 * 勝つ」という順序規則を経由せず、**そのまま**呼び出しの引数に反映されることを実測する。
 *
 * **測っていないもの**: `markContested`/`resolveContested`/`recall` 自体の実装の正しさ
 * （それは `packages/core`/`packages/postgres` の領分であり、この歯の偽 Runtime は
 * 固定の戻り値を返すだけ）。実際の Postgres に対する一巡の実測は
 * `correction-demo.postgres.test.ts` で行う。
 */

interface FakeRuntimeCalls {
  observedExternalIds: string[];
  markContestedArgs: [string, string] | null;
  resolveContestedArgs: [string, string, unknown] | null;
  recallCallCount: number;
}

/**
 * externalId → memoryId は `<externalId>-memid` という機械的な対応にする——
 * `observe()` の戻り値からしか得られない、という `correction-demo.ts` の前提をそのまま
 * 反映しつつ、テスト側で「どの externalId の Memory か」を id から読めるようにする。
 */
function memoryIdFor(externalId: string): string {
  return `${externalId}-memid`;
}

function buildFakeRuntime(calls: FakeRuntimeCalls): Runtime {
  const observe: Runtime["observe"] = async (_ctx, input) => {
    const externalId = (input as { externalId: string }).externalId;
    calls.observedExternalIds.push(externalId);
    return {
      observationId: `obs-${externalId}`,
      memoryIds: [memoryIdFor(externalId)],
      extraction: "ok",
      extractionFailure: null,
    } as unknown as Awaited<ReturnType<Runtime["observe"]>>;
  };

  const tick: Runtime["tick"] = async () =>
    ({ processed: 0, failed: 0, unsupported: [] }) as unknown as Awaited<
      ReturnType<Runtime["tick"]>
    >;

  const recall: Runtime["recall"] = async () => {
    calls.recallCallCount += 1;
    const originalId = memoryIdFor(CORRECTION_SCENARIO.original.externalId);
    const correctionId = memoryIdFor(CORRECTION_SCENARIO.correction.externalId);
    if (calls.recallCallCount === 1) {
      // beforeMark: まだ対向が宣言されていないので、通常の recall と同じ形で両方出る。
      return {
        recallId: "recall-1",
        memories: [
          { memoryId: originalId, digest: "青", retrievedVia: "ann", companionOf: null },
          { memoryId: correctionId, digest: "赤", retrievedVia: "ann", companionOf: null },
        ],
        omitted: [],
        index: { groups: [], totalInScope: 2, countKind: "exact" },
        usage: {
          chars: 0,
          estimatedTokens: 0,
          counter: "heuristic",
          byTier: { full: 0, digest: 0, index: 0 },
          indexChars: 0,
        },
        explain: { stages: [] },
      } as unknown as Awaited<ReturnType<Runtime["recall"]>>;
    }
    if (calls.recallCallCount === 2) {
      // afterMark: 両方出て、敗者側(=勝者でないほう)が mandatory_companion として付く。
      const winnerId = memoryIdFor(CORRECTION_SCENARIO.contestedPair.winnerExternalId);
      const loserId = winnerId === originalId ? correctionId : originalId;
      return {
        recallId: "recall-2",
        memories: [
          {
            memoryId: winnerId,
            digest: winnerId === correctionId ? "赤" : "青",
            retrievedVia: "ann",
            companionOf: null,
          },
          {
            memoryId: loserId,
            digest: loserId === correctionId ? "赤" : "青",
            retrievedVia: "mandatory_companion",
            companionOf: winnerId,
          },
        ],
        omitted: [],
        index: { groups: [], totalInScope: 2, countKind: "exact" },
        usage: {
          chars: 0,
          estimatedTokens: 0,
          counter: "heuristic",
          byTier: { full: 0, digest: 0, index: 0 },
          indexChars: 0,
        },
        explain: { stages: [] },
      } as unknown as Awaited<ReturnType<Runtime["recall"]>>;
    }
    // afterResolve: 勝者だけが残る。
    const winnerId = memoryIdFor(CORRECTION_SCENARIO.contestedPair.winnerExternalId);
    return {
      recallId: "recall-3",
      memories: [
        {
          memoryId: winnerId,
          digest: winnerId === correctionId ? "赤" : "青",
          retrievedVia: "ann",
          companionOf: null,
        },
      ],
      omitted: [],
      index: { groups: [], totalInScope: 1, countKind: "exact" },
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      explain: { stages: [] },
    } as unknown as Awaited<ReturnType<Runtime["recall"]>>;
  };

  const markContested: Runtime["markContested"] = async (_ctx, firstId, secondId) => {
    calls.markContestedArgs = [String(firstId), String(secondId)];
    return {
      supported: true,
      outcome: { kind: "contested" },
    } as unknown as Awaited<ReturnType<Runtime["markContested"]>>;
  };

  const resolveContested: Runtime["resolveContested"] = async (
    _ctx,
    firstId,
    secondId,
    resolution,
  ) => {
    calls.resolveContestedArgs = [String(firstId), String(secondId), resolution];
    return {
      supported: true,
      outcome: { kind: "resolved" },
    } as unknown as Awaited<ReturnType<Runtime["resolveContested"]>>;
  };

  return { observe, tick, recall, markContested, resolveContested } as unknown as Runtime;
}

describe("runCorrectionDemo: markContested/resolveContested に渡す id は scenario.contestedPair の宣言どおり", () => {
  it("既定シナリオ: winnerExternalId=correction ⟹ resolveContested に correction の memoryId が winnerId として渡る", async () => {
    const calls: FakeRuntimeCalls = {
      observedExternalIds: [],
      markContestedArgs: null,
      resolveContestedArgs: null,
      recallCallCount: 0,
    };
    const runtime = buildFakeRuntime(calls);

    const result = await runCorrectionDemo(runtime, { tenantId: "t" }, CORRECTION_SCENARIO);

    const originalId = memoryIdFor(CORRECTION_SCENARIO.original.externalId);
    const correctionId = memoryIdFor(CORRECTION_SCENARIO.correction.externalId);

    // observe() は宣言順(original → correction)で呼ばれる。
    expect(calls.observedExternalIds).toEqual([
      CORRECTION_SCENARIO.original.externalId,
      CORRECTION_SCENARIO.correction.externalId,
    ]);

    // markContested は contestedPair.first/secondExternalId が指す2件で呼ばれる。
    expect(calls.markContestedArgs).toEqual([originalId, correctionId]);

    // 🔑 resolveContested の winnerId は contestedPair.winnerExternalId(=correction)が
    // 指す memoryId であり、これは「あとから observe した」からではなく宣言だからである
    // (下の「宣言を逆にすると勝敗も入れ替わる」の歯が、これを順序と切り分けて示す)。
    expect(calls.resolveContestedArgs?.[0]).toBe(originalId);
    expect(calls.resolveContestedArgs?.[1]).toBe(correctionId);
    expect(calls.resolveContestedArgs?.[2]).toEqual({ kind: "supersede", winnerId: correctionId });

    expect(result.originalId).toBe(originalId);
    expect(result.correctionId).toBe(correctionId);
  });

  it("宣言を逆にする(winnerExternalId=original)と、観測順は変えずとも勝者が入れ替わる — 順序規則ではないことの証明", async () => {
    const reversedScenario: CorrectionScenario = {
      ...CORRECTION_SCENARIO,
      contestedPair: {
        ...CORRECTION_SCENARIO.contestedPair,
        winnerExternalId: CORRECTION_SCENARIO.original.externalId,
      },
    };
    const calls: FakeRuntimeCalls = {
      observedExternalIds: [],
      markContestedArgs: null,
      resolveContestedArgs: null,
      recallCallCount: 0,
    };
    const runtime = buildFakeRuntime(calls);

    await runCorrectionDemo(runtime, { tenantId: "t" }, reversedScenario);

    const originalId = memoryIdFor(CORRECTION_SCENARIO.original.externalId);

    // observe() の呼び出し順は変わらない(original が先) — それでも winnerId は original。
    expect(calls.observedExternalIds[0]).toBe(CORRECTION_SCENARIO.original.externalId);
    expect(calls.resolveContestedArgs?.[2]).toEqual({ kind: "supersede", winnerId: originalId });
  });

  it("observe() が Memory を作らなかった(memoryIds が空)場合は例外を投げる", async () => {
    const runtime = {
      observe: async () =>
        ({ memoryIds: [] }) as unknown as Awaited<ReturnType<Runtime["observe"]>>,
      tick: async () =>
        ({ processed: 0, failed: 0, unsupported: [] }) as unknown as Awaited<
          ReturnType<Runtime["tick"]>
        >,
    } as unknown as Runtime;

    await expect(
      runCorrectionDemo(runtime, { tenantId: "t" }, CORRECTION_SCENARIO),
    ).rejects.toThrow(/Memory を作らなかった/);
  });
});

describe("checkCorrectionDemo / formatCorrectionDemo: 固定した RecallResult から性質を正しく読む", () => {
  it("北極星の核心: afterResolve に original が居なければ afterResolveOriginalAbsent=true", async () => {
    const calls: FakeRuntimeCalls = {
      observedExternalIds: [],
      markContestedArgs: null,
      resolveContestedArgs: null,
      recallCallCount: 0,
    };
    const runtime = buildFakeRuntime(calls);
    const result = await runCorrectionDemo(runtime, { tenantId: "t" }, CORRECTION_SCENARIO);
    const check = checkCorrectionDemo(result);

    expect(check.markSucceeded).toBe(true);
    expect(check.resolveSucceeded).toBe(true);
    expect(check.afterMarkBothPresent).toBe(true);
    expect(check.afterMarkCompanionRetrieval).toBe(true);
    expect(check.afterMarkCompanionOfWinner).toBe(true);
    expect(check.afterResolveOriginalAbsent).toBe(true);
    expect(check.afterResolveCorrectionPresent).toBe(true);

    const formatted = formatCorrectionDemo(result);
    expect(formatted).toContain("古いほうが消えた: はい");
    expect(formatted).toContain("新しいほうは残った: はい");
  });
});
