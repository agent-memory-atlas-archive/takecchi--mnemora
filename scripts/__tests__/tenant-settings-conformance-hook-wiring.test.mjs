import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findCallsMissingHook, findConformanceCalls } from "../conformance-hook-wiring-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`describeTenantSettingsStoreConformance(…)` を呼ぶ側が、`setDefaultHalfLifeHours`
 * フックを実際に渡していること。**
 *
 * `packages/testkit/src/tenant-settings-store-conformance.ts` は
 *
 * ```ts
 * if (setDefaultHalfLifeHours) {
 *   it("…", async () => { … });
 * }
 * ```
 *
 * という形で**2本の歯を条件付きで登録する**。⟹ 🔴 **フックを渡さない呼び出し側に
 * 対しては、この2本は `it.skip` にすらならず登録すらされない**
 * ——⟹ **テストの出力から「無い」ことが1ミリも分からない。**
 *
 * いま呼び出し側は2つあり、**どちらも渡している**（＝ Issue #184 の A ではない）。
 * ⟹ ⭐ **この歯はいま緑であり、前提が黙って変わったときに赤になる向きである。**
 * ⛔ 逆（いま赤くて直したら緑）にはしない。
 *
 * ## ⛔ なぜ型を必須にしないのか
 *
 * 本来は `memory-store-conformance.ts` の `supportsSupersedeWithNewMemories`
 * （**必須の `boolean`**。`false` なら `expect(store.supersedeWithNewMemories).toBeUndefined()`
 * を積極的に assert し、⛔ `it.skip` にはしない——`docs/autonomy.md`）と揃えて、
 * `setDefaultHalfLifeHours` も**必須のフラグ**にするのが正しい形である。
 *
 * ⛔ **しかし `@mnemora/testkit` は npm に公開済みである**（`private` は立っておらず、
 * `publishConfig.access` は `"public"`、registry の `dist-tags.latest` は `0.1.5`）。
 * ⟹ 必須化は**実在する公開パッケージへの破壊的変更**であり、**版を上げる判断は
 * オーナーの領域**である。
 *
 * ⟹ ⭐ **だから型は1バイトも変えず、この歯で代替した。次に版を上げる機会が来た人が、
 * そのとき必須化できる。**その時はこのファイルごと消してよい。
 *
 * ⚠ **ソースを文字列として走査している**（TypeScript の AST を組み立てていない）。
 * 既存の wiring 歯と同じ判断で、歯のために依存を足していない（依存追加はオーナー専権。
 * `docs/autonomy.md`）。**だからこの歯は書き方の変更に弱い。**壊れたときは
 * 「配線が変わった」のか「書き方が変わっただけ」なのかを見て、配線が変わっていない
 * なら取り出し方のほうを直すこと（**歯を消さないこと**）。
 */

const CONFORMANCE_FN = "describeTenantSettingsStoreConformance";
const REQUIRED_HOOK = "setDefaultHalfLifeHours";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** 走査から外すディレクトリ（ビルド成果物・依存）。 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

/**
 * `packages/` と `examples/` の下の TypeScript ソースを集める。
 *
 * @returns {string[]} リポジトリルートからの相対パス
 */
function collectSourceFiles() {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) {
        continue;
      }
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|mts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) {
        files.push(relative(repoRoot, full));
      }
    }
  };
  for (const top of ["packages", "examples"]) {
    walk(join(repoRoot, top));
  }
  return files;
}

const sourceFiles = collectSourceFiles();

/** 実際に `CONFORMANCE_FN` を呼んでいるファイル（相対パス）。 */
const callerFiles = sourceFiles.filter(
  (file) =>
    findConformanceCalls(readFileSync(join(repoRoot, file), "utf8"), CONFORMANCE_FN).length > 0,
);

