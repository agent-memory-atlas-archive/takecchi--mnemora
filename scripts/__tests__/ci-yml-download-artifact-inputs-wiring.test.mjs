import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * ⭐ **この歯が測っているもの(消す前に読むこと)**
 *
 * [Issue #182](https://github.com/takecchi/mnemora/issues/182) 【実測】:
 * `.github/workflows/ci.yml` の `postgres-regime-coverage` ジョブが
 * `actions/download-artifact@v6` へ `if-no-artifact-found: warn` という
 * **v6 が宣言していない入力**を渡していた。GitHub Actions はこれを「有効な入力の
 * 一覧に無いキー」として**警告の注釈にするだけで、ジョブは `success` のまま**通す
 * ——⟹ **書いたつもりの指定が最初から一度も効いておらず、しかも赤くならないので
 * 誰も気づかない。**
 *
 * この歯は、その族(「`with:` に無効なキーを書いても黙って無視される」)が
 * **再発したら赤くなること**を保証する。`if-no-artifact-found` という**特定の1行**を
 * 禁止するのではなく、`actions/download-artifact@v6` を使う**すべての段**の
 * `with:` が、v6 が実際に宣言している入力の外へ出ていないことを検査する。
 *
 * ## v6 が宣言している入力の出所(⚠ ここが崩れたら歯全体が意味を失う)
 *
 * `ci.yml` は `actions/download-artifact@v6`(**タグ**、可変ではなく
 * `refs/tags/v6` が指す1つの commit)を使っている。2026-09-15 に
 * `gh api repos/actions/download-artifact/git/refs/tags/v6` で
 * `v6` タグが指す commit(`018cc2cf5baa6db3ef3c5f8a56943fffe632ef53`)を確認し、
 * `gh api repos/actions/download-artifact/contents/action.yml?ref=v6` で
 * その commit の `action.yml` の `inputs:` を読んだ結果が下の
 * `V6_VALID_INPUT_NAMES` である。
 *
 * ⚠ **`actions/download-artifact` の default branch(`main`)は、v6 タグより後に
 * `skip-decompress` / `digest-mismatch` の2入力を足している**(2026-09-15 時点の
 * `main` の `action.yml` で確認済み)。**しかし `ci.yml` が固定しているのは `v6` の
 * タグそのものであり、そのタグが指す commit は動かない**——⟹ この歯は
 * `main` 側の追加を含めない、**v6 タグ時点の8入力**をハードコードする。
 * `ci.yml` 側が別のタグ(`v7` 等)へ上げたら、この一覧も取り直すこと。
 *
 * このリポジトリはネットワークに出ないテストの流儀を取っている
 * (`ci-yml-postgres-regime-coverage-wiring.test.mjs` の docstring: 「YAML は
 * 構造として解析していない」「依存追加はオーナー専権」と同じ判断の系列)ので、
 * ここでも `action.yml` を実行時に取得せず、確認した時点の一覧をハードコードして
 * 出所とタイムスタンプをコメントに残す形を取る。
 *
 * この歯は:
 *
 * 1. `ci.yml` の中で `actions/download-artifact@v6` を使う段を**全部**見つける
 *    (1本の決め打ちのジョブに限らない——将来増えても拾う)。
 * 2. **対象が1件も無ければ空回りするので、下限を `toBeGreaterThanOrEqual` で
 *    固定する**(いま実際に1件ある。`ci-yml-local-embedding-cache-wiring.test.mjs`
 *    などと同じ流儀)。
 * 3. 見つけた段それぞれの `with:` のキーが、全部 `V6_VALID_INPUT_NAMES` に
 *    含まれること。
 * 4. **陰性対照**: `V6_VALID_INPUT_NAMES` に無い架空のキーを持つ段(この歯自身が
 *    合成する。ci.yml を書き換えない)では、この歯の検査関数が実際に検出すること
 *    ——検査そのものが「常に true を返すだけ」に退化していないことの根拠。
 *
 * ⚠ **YAML は構造として解析していない(文字列で見ている)。**既存の wiring
 * テストと同じ判断(依存追加はオーナー専権。`docs/autonomy.md`)。壊れたときは
 * 「配線が変わった」か「取り出し方が古い」かを見て、配線が変わっていないなら
 * 取り出し方を直すこと(歯を消さないこと)。
 *
 * ⛔ **`actions/upload-artifact` など他の action へは広げていない。**範囲を広げると
 * この歯が何を主張しているか読めなくなる(`docs/autonomy.md` §2「ついでに直さない」)。
 * 広げるならこの歯とは別の PR にすること。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

/**
 * `actions/download-artifact@v6`(タグ `v6` = commit `018cc2cf5baa6db3ef3c5f8a56943fffe632ef53`)
 * が実際に宣言している入力名。2026-09-15 に
 * `gh api repos/actions/download-artifact/contents/action.yml?ref=v6` で取得した
 * `action.yml` の `inputs:` の直下キーをそのまま書き写した(8個。順序は原文のまま)。
 *
 * @type {ReadonlySet<string>}
 */
const V6_VALID_INPUT_NAMES = new Set([
  "name",
  "artifact-ids",
  "path",
  "pattern",
  "merge-multiple",
  "github-token",
  "repository",
  "run-id",
]);

const { text: blanked, unhandled } = blankOutWorkflowComments(workflow);

/**
 * `ci.yml` 全体(コメント潰し済み)から、`actions/download-artifact@v6` を使う
 * 段のブロックを全部切り出す。
 *
 * ⛔ 対象の同定に `with:` の**値**を使わない——値こそが将来変異(壊れた再発)の
 * 対象であり、値で同定すると変異を当てた瞬間に段が「対象外」になって歯が
 * 空回りする(`ci-yml-postgres-regime-coverage-wiring.test.mjs` の
 * `extractDownloadStepBlock` の docstring と同じ理由)。
 *
 * @param {string} text コメント潰し済みの全文
 * @returns {string[]}
 */
function extractDownloadArtifactV6StepBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/uses:\s*actions\/download-artifact@v6\s*$/.test(lines[i])) {
      continue;
    }
    let start = i;
    while (start > 0 && !/^\s*- name:/.test(lines[start])) {
      start -= 1;
    }
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*- name:/.test(lines[j])) {
        end = j;
        break;
      }
    }
    blocks.push(lines.slice(start, end).join("\n"));
  }
  return blocks;
}

