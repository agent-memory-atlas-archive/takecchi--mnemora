/**
 * `scripts/check-publish-pack.mjs` が使う純粋な判定関数だけを集めたモジュール。
 *
 * **なぜ分けたか**: `check-publish-pack.mjs` は import された瞬間に本物の `pnpm pack` を
 * publish 対象ぶん走らせる（トップレベルの実行部にガードが無い）。判定関数だけをここへ
 * 切り出せば、`scripts/__tests__/check-publish-pack.test.mjs` は合成フィクスチャに対して
 * `pnpm pack` を一切走らせずに、各関数が実際に噛むか（違反を作ったら検出し、直したら
 * 検出しないか）を直接測れる。
 *
 * ここに置く関数は副作用（`console.log` / `process.exit` / 子プロセス起動）を持たない。
 * 持たせたくなったら、それは `check-publish-pack.mjs` 側に置くべきものである。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** `dependencies` 等のどの値も `workspace:` プロトコルで始まっていないか調べる。 */
export function findWorkspaceProtocolViolations(manifest) {
  const violations = [];
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = manifest[field];
    if (!deps) continue;
    for (const [depName, range] of Object.entries(deps)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        violations.push(`${field}.${depName} = "${range}"`);
      }
    }
  }
  return violations;
}

/** 完全固定（レンジ演算子を持たない厳密な `x.y.z` 形）のバージョン文字列にだけ一致する。 */
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * `dependencies`（**実行時**依存だけ。`devDependencies` は対象外）のうち、完全固定に
 * なっているものを集める（Issue #166）。
 *
 * **なぜ `dependencies` だけを見るか（`devDependencies` を対象外にする理由）**: ルート
 * `.npmrc` の `save-exact=true` は、このリポジトリ自身のビルド再現性のために全ての依存を
 * 追加時点で完全固定する——**これは今回の問題と目的が違う。** `devDependencies` は
 * 公開される tarball に入らず、下流の `node_modules` にも並ばないので、そこが完全固定でも
 * 下流の dedupe は壊れない。壊れるのは、**公開したパッケージの `dependencies` が完全固定の
 * とき**——下流が同じパッケージを新しいバージョンで持っていても npm/pnpm が1本に
 * dedupe できず、2本並んだ型が構造的に非互換になりうる（zod は `_zod.version.minor` を
 * リテラル型に埋め込むため、実際に起きた。Issue #166 の報告者による実測は ADR を見ること）。
 * **`save-exact=true` は `devDependencies` にはそのまま効かせ続ける方針であり、この歯は
 * それを変えない。**
 *
 * **`exemptDependencyNames` について**: 呼び出し側が明示的に渡した依存名は対象外として
 * 扱う——放置ではなく、`EXACT_PINNED_DEPENDENCY_EXEMPTIONS`（下）に負債として名指しで残す。
 * 対象から外すのをやめたくなったら、そこから名前を消すだけでよい
 * （消した瞬間にこの歯が検査し始める）。
 */
export function findExactPinnedDependencyViolations(manifest, exemptDependencyNames = []) {
  const violations = [];
  const deps = manifest.dependencies;
  if (!deps) return violations;
  const exempt = new Set(exemptDependencyNames);
  for (const [depName, range] of Object.entries(deps)) {
    if (exempt.has(depName)) continue;
    if (typeof range === "string" && EXACT_SEMVER_RE.test(range)) {
      violations.push(
        `dependencies.${depName} = "${range}"（完全固定。範囲指定（例: "^${range}"）にすること）`,
      );
    }
  }
  return violations;
}

/**
 * `findExactPinnedDependencyViolations` の除外リスト（パッケージ名 → 依存名の配列）。
 *
 * **これは「問題ない」の一覧ではなく「未確認のまま残した負債」の一覧である**（Issue #166）。
 * ルート `.npmrc` の `save-exact=true` により、ここに挙げた依存も zod と同じ経緯
 * （機械的な完全固定）で pin されたと見られるが、Issue #166 が実測で報告したのは zod のみ
 * であり、他の依存が同じ下流2本化を実際に起こすかは確認していない。
 * `docs/autonomy.md` §2「ついでに直さない」に従い、対象を zod だけに絞ってここへ
 * 明示的に退避する。将来これらを緩めるときは、ここから名前を消すだけでよい。
 *
 * **唯一の定義であること**: `scripts/check-publish-pack.mjs`（実行時に使う側）と
 * `scripts/__tests__/check-publish-pack.test.mjs`（歯として検査する側）の両方がここから
 * import する。かつて2箇所に写しを置いて後からずれた例（`PUBLISH_TARGETS`。ADR 0066）を
 * 踏まえ、最初から1箇所にした——2箇所目を作らないので、ずれを検知する歯自体が不要になる。
 */
