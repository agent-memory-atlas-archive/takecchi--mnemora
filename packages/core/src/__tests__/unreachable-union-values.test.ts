import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Issue #206 / [ADR 0117](../../../../docs/decisions/0117-unreachable-union-values-inventory.md):
 * **型（union）には値が在るのに、それを生成するコードがリポジトリに1行も無い**値の棚卸し。
 *
 * このテストは、その棚卸しを「一度 grep して終わり」にせず、**回帰を機械的に捕まえる歯**に
 * している。棚卸しの対象は、書く側の実際のコード（`condition: "tenant"` のような
 * オブジェクトリテラルの構築）であって、`interface`/`z.enum([...])` の宣言そのものではない
 * ——後者は「値が union に在る」ことの出所であり、監視したいのは「値が**生成される**」こと
 * だからである。
 *
 * **⚠ この歯の限界（確かめていないこと）**:
 * - **静的な文字列一致でしか見ていない。** `condition: someVariable` のように、変数経由で
 *   これらの値が間接的に生成される経路までは検出できない。
 * - **対象は「本番として出荷されるパッケージの `src/`」に絞ってある**
 *   （下の `PACKAGES_TO_SCAN`）。`packages/testkit/src` は意図的に対象外——
 *   あのパッケージの仕事は adapter の適合テストであり、DB 制約を検査するために
 *   本番では起きない値をわざと組み立てることがある（例:
 *   `event-store-conformance.ts` が `kind: "events_purged"` を作ってその FK 制約を検査する）。
 *   それを「生成された」と数えると、この歯が本来捕まえたい回帰と見分けが付かなくなる。
 * - 各パッケージの `__tests__/` と `__fixtures__/` も同じ理由で対象外。
 *
 * **歯が実際に噛むことの変異試験**: `packages/core/src/recall-runtime.ts` に
 * `condition: "tenant"` 等のオブジェクトリテラルを一時的に挿入し、このテストが赤くなる
 * ことを手元で確認した（挿入前後で `git diff` が無いことも確認済み。PR 本文の
 * 「測ったこと」節に出力を貼ってある）。
 */

const PACKAGES_ROOT = join(__dirname, "../../../");
const PACKAGES_TO_SCAN = [
  "core/src",
  "postgres/src",
  "openai/src",
  "local-embedding/src",
  "anthropic/src",
];
const EXCLUDE_DIR_NAMES = new Set(["__tests__", "__fixtures__", "node_modules", "dist"]);

/**
 * 棚卸し対象の値。`file`/`declarationLine` は「型がどこで宣言されているか」の記録であり、
 * このテストの合否には関わらない（人が確認するための道しるべ）。
 */
const UNREACHABLE_VALUES: {
  field: string;
  value: string;
  declaredAt: string;
  classification:
    "1: 意図的に発火しない" | "2: 後続 Phase 待ち" | "3: 設計が消えた（オーナー判断待ち）";
}[] = [
  {
    field: "retrievedVia",
    value: "tag_match",
    declaredAt: "packages/core/src/recall.ts (RecalledMemory)",
    classification: "3: 設計が消えた（オーナー判断待ち）",
  },
  {
    field: "retrievedVia",
    value: "recency",
    declaredAt: "packages/core/src/recall.ts (RecalledMemory)",
    classification: "3: 設計が消えた（オーナー判断待ち）",
  },
  {
    field: "reason",
    value: "budget_exhausted",
    declaredAt: "packages/core/src/recall.ts (StageSkippedOmission)",
    classification: "3: 設計が消えた（オーナー判断待ち）",
  },
  {
    field: "axis",
    value: "time_window",
    declaredAt: "packages/core/src/recall.ts (GroupCount)",
    classification: "3: 設計が消えた（オーナー判断待ち）",
  },
  {
    field: "condition",
    value: "tenant",
    declaredAt: "packages/core/src/recall.ts (FilteredOmission)",
    classification: "1: 意図的に発火しない",
  },
  {
    field: "condition",
    value: "taxonomy",
    declaredAt: "packages/core/src/recall.ts (FilteredOmission)",
    classification: "2: 後続 Phase 待ち",
  },
  {
    field: "axis",
    value: "taxonomy",
    declaredAt: "packages/core/src/recall.ts (GroupCount)",
    classification: "2: 後続 Phase 待ち",
  },
  {
    field: "kind",
    value: "purged",
    declaredAt: "packages/core/src/event.ts (MemoryEventKind)",
    classification: "2: 後続 Phase 待ち",
  },
  {
    field: "kind",
    value: "events_purged",
    declaredAt: "packages/core/src/event.ts (MemoryEventKind)",
    classification: "2: 後続 Phase 待ち",
  },
];

function listTsFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listTsFiles(full, files);
    } else if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * `field: "value"` の形の**オブジェクトリテラル構築**だけを拾う。union 型宣言
 * （`field: "value" | "other"`）は、値の直後が `|`（前後の空白を許す）で続くため除外する
 * ——union の最初の選択肢がたまたま対象の値と一致するケースがあるため必要
 * （実例: `condition: "tenant" | "superseded" | …` は `condition: "tenant"` を部分文字列に含む）。
 * また `*`/`//` から始まる行（JSDoc コメント・行コメント）はコード例の引用を誤検出しない
 * ため読み飛ばす。
 */
function findLiteralConstructions(
  field: string,
  value: string,
): { file: string; lineNo: number; line: string }[] {
  const pattern = new RegExp(`\\b${field}\\s*:\\s*["']${value}["'](?!\\s*\\|)`);
  const hits: { file: string; lineNo: number; line: string }[] = [];
  for (const pkg of PACKAGES_TO_SCAN) {
    const dir = join(PACKAGES_ROOT, pkg);
    for (const file of listTsFiles(dir)) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        if (pattern.test(line)) {
          hits.push({ file: relative(PACKAGES_ROOT, file), lineNo: i + 1, line: trimmed });
        }
      });
    }
  }
  return hits;
}

describe("Issue #206 / ADR 0117: 型に在って一度も生成されない union の値", () => {
  for (const { field, value, declaredAt, classification } of UNREACHABLE_VALUES) {
    it(`${field}: "${value}"（${declaredAt}、分類${classification}）は、出荷対象パッケージの本番コードから生成されない`, () => {
      const hits = findLiteralConstructions(field, value);
      expect(hits).toEqual([]);
    });
  }
});
