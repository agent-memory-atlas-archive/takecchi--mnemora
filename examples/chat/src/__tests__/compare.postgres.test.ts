import { afterAll, describe, expect, it } from "vitest";
import { runComparison } from "../compare.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * PR 本文「量の比較」の核心——会話の長さを変えて経路A/経路Bの焼かれる量を実測する
 * `runComparison` を、本物の Postgres に対して検査する。
 *
 * **⚠ 同じ値を両辺で使う比較は変化を検出できない**（PR 本文の注意）——ここでは
 * `fillerPairsSequence` の各要素についてそれぞれ独立に `runMnemoraPath` を実行し、
 * 出力された `naiveChars`/`mnemoraChars` が要素ごとに違う値になっていることまで確認する
 * （同じ値を使い回すバグが混入すれば、この assertion で赤くなる）。
 */
describe("examples/chat: runComparison（本物の Postgres）", () => {
  it("会話が長いほど naive は伸び続け、mnemora は既定の limit で頭打ちになる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const rows = await runComparison(handle.runtime, {
        fillerPairsSequence: [0, 30],
        tenantPrefix: "example-compare-test",
        memoryStore: handle.memoryStore,
      });

      expect(rows).toHaveLength(2);
      const [short, long] = rows;
      expect(short).toBeDefined();
      expect(long).toBeDefined();

      // naive は会話が長くなった分だけ伸びる。
      expect(long!.naiveChars).toBeGreaterThan(short!.naiveChars);
      // 2つの計測値が同じ値になっていない（同じ値を使い回すバグへの歯止め）。
      expect(long!.naiveChars).not.toBe(short!.naiveChars);
      expect(long!.mnemoraChars).not.toBe(short!.mnemoraChars);

      // mnemora/naive の比は会話が長くなるほど下がる（naive は無限に伸び、mnemora は
      // 既定 limit(10) と index band の固定費でほぼ頭打ちになるため）。
      expect(long!.mnemoraShareOfNaiveChars).toBeLessThan(short!.mnemoraShareOfNaiveChars);
    } finally {
      await handle.close();
    }
  });

  it("要素ごとに独立のテナントを使う——長い会話を測った後で短い会話を測っても、前の記憶を引きずらない", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      // わざと「長い→短い」の順で並べる。もし実装がテナントを使い回すバグを持っていたら
      // （`tenantId` が `fillerPairs` に依存しない実装に退行したら）、短い会話（fillerPairs=3、
      // 使う externalId は長い会話（fillerPairs=20）の externalId の部分集合）を後から
      // observe() しても新規の Memory が1件も増えず、totalInScope が長い会話の値（21件）を
      // 引きずったまま返ってきてしまう。この歯は昇順の並びでは検出できない
      // （短い方を先に測ると、後続の長い会話が上書きで増える側にしか動かないため）。
      const rows = await runComparison(handle.runtime, {
        fillerPairsSequence: [20, 3],
        tenantPrefix: "example-compare-isolation-test",
        memoryStore: handle.memoryStore,
      });

      const [long, short] = rows;
      expect(long!.totalInScope).toBe(long!.fillerPairs + 1);
      expect(short!.totalInScope).toBe(short!.fillerPairs + 1);
    } finally {
      await handle.close();
    }
  });

  /**
   * ⭐ Issue #301 / ADR 0163: `runComparison` が各行で `reportMemoryUsage` を実際に
   * 呼び、`recall_usages` へ行を入れていることを本物の Postgres で検査する。
   *
   * **`recall.memories.length` は常に非0**（`fillerPairsSequence` に0を含めても
   * 冒頭の事実表明が必ず1件は返るため）なので、全行で `memoryUsageReported: true`
   * になるはずである。
   */
  it("各行で使用報告が実際に行われ、recall_usages に returnedCount と同じ件数の行が入る", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const rows = await runComparison(handle.runtime, {
        fillerPairsSequence: [0, 3, 10],
        tenantPrefix: "example-compare-usage-report-test",
        memoryStore: handle.memoryStore,
      });

      for (const row of rows) {
        expect(row.returnedCount).toBeGreaterThan(0);
        expect(row.memoryUsageReported).toBe(true);
      }

      const totalReturned = rows.reduce((sum, r) => sum + r.returnedCount, 0);
      const usageCount = await handle.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM recall_usages
         WHERE tenant_id LIKE 'example-compare-usage-report-test-%'`,
      );
      expect(Number(usageCount.rows[0]?.count ?? "0")).toBe(totalReturned);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
