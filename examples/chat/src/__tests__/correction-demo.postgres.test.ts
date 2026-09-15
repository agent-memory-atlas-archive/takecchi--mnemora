import { afterAll, describe, expect, it } from "vitest";
import { checkCorrectionDemo, runCorrectionDemo } from "../correction-demo.js";
import { CORRECTION_SCENARIO } from "../correction-scenario.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `examples/chat` から `Runtime.markContested`/`Runtime.resolveContested` を実際に呼び、
 * 本物の Postgres に対して「間違いを正すと、古いほうが先に出てこなくなる」（北極星 項目5）
 * を実測する歯（Issue #303 受け入れ条件2・3）。
 *
 * provider は `@mnemora/testkit` の決定的な擬似実装（`backfill.postgres.test.ts`/
 * `scope.postgres.test.ts` と同じ規約——`env: {}` を渡し `OPENAI_API_KEY` の有無に関わらず
 * deterministic モードを強制する）。DB は擬似物で代替しない。
 *
 * **⚠ この作業環境では実行できない**（`DATABASE_URL` が無い）。CI の `example-chat` ジョブが
 * 実測の場になる（`docs/autonomy.md`/ADR 0015 と同じ非対称）。
 */
describe("examples/chat: correction（markContested → resolveContested、本物の Postgres）", () => {
  it("markContested で対になった2件は recall で隣接して出て、resolveContested(supersede) 後は古いほうが消える", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      expect(handle.mode).toBe("deterministic");

      const result = await runCorrectionDemo(handle.runtime, {
        tenantId: "example-chat-correction-test",
      });
      const check = checkCorrectionDemo(result);

      // 前提: markContested/resolveContested がそもそも対応している(supported)こと。
      expect(result.markOutcomeKind).toBe("contested");
      expect(result.resolveOutcomeKind).toBe("resolved");
      expect(check.markSucceeded).toBe(true);
      expect(check.resolveSucceeded).toBe(true);

      // markContested 直後: 両方が隣接して出て、負けた側(まだ決まっていないが、この時点では
      // まだ勝敗は付いていない——両方 contested)は mandatory_companion として付く。
      expect(result.beforeMark.memories.length).toBeGreaterThan(0);
      expect(check.afterMarkBothPresent).toBe(true);
      expect(check.afterMarkCompanionRetrieval).toBe(true);
      expect(check.afterMarkCompanionOfWinner).toBe(true);

      // 🔑 北極星の核心: resolveContested(supersede) の後、古いほう(original)は
      // 二度と recall に出てこない。
      expect(check.afterResolveOriginalAbsent).toBe(true);
      expect(check.afterResolveCorrectionPresent).toBe(true);
      expect(result.afterResolve.memories.length).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it("宣言(contestedPair.winnerExternalId)を original 側にすると、original が生き残り correction が消える(順序規則ではないことの実測)", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const reversedScenario = {
        ...CORRECTION_SCENARIO,
        original: {
          ...CORRECTION_SCENARIO.original,
          externalId: "correction-demo-reversed-original",
        },
        correction: {
          ...CORRECTION_SCENARIO.correction,
          externalId: "correction-demo-reversed-correction",
        },
        contestedPair: {
          firstExternalId: "correction-demo-reversed-original",
          secondExternalId: "correction-demo-reversed-correction",
          // 宣言だけを逆にする——observe() の順序(original が先)は変えていない。
          winnerExternalId: "correction-demo-reversed-original",
        },
      };

      const result = await runCorrectionDemo(
        handle.runtime,
        { tenantId: "example-chat-correction-test-reversed" },
        reversedScenario,
      );

      // observe() の順序は変わらない(original が先に呼ばれる)。
      expect(result.originalId).toBeDefined();
      // それでも、宣言どおり original が生き残る。
      const finalIds = result.afterResolve.memories.map((m) => m.memoryId);
      expect(finalIds).toContain(result.originalId);
      expect(finalIds).not.toContain(result.correctionId);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