describe(`${CONFORMANCE_FN} の呼び出し側が ${REQUIRED_HOOK} を渡していること（Issue #184 の追測）`, () => {
  it("🔴 走査が呼び出しを実際に見つけている（⛔ 空回りの検出点）", () => {
    // ⚠ 下の本番の主張は「挙がった集合が空」という形なので、**走査が壊れて
    // 1件も見つけなくなっても緑で通る。**⟹ ここで「見つけている」ことを先に固定する。
    // ⛔ 件数（`toBeGreaterThan(0)`）では書かない——集合の形で書く。
    expect(
      new Set(callerFiles),
      `${CONFORMANCE_FN}(…) の呼び出しをリポジトリ内に1つも見つけられなかった。` +
        "⟹ 適合テストの配線が消えたか、走査の取り出し方が古くなっている。" +
        "どちらにせよ、この下の歯は何も測っていない。",
    ).not.toEqual(new Set());
  });

  it("⭐ すべての呼び出しが setDefaultHalfLifeHours を渡している", () => {
    const offenders = callerFiles.flatMap((file) =>
      findCallsMissingHook(
        readFileSync(join(repoRoot, file), "utf8"),
        CONFORMANCE_FN,
        REQUIRED_HOOK,
      ).map((call) => ({ where: `${file}:${call.line}`, reason: call.reason })),
    );

    expect(
      new Set(offenders.map((o) => o.where)),
      "🔴 赤の意味: この呼び出しが " +
        `${REQUIRED_HOOK} を渡していない。渡さないと ` +
        "`packages/testkit/src/tenant-settings-store-conformance.ts` の " +
        "`if (setDefaultHalfLifeHours) { it(…) }` に入っている**2本の歯** " +
        "（`設定済みのテナントにはその値を返す` と " +
        "`⭐ half-life だけを設定した…テナントは unlimited`）が、" +
        "**`it.skip` にすらならず登録もされず、テストの出力から丸ごと消える** " +
        "——「通った」のか「そもそも走らなかった」のかが外から区別できなくなる。\n" +
        offenders.map((o) => `  ${o.where}: ${o.reason}`).join("\n"),
    ).toEqual(new Set());
  });

  it("🔴 陰性対照（空回り防止）: 現物の呼び出しから1つだけフックを剥がすと、その1つだけが挙がる", () => {
    // 「弾くものと弾いてはいけないものを同じ1回の走査に混ぜる」陰性対照。
    // ⛔ `toEqual(new Set())`（空=空）だけの歯は陰性対照として数えない——それは
    // 「歯が何も測っていない」場合と区別が付かない。⟹ 現物を材料に混合を作る。
    // ⛔ 件数では書かない（集合の一致で書く）。
    expect(
      new Set(callerFiles.slice(0, 2)),
      "現物の呼び出し側が2つ未満しか無いので、この混合の陰性対照は成立しない。",
    ).toHaveProperty("size", 2);

    const [target, untouched] = callerFiles;
    const strippedSource = readFileSync(join(repoRoot, target), "utf8").replace(
      new RegExp(`(^\\s*)${REQUIRED_HOOK}(\\s*:)`, "m"),
      "$1__hook_removed_by_this_tooth__$2",
    );

    const flagged = new Set([
      ...findCallsMissingHook(strippedSource, CONFORMANCE_FN, REQUIRED_HOOK).map(
        (call) => `${target}:${call.line}`,
      ),
      ...findCallsMissingHook(
        readFileSync(join(repoRoot, untouched), "utf8"),
        CONFORMANCE_FN,
        REQUIRED_HOOK,
      ).map((call) => `${untouched}:${call.line}`),
    ]);

    const targetLine = findConformanceCalls(
      readFileSync(join(repoRoot, target), "utf8"),
      CONFORMANCE_FN,
    )[0].line;

    // 🔴 剥がした側「だけ」が挙がること（＝ 剥がしていない側は挙がらないこと）。
    expect(flagged).toEqual(new Set([`${target}:${targetLine}`]));
  });
});
