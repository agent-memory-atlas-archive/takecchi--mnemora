import { afterAll, describe, expect, it } from "vitest";
import { checkBudgetDemo, runBudgetDemo, TINY_BUDGET_CHARS } from "../budget-demo.js";
import { ingestConversation } from "../mnemora-path.js";
import { buildConversation } from "../scenario.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `examples/chat/src/budget-demo.ts` の歯——「予算あり/なし」対比デモ
 * （`cli.ts` の `chat` サブコマンドがこれまでインラインで見せていたもの）が
 * 実際に成立していることを、本物の Postgres に対して検査する（Issue #306）。
 *
 * provider は `@mnemora/testkit` の決定的な擬似実装（`createExampleRuntime` に `env: {}` を
 * 渡し、`OPENAI_API_KEY` の有無に関わらず deterministic モードを強制する。
 * `scope.postgres.test.ts`/`backfill.postgres.test.ts` と同じ規約）。DB は擬似物で
 * 代替しない。
 *
 * **⚠ 何を検査していて、何を検査していないか:**
 *
 * - 検査している: Issue #306 の受け入れ条件1が名指しした3点——
 *   (a) 予算を変えると載る量が変わる（`withBudget.usage.byTier.digest <
 *   withoutBudget.usage.byTier.digest` かつ `budget_dropped` が出る。前提として
 *   budget 無しが空でないことも確認する）。
 *   (b) 予算未指定なら隠れた上限で切られない（`budget_dropped` が0件、かつ
 *   `explain.stages` の `budget_truncation` が `budgetApplied: false`）。
 *   (c) 切り詰め後の量が申告した予算の内側に収まる（`byTier.digest`（連想を含む
 *   memories tier 全体）が `TINY_BUDGET_CHARS` 以下、かつ `budgetExceeded` が
 *   構造的に `false`——docs/recall.md §6「`budgetExceeded`」節）。
 *
 * **⚠ 実測して分かったこと（本 PR）: `usage.chars`（memories tier + 目次帯）は
 * budget を締めても縮むとは限らない。** `docs/recall.md` §5 の被覆不変条件により、
 * budget が `memories` から押し出した Memory は目次帯（digest 帯）の対象になり、
 * 目次帯の実費が伸びる。`buildConversation(8)` を本物の Postgres に対して実測すると、
 * budget 無し `chars=346`(`byTier.digest=155`/`index=191`) → budget
 * `maxMemoryChars=60` で `chars=793`(`byTier.digest=40`/`index=753`)——**`chars` は
 * 増えたが `byTier.digest` は確実に減っている。** Issue #306 の本文は
 * `usage.chars` の比較を提案していたが、それは実データでは成り立たない
 * （`budget-demo.ts` の `checkBudgetDemo` の doc 参照）。この歯は構造的に保証される
 * `byTier.digest` を見る。
 * - 検査していない: このデモの会話は `association` を申告しない（`cli.ts` の `chat` の
 *   経路をそのまま再現しているため）ので、`byTier.association` がここに現れることは無い。
 *   連想枠が budget の内側に入っていることは `packages/core` 側の
 *   `recall-association.test.ts` と、本 PR が足した
 *   `recall-budget-channel-registry.test.ts` が別途検査する。
 */
describe("examples/chat: budget-demo（budget あり/なし対比、本物の Postgres、Issue #306）", () => {
  it("budget を渡すと、memories tier（byTier.digest）が実際に減り、budget_dropped が出る", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      expect(handle.mode).toBe("deterministic");
      const ctx = { tenantId: "example-chat-budget-demo-test-shrink" };
      const conversation = buildConversation(8);
      await ingestConversation(handle.runtime, ctx, conversation);

      const result = await runBudgetDemo(handle.runtime, ctx, conversation);
      const check = checkBudgetDemo(result);

      // 前提: budget 無しがそもそも空でないこと（空だと以下の判定が無意味な緑になる）。
      expect(check.withoutBudgetIsNonEmpty).toBe(true);

      expect(result.withBudget.usage.byTier.digest).toBeLessThan(
        result.withoutBudget.usage.byTier.digest,
      );
      expect(check.withBudgetIsSmaller).toBe(true);
      expect(check.withBudgetHasDroppedOmission).toBe(true);
      expect(result.withBudget.omitted.find((o) => o.kind === "budget_dropped")).toMatchObject({
        kind: "budget_dropped",
      });
    } finally {
      await handle.close();
    }
  });

  it("予算未指定なら、隠れた既定上限で切られない", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const ctx = { tenantId: "example-chat-budget-demo-test-no-hidden-cap" };
      const conversation = buildConversation(8);
      await ingestConversation(handle.runtime, ctx, conversation);

      const result = await runBudgetDemo(handle.runtime, ctx, conversation);
      const check = checkBudgetDemo(result);

      expect(check.withoutBudgetHasNoBudgetDropped).toBe(true);
      expect(check.withoutBudgetHasNoAppliedTruncation).toBe(true);

      // 名指しで確認: budget_truncation 自体は実行された段であり、
      // 「実行されていない」のではなく「適用しなかった」と名乗っていること。
      const trace = result.withoutBudget.explain.stages.find(
        (s) => s.stage === "budget_truncation",
      );
      expect(trace?.executed).toBe(true);
      expect(trace?.detail?.budgetApplied).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("budget あり: 切り詰め後の量（連想枠を含む memories tier 全体）が申告した予算の内側に収まる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const ctx = { tenantId: "example-chat-budget-demo-test-fits" };
      const conversation = buildConversation(8);
      await ingestConversation(handle.runtime, ctx, conversation);

      const result = await runBudgetDemo(handle.runtime, ctx, conversation);
      const check = checkBudgetDemo(result);

      expect(result.withBudget.usage.byTier.digest).toBeLessThanOrEqual(TINY_BUDGET_CHARS);
      expect(check.withBudgetFitsDeclaredCharBudget).toBe(true);
      // docs/recall.md §6: maxMemoryChars だけを申告した経路では budgetExceeded は
      // 構造的に常に false になる。この歯はその文書化された不変条件を検査する。
      expect(result.withBudget.usage.budgetExceeded).toBe(false);
      expect(check.withBudgetIsNotExceeded).toBe(true);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
