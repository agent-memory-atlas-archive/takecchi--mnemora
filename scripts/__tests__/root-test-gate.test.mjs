import { describe, expect, it } from "vitest";
import { gateExitCode, summarizeStages } from "../root-test-gate.mjs";

/**
 * `scripts/root-test-gate.mjs` の歯（純関数のみ）。
 *
 * これはルートの `test` 門の `&&` 連結を塞いだ変更の芯である（Issue #453）。
 * 直す前は `vitest run && pnpm -r --if-present run test && node scripts/run-db-tests.mjs`
 * だったため、段1が落ちると段2・段3は**一度も起動されず**、「赤1件」としか
 * 見えなかった。
 *
 * ⛔ ここでは門そのもの（`scripts/run-root-test-gate.mjs`）を子プロセスとして
 * 起動しない——それは段2で `pnpm -r run test` を呼ぶため、歯の中から起動すると
 * 再帰してしまう。ここで測るのは、副作用の無い `summarizeStages` / `gateExitCode`
 * だけである。
 */

const allPassed = [
  { name: "vitest run", ran: true, exitCode: 0 },
  { name: "pnpm -r --if-present --no-bail run test", ran: true, exitCode: 0 },
  { name: "run-db-tests（ADR 0015）", ran: true, exitCode: 0 },
];

const allFailed = [
  { name: "vitest run", ran: true, exitCode: 1 },
  { name: "pnpm -r --if-present --no-bail run test", ran: true, exitCode: 1 },
  { name: "run-db-tests（ADR 0015）", ran: true, exitCode: 1 },
];

describe("gateExitCode", () => {
  it("全段成功なら終了コード0", () => {
    expect(gateExitCode(allPassed)).toBe(0);
  });

  it("1段だけ失敗していても終了コードは非ゼロ", () => {
    const results = [
      { name: "vitest run", ran: true, exitCode: 1 },
      { name: "pnpm -r --if-present --no-bail run test", ran: true, exitCode: 0 },
      { name: "run-db-tests（ADR 0015）", ran: true, exitCode: 0 },
    ];
    expect(gateExitCode(results)).not.toBe(0);
  });

  it("全段失敗なら終了コードは非ゼロ", () => {
    expect(gateExitCode(allFailed)).not.toBe(0);
  });

  it("段が1つでも未起動（ran: false）なら、他が全部成功していても終了コードは非ゼロ", () => {
    const results = [
      { name: "vitest run", ran: true, exitCode: 0 },
      { name: "pnpm -r --if-present --no-bail run test", ran: false, exitCode: null },
      { name: "run-db-tests（ADR 0015）", ran: true, exitCode: 0 },
    ];
    expect(gateExitCode(results)).not.toBe(0);
  });
});

describe("summarizeStages", () => {
  /**
   * ⭐ 芯。直す前の門は、段1が落ちると段2・段3を一度も起動しなかった。
   * 直した後の門はこの3段を必ず全部起動する——だから、**3段すべてが失敗していても**、
   * 要約には3段すべてが「走った」と出ること。これが出なければ、この Issue が
   * 直そうとしている性質（未起動の段が読み取れること）が測れていない。
   */
  it("全段が失敗していても、3段すべてが「走った」と要約に出る", () => {
    const summary = summarizeStages(allFailed);
    for (const stage of allFailed) {
      expect(summary).toContain(stage.name);
    }
    expect(summary).not.toContain("未起動");
    expect(summary).toContain("3/3 段が実際に走りました");
  });

  it("全段成功のときは、失敗した段・未起動の段の行が出ない", () => {
    const summary = summarizeStages(allPassed);
    expect(summary).toContain("3/3 段が実際に走りました");
    expect(summary).not.toContain("失敗した段");
    expect(summary).not.toContain("未起動の段");
    expect(summary).toContain("通過");
  });

  it("未起動の段があれば、要約はそれを「未起動」として名指しし、走った段と区別する", () => {
    const results = [
      { name: "vitest run", ran: true, exitCode: 1 },
      { name: "pnpm -r --if-present --no-bail run test", ran: false, exitCode: null },
      { name: "run-db-tests（ADR 0015）", ran: false, exitCode: null },
    ];
    const summary = summarizeStages(results);
    expect(summary).toContain("1/3 段が実際に走りました");
    expect(summary).toContain("未起動の段");
    expect(summary).toContain("pnpm -r --if-present --no-bail run test");
    expect(summary).toContain("run-db-tests（ADR 0015）");
  });
});
