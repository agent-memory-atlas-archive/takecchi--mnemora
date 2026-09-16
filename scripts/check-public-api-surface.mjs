#!/usr/bin/env node
/**
 * 公開 API（publish 対象パッケージの `.d.ts`）の破壊的変更を検出する歯（Issue #342 / ADR 0178）。
 *
 * **なぜこれが要るか**
 *
 * Issue #342: `@mnemora/core` の `Runtime.getRecall`（ADR 0161）と `@mnemora/testkit` の
 * `TenantSettingsStoreConformanceOptions.supportsDecayClock`（ADR 0165）が、どちらも
 * 破壊的変更（既存の自前実装がコンパイルできなくなる）でありながら、根拠 ADR に
 * 破壊性の記載が無いまま `main` に着地した。ADR 0156 は「公開 API の破壊的変更も、
 * ADR を書けば実装してよい」という委譲であり、**ADR に書くことを免除してはいない**。
 * ところが CI にはこれを検出する歯が無く、v1.0.0 リリース準備の人手の棚卸しで
 * 初めて見つかった。
 *
 * **この歯がすること・しないこと**
 *
 * - 各 publish 対象パッケージ（`./publish-targets.mjs` の `PUBLISH_TARGETS`）の
 *   ビルド後の公開型シグネチャ（`exports.*.types` から辿れる `.d.ts` だけ、コメント抜き）を
 *   `scripts/__snapshots__/public-api/<パッケージdir名>.d.ts` と突き合わせる。
 * - 一致しなければ非0で終わり、unified diff を出す。
 * - ⛔ **「変わった」ことだけを検出する。「壊れているか」（semver 的に安全かどうか）は
 *   判定しない**——それは意図的な設計である（ADR 0178「引き受けた負債」）。
 *   union のメンバー並び替えのような意味的に無変化の変更も赤くする。
 * - ⛔ **`bin` エントリ（`@mnemora/postgres` の `mnemora-postgres-migrate`）は対象外。**
 *   `exports.*.types` だけを起点にする（ADR 0178「決定」）。
 * - ⛔ **型として書かれていない破壊（実行時の意味変更）は一切拾わない。**
 *
 * **`--write`**: snapshot を実際の内容で上書きする（`format`/`format:check` と同じ対）。
 * これを打つ前に、**差分が破壊的変更かどうかを判断し、根拠 ADR にその破壊性を明記すること**
 * ——この歯の狙いは「破壊性の申告を人間に強制する」ことであり、`--write` はその申告の後に
 * 打つものである。
 *
 * **既定（check モード）**: 差分があれば unified diff を出して exit 1。
 *
 * 対象パッケージのリストをここへ複製しない理由は `scripts/check-publish-pack.mjs` 冒頭と
 * 同じ（ADR 0066 が「2箇所に写しがある」問題を消した経緯そのもの）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISH_TARGETS } from "./publish-targets.mjs";
import { buildPublicApiSnapshotText } from "./public-api-surface-lib.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * `scripts/check-cjs-transpile-parse.mjs` の `CJS_PARSE_CHECK_PACKAGES_ROOT` と同じ理由・
 * 同じ形の差し替え口。CI の `build` ジョブで `pnpm run test`（root vitest）が走る「Test」段は
 * 「Build」段より**前**にあり、実物の `packages/<name>/dist` はまだ存在しないことがある
 * ——だから `scripts/__tests__/` はこの歯を実物の dist に対しては走らせない。この env var は
 * 歯自身のテスト（`scripts/__tests__/check-public-api-surface.test.mjs`）が、
 * `./publish-targets.mjs` の `PUBLISH_TARGETS`（パッケージ名・dir 名）はそのまま使いつつ、
 * 中身は一時ディレクトリのフィクスチャへ差し替えて CLI をエンドツーエンドで走らせるための口。
 * 通常の実行（開発者の手元・CI）では未設定のままでよい。
 */
const packagesRoot = process.env.MNEMORA_API_CHECK_PACKAGES_ROOT
  ? resolve(process.env.MNEMORA_API_CHECK_PACKAGES_ROOT)
  : join(repoRoot, "packages");