export const EXACT_PINNED_DEPENDENCY_EXEMPTIONS = {
  "@mnemora/openai": ["openai"],
  "@mnemora/anthropic": ["@anthropic-ai/sdk"],
  "@mnemora/postgres": ["@types/pg", "drizzle-orm", "pg"],
  "@mnemora/local-embedding": ["@huggingface/transformers"],
};

/**
 * `main` / `types` / `bin` / `exports` が指すファイルのうち、tarball 内に実在しないものを集める。
 *
 * **`exports` を見る理由（ADR 0066）**: Node と TypeScript は `exports` が在れば
 * `main` / `types` を**見ない**。つまり `exports` の指す先だけが欠けた tarball は、
 * `main` / `types` が実在するかぎりこの門の旧版を素通りしたうえで、使う側では
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` や `ERR_MODULE_NOT_FOUND` で落ちる。
 * **今の入口を測らずに、後退路だけを測っていることになる。**
 *
 * 条件付き exports（`{ types, default, import, ... }`）は入れ子になりうるので再帰で辿る。
 * 値が `null`（意図的に塞いだ subpath）のものは指し先が無いのが正しいので飛ばす。
 */
export function findMissingEntryPoints(manifest, packageDir) {
  const missing = [];
  const check = (label, relPath) => {
    if (!relPath) return;
    const absPath = resolve(packageDir, relPath);
    try {
      statSync(absPath);
    } catch {
      missing.push(`${label} -> ${relPath}`);
    }
  };
  check("main", manifest.main);
  check("types", manifest.types);
  if (manifest.bin) {
    if (typeof manifest.bin === "string") {
      check("bin", manifest.bin);
    } else {
      for (const [binName, binPath] of Object.entries(manifest.bin)) {
        check(`bin.${binName}`, binPath);
      }
    }
  }
  const walkExports = (label, node) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      check(label, node);
      return;
    }
    if (Array.isArray(node)) {
      // exports の配列形は「最初に解決できたものを使う」——全件の実在は要求できない。
      // 1つも実在しなければ違反である。
      const anyResolves = node.some((candidate) => {
        if (typeof candidate !== "string") return false;
        try {
          statSync(resolve(packageDir, candidate));
          return true;
        } catch {
          return false;
        }
      });
      if (!anyResolves) {
        missing.push(`${label} -> ${JSON.stringify(node)} のどれも実在しない`);
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      walkExports(`${label}${key.startsWith(".") ? key : `[${key}]`}`, value);
    }
  };
  if (manifest.exports !== undefined) {
    walkExports("exports", manifest.exports);
  }
  return missing;
}

/**
 * `README.md` が tarball 内（に相当するディレクトリ）に実在するか調べる。
 *
 * **なぜ作業ツリーの `README.md` ではなく tarball 側（`packageDir`）を見るか**: 作業ツリーに
 * `README.md` が実在していても、`files` の絞り込みや `.npmignore` 相当の設定次第では、
 * 使う人が実際に受け取る tarball には入らないことがある——`findLicenseViolations` が
 * `LICENSE` ファイルについて同じ理由で tarball 側を見ているのと同じ理由である
 * （このモジュールの他の関数と同じく、呼び出し側が「pack して展開した実体」を渡す前提に
 * 揃えている）。README が無い tarball は npm のパッケージページや `npm view` で
 * 説明が空になる——publish 自体は失敗しないため、この歯が無いと気づかれないまま起きる。
 */
export function findMissingReadme(packageDir) {
  try {
    statSync(join(packageDir, "README.md"));
    return [];
  } catch {
    return ["README.md が tarball に入っていません"];
  }
}