/**
 * 段のブロックから `with:` 直下のキー名だけを取り出す(`with:` が無ければ空配列
 * ——`download-artifact` は全入力が `required: false` なので `with:` を持たない
 * 段も文法上ありうる)。
 *
 * インデントは「`with:` 行の字下げ + 2」の行だけを子キーとして扱う
 * (`ci.yml` 全体を通して2空白刻みの GitHub Actions 標準の書式であることは
 * 既存の wiring テスト群が前提にしているのと同じ)。
 *
 * @param {string} stepBlock
 * @returns {string[]}
 */
function extractWithKeys(stepBlock) {
  const lines = stepBlock.split("\n");
  const withAt = lines.findIndex((line) => /^(\s*)with:\s*$/.test(line));
  if (withAt === -1) {
    return [];
  }
  const withIndent = /^(\s*)with:\s*$/.exec(lines[withAt])[1].length;
  const childIndent = withIndent + 2;
  const keys = [];
  for (let i = withAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      continue;
    }
    const currentIndent = /^(\s*)/.exec(line)[1].length;
    if (currentIndent < childIndent) {
      break;
    }
    if (currentIndent !== childIndent) {
      continue;
    }
    const match = /^\s*([A-Za-z0-9_-]+):/.exec(line);
    if (match !== null) {
      keys.push(match[1]);
    }
  }
  return keys;
}

describe("ci.yml の actions/download-artifact@v6 の with: が、v6 の有効な入力の外へ出ていない(Issue #182)", () => {
  it("🔴 コメント潰しが「扱えない」形に当たっていない(無視できないAPIにする)", () => {
    expect(unhandled).toEqual([]);
  });

  it("対象の段が1件以上ある(空回り防止——0件ならこの歯は何も検査していない)", () => {
    const blocks = extractDownloadArtifactV6StepBlocks(blanked);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it("見つかった段すべての with: が、v6 の有効な入力名だけで構成されている", () => {
    const blocks = extractDownloadArtifactV6StepBlocks(blanked);
    const offenders = [];
    for (const block of blocks) {
      const keys = extractWithKeys(block);
      for (const key of keys) {
        if (!V6_VALID_INPUT_NAMES.has(key)) {
          offenders.push({ key, block });
        }
      }
    }
    expect(
      offenders,
      offenders
        .map(
          (offender) =>
            `無効な入力 '${offender.key}' を渡している段:\n${offender.block}\n` +
            `⟹ actions/download-artifact@v6 はこのキーを宣言していない。GitHub は` +
            "警告の注釈を出すだけでジョブを success のまま通すため、赤くならずに" +
            "見過ごされる(Issue #182)。",
        )
        .join("\n\n"),
    ).toEqual([]);
  });

  it("🔴 陰性対照: 検査関数そのものが、無効なキーを実際に検出できる(常に true を返すだけに退化していない)", () => {
    // ⭐ ci.yml を書き換えず、この歯が使う検査関数へ合成した段を直接与える
    // ——「値が全部有効なので通った」のか「そもそも何も検査していないので
    // 通った」のかを区別するための陰性対照(Issue #155 系の歯が upload-artifact
    // 名の陰性対照でやっているのと同じ思想)。
    const syntheticOffendingBlock = [
      "      - name: 合成した段(この歯の検査そのものを確かめるためだけの架空の段)",
      "        uses: actions/download-artifact@v6",
      "        with:",
      "          pattern: lexical-regime-*",
      "          path: /tmp/somewhere",
      "          if-no-artifact-found: warn",
    ].join("\n");
    const keys = extractWithKeys(syntheticOffendingBlock);
    const offendingKeys = keys.filter((key) => !V6_VALID_INPUT_NAMES.has(key));
    expect(offendingKeys).toEqual(["if-no-artifact-found"]);

    const syntheticCleanBlock = syntheticOffendingBlock
      .split("\n")
      .filter((line) => !line.includes("if-no-artifact-found"))
      .join("\n");
    const cleanKeys = extractWithKeys(syntheticCleanBlock);
    expect(cleanKeys.every((key) => V6_VALID_INPUT_NAMES.has(key))).toBe(true);
  });

  it("extractDownloadArtifactV6StepBlocks が合成テキストからも段を正しく切り出す(取り出し方自体の確認)", () => {
    const synthetic = [
      "jobs:",
      "  synthetic-job:",
      "    steps:",
      "      - name: 何か関係ない段",
      "        run: echo hello",
      "",
      "      - name: 合成した download 段",
      "        uses: actions/download-artifact@v6",
      "        with:",
      "          name: something",
      "          bogus-input: oops",
      "",
      "      - name: 次の段(境界の確認)",
      "        run: echo done",
    ].join("\n");
    const blocks = extractDownloadArtifactV6StepBlocks(synthetic);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("合成した download 段");
    expect(blocks[0]).not.toContain("次の段");
    expect(extractWithKeys(blocks[0])).toEqual(["name", "bogus-input"]);
  });
});