/** 上と同じ理由。snapshot の書き先も、テストでは作業ツリーの外へ差し替える。 */
const snapshotDir = process.env.MNEMORA_API_CHECK_SNAPSHOT_DIR
  ? resolve(process.env.MNEMORA_API_CHECK_SNAPSHOT_DIR)
  : join(repoRoot, "scripts", "__snapshots__", "public-api");

const BANNER = "─".repeat(72);

const write = process.argv.slice(2).includes("--write");

console.log(
  [
    "",
    BANNER,
    `公開 API 表面の門: 対象${PUBLISH_TARGETS.length}パッケージの .d.ts を snapshot と突き合わせます` +
      (write ? "（--write: snapshot を更新します）" : ""),
    "",
    "  対象:",
    ...PUBLISH_TARGETS.map((t) => `    - ${t.name} (${t.dir})`),
    BANNER,
    "",
  ].join("\n"),
);

/** @type {string[]} */
const violations = [];

for (const target of PUBLISH_TARGETS) {
  const packageDir = join(packagesRoot, basename(target.dir));
  const packageJsonPath = join(packageDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const snapshotName = `${basename(target.dir)}.d.ts`;
  const snapshotPath = join(snapshotDir, snapshotName);
  const snapshotRelForMessage = `scripts/__snapshots__/public-api/${snapshotName}`;

  let actual;
  try {
    actual = buildPublicApiSnapshotText(packageDir, packageJson);
  } catch (error) {
    violations.push(`[${target.name}] ${error.message}`);
    continue;
  }

  if (write) {
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(snapshotPath, actual, "utf8");
    console.log(`  [${target.name}] snapshot を書きました: ${snapshotRelForMessage}`);
    continue;
  }

  if (!existsSync(snapshotPath)) {
    violations.push(
      `[${target.name}] snapshot が存在しません: ${snapshotRelForMessage}\n` +
        `    新規パッケージか、まだ一度も snapshot を作っていません。中身を読んで破壊的変更が` +
        `無いことを確認してから、\`node scripts/check-public-api-surface.mjs --write\` で作成してください。`,
    );
    continue;
  }

  const expected = readFileSync(snapshotPath, "utf8");
  if (expected === actual) {
    console.log(`  [${target.name}] 差分なし`);
    continue;
  }

  const workDir = mkdtempSync(join(tmpdir(), "mnemora-api-check-"));
  try {
    const actualPath = join(workDir, "actual.d.ts");
    writeFileSync(actualPath, actual, "utf8");
    const diff = spawnSync(
      "diff",
      [
        "-u",
        "--label",
        snapshotRelForMessage,
        "--label",
        `${target.name} (実測)`,
        snapshotPath,
        actualPath,
      ],
      { encoding: "utf8" },
    );
    violations.push(
      `[${target.name}] 公開型シグネチャが snapshot と一致しません。\n\n` +
        `${diff.stdout}\n` +
        `    次にすること（Issue #342 / ADR 0178）:\n` +
        `    1. この差分が破壊的変更かどうかを判断する。\n` +
        `    2. 破壊的変更なら、根拠 ADR にその破壊性を明記する（ADR 0156 は ADR を書くことを免除していない）。\n` +
        `    3. ⚠ 先に \`pnpm run build\` で dist を作り直す——この歯は packages/<name>/dist の .d.ts を読むので、\n` +
        `       dist が古いと「他人が入れた変更が消えた」差分に見え、そのまま --write すると\n` +
        `       その変更を snapshot から消してしまう（歯を無効化する）。\n` +
        `    4. \`node scripts/check-public-api-surface.mjs --write\` で snapshot を更新し、コミットする。\n` +
        `    ⚠ この歯は「変わったこと」だけを見ている。「壊れているか」はここでは判定しない——判断は上の手順のとおり人が行う。`,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (write) {
  console.log(["", BANNER, "✔ snapshot を更新しました。", BANNER, ""].join("\n"));
  process.exit(0);
}

if (violations.length > 0) {
  console.log(
    [
      "",
      BANNER,
      `✗ 違反が ${violations.length} 件見つかりました`,
      "",
      ...violations,
      BANNER,
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(["", BANNER, "✔ 公開 API 表面の門を通りました。", BANNER, ""].join("\n"));