/**
 * tarball 内の manifest に `private` が立っていないか調べる（ADR 0066）。
 *
 * **なぜ tarball の側でも見るか**: `private: true` のままだと publish は
 * `This package has been marked as private` で止まる——つまり事故にはならない。
 * この歯が守っているのは publish の失敗ではなく、**`private` の状態と
 * 「publish してよい」という明示的な決定が一致していること**である（ADR 0060 が
 * ラッチとして置き、ADR 0066 が外した）。作業ツリー側の静的な歯と対にして、
 * **使う人が受け取る実体の側からも**同じことを見る。
 */
export function findPrivateViolations(manifest) {
  if (manifest.private === undefined || manifest.private === false) return [];
  return [`private が立っています: ${JSON.stringify(manifest.private)}`];
}

/** `dir` 以下を再帰的に歩き、`predicate(fullPath)` が true のファイルパスを集める。 */
export function findFiles(dir, predicate, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findFiles(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `license` が `MIT` であること、`LICENSE` ファイルが tarball 内（に相当するディレクトリ）に
 * 実在することを調べる（ADR 0061）。
 *
 * **なぜ「`UNLICENSED` でないこと」ではなく「`MIT` と等しいこと」を見るか**: 前者は
 * `Apache-2.0` のような隣の値もそのまま通してしまう弱い歯になる。オーナーは MIT を
 * 名指しで選んでいる（ADR 0061 逐語）——ここで検査したいのは「publish 可能な何らかの値」
 * ではなく「選んだ値そのもの」である。
 *
 * **なぜ作業ツリーの `package.json` ではなく `manifest`（呼び出し側が tarball を展開して
 * 読んだもの）を受け取るか**: `license` フィールドが作業ツリーで `MIT` でも、`files` の
 * 絞り込みや `.npmignore` 相当の設定次第では、使う人が実際に受け取る tarball の中身は
 * 別物でありうる。**このモジュールの他の関数（`findMissingEntryPoints` 等）と同じく、
 * 呼び出し側が「pack して展開した実体」を渡す前提に揃えている。**
 */
export function findLicenseViolations(manifest, packageDir) {
  const violations = [];
  if (manifest.license !== "MIT") {
    violations.push(`license が "MIT" ではありません: ${JSON.stringify(manifest.license)}`);
  }
  try {
    statSync(join(packageDir, "LICENSE"));
  } catch {
    violations.push("LICENSE ファイルが tarball に入っていません");
  }
  return violations;
}

/**
 * `version` が `0.0.0` のまま、または未設定のまま publish 対象の tarball が出ていかないか
 * 調べる（検査2・単一パッケージ側。Issue #174）。
 *
 * **⚠ この検査は「version が正しい値か」を決めているのではない（ADR 0070）**: 版の権威は
 * Release の tag に置かれており、`package.json` の `version` はそれを受け取る側でしかない
 * ——`scripts/apply-release-version.mjs` が publish 直前に tag の値を書き込む。ここで見ているのは
 * 「その書き込みより前の、初期値のまま（`0.0.0`）や空のまま publish 対象が出ていかないこと」
 * だけである。**`0.0.1` のような小さい値や `1.0.0-rc.1` のような prerelease はここでは
 * 弾かない**——弾く理由が無い（`0.0.0` と未設定だけが「まだ tag の値を受け取っていない」
 * ことの目印である）。
 */
export function findVersionViolations(manifest) {
  if (manifest.version === "0.0.0" || !manifest.version) {
    return [`version が未設定か 0.0.0 のままです: ${manifest.version}`];
  }
  return [];
}

/**
 * publish 対象のうち version 検査（`findVersionViolations`）を通過したものだけを集めた
 * `versions` が、`targetCount`（`PUBLISH_TARGETS.length`）ぶん揃ったうえで全パッケージ
 * 同じ版であるか調べる（検査2・publish 対象をまたぐ側。Issue #174）。
 *
 * **なぜ `manifest` 1個ではなく `versions` の配列と `targetCount` を受け取るか**: この検査は
 * 単一パッケージの中では判定できない——他の対象と揃っているかを見るものなので、呼び出し側
 * （`scripts/check-publish-pack.mjs`）が全対象のループを回し終えたあとに、集まった `versions`
 * を渡して1回だけ呼ぶ。単一パッケージ側の `findVersionViolations` とは引数の形も呼ばれる
 * 回数も違うため、1つの関数にまとめない。
 *
 * **⚠ `versions.length === targetCount` の条件が入っている理由（意図的な性質。歯で固定する）**:
 * `versions` には version 検査を通過したものしか入らない（呼び出し側が
 * `if (versionViolations.length === 0) { versions.push(...) }` という形で積む——
 * `scripts/check-publish-pack.mjs` 参照）。だから1つでも version 違反（`0.0.0` や未設定）で
 * 落ちた回は `versions.length` が `targetCount` より少なくなり、この検査は**揃い検査をしない**。
 * これは見落としではない——欠けた1件はすでに「version が未設定か 0.0.0 のままです」として
 * 別に報告済みであり、それを「version が揃っていません」という不正確な文言（本当は集まった
 * 分の中でどれだけ揃っているかしか言えない）でもう一度重ねて報告しないためである
 * （`scripts/check-publish-pack.mjs` の呼び出し側コメント「version 自体が有効だったものだけを
 * 比較する」がその意図）。
 */
export function findVersionSkewViolations(versions, targetCount) {
  const distinctVersions = new Set(versions.map((v) => v.version));
  if (versions.length === targetCount && distinctVersions.size > 1) {
    return [
      `version が publish 対象で揃っていません: ${versions.map((v) => `${v.name}@${v.version}`).join(", ")}`,
    ];
  }
  return [];
}

/**
 * `publishConfig.access` が `"public"` であることを調べる（検査5。Issue #174）。
 *
 * **なぜ「`restricted` でないこと」ではなく「`public` と等しいこと」を見るか**:
 * `findLicenseViolations` が `license` について「`UNLICENSED` でないこと」ではなく `MIT`
 * との等値を見ているのと同じ理由——前者は隣の値（未設定・大文字違いの `"Public"` 等）も
 * そのまま通してしまう弱い歯になる。ここで検査したいのは「publish 可能な何らかの値」では
 * なく、スコープ付きパッケージ（`@mnemora/*`）を誰でも `npm install` できる状態で出す、
 * という選んだ値そのものである。
 *
 * **`publishConfig` 自体が無い場合も違反になる**: `manifest.publishConfig?.access` は
 * `publishConfig` が無ければ `undefined` になり、`undefined !== "public"` は真になる
 * ——「明示していない」を「public にすると決めていない」として扱う。
 */
export function findPublishAccessViolations(manifest) {
  if (manifest.publishConfig?.access !== "public") {
    return [
      `publishConfig.access が "public" ではありません: ${JSON.stringify(manifest.publishConfig)}`,
    ];
  }
  return [];
}

/**
 * tarball 内（に相当するディレクトリ）の `*.map` のうち、`sources` がそのディレクトリ内に
 * 実在しない相対パスを指しているものを集める（「宙に浮いた source map」）。
 *
 * **これは publish 前の現物で実際に起きていた形そのものである**: 修正前の
 * `packages/core` の `dist/index.d.ts.map` は `sources: ["../src/index.ts"]` を持っていたが、
 * `files: ["dist"]` は `src/` を tarball に含めないため、その実体は tarball の中に無かった
 * （実測して確認した）。`tsconfig.build.json` に `declarationMap`/`sourceMap: false` を
 * 足して以降、ビルドはそもそも `.map` を出さなくなったので、この関数が現物に対して
 * 何かを検出することは今は無いはずである。だからこそ、この関数が「壊した入力に対しては
 * 実際に検出する」ことを合成フィクスチャで別途測る必要がある
 * （`scripts/__tests__/check-publish-pack.test.mjs` 参照）。
 */
export function findOrphanedSourceMaps(packageDir) {
  const mapFiles = findFiles(packageDir, (path) => path.endsWith(".map"));
  const orphans = [];
  for (const mapFile of mapFiles) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(mapFile, "utf8"));
    } catch (error) {
      orphans.push(`${relative(packageDir, mapFile)}: JSON として読めない (${error.message})`);
      continue;
    }
    const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    for (const source of sources) {
      const resolved = resolve(dirname(mapFile), source);
      try {
        statSync(resolved);
      } catch {
        orphans.push(
          `${relative(packageDir, mapFile)}: sources に "${source}" とあるが tarball 内に無い`,
        );
      }
    }
  }
  return orphans;
}
