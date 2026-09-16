/**
 * npm へ出す6パッケージと、**その publish 順序**を持つ唯一の定義（ADR 0060 決定1・ADR 0066）。
 *
 * **なぜ順序まで持つか**: ADR 0060 が「引き受けた負債」として
 * 「publish の順序は依存の向きで決まる（`core` → `testkit` / `openai` → `postgres`）。
 * **これを守らせる仕掛けはまだ無い**——順序を誤ると使う側が E404 を見る」と書いた。
 * この配列の順序がその仕掛けである。`scripts/pack-publish-targets.mjs` はこの順に tarball を並べ、
 * `.github/workflows/publish.yml` はその順に `npm publish` を打つ。
 *
 * 順序が依存の向きと整合していること（各パッケージの `@mnemora/*` 依存が自分より前に在ること）は
 * `scripts/__tests__/publish-targets.test.mjs` が機械的に検査する——**手で並べた順序を、
 * 手で確かめない。**
 *
 * **対象は固定リストである（動的に発見しない）。** publish 対象と非対象
 * （ルートの `mnemora` / `@mnemora/example-chat`）を分ける機械的な目印は無い
 * （`scripts/check-publish-pack.mjs` 冒頭の議論を見ること）。**新しい publish 対象が
 * 増えたら、ここに手で足す必要がある**——見落としを機械的には検知できない。
 */

/** @type {{ name: string; dir: string }[]} */
export const PUBLISH_TARGETS = [
  { name: "@mnemora/core", dir: "packages/core" },
  { name: "@mnemora/testkit", dir: "packages/testkit" },
  { name: "@mnemora/openai", dir: "packages/openai" },
  { name: "@mnemora/postgres", dir: "packages/postgres" },
  // ⭐ 【実測】2026-09-16 時点、registry には6パッケージとも 0.1.9 まで公開済みである
  // （`@mnemora/anthropic` は 0.1.2 から、`@mnemora/local-embedding` は 0.1.4 から）。
  // ⟹ **この規律が書かれた当時は anthropic / local-embedding が未公開だった。
  // いまこの並びを支えているのは依存の向きだけである**——4パッケージの後ろに置く
  // 積極的な理由はもう無いが、置き直す積極的な理由も無い（依存の向きは今のままでも
  // 整合する）ので、並び順（配列そのもの）は変えていない。
  //
  // 当時の理由（記録として残す）: npm の Trusted Publishing は「設定する時点で
  // パッケージが registry に在ること」を前提にしており、**初版を OIDC で出すことは
  // できない**（npm/cli#8544 は OPEN。ADR 0066）。⟹ 未公開のパッケージは publish 段で
  // 403 になりうる。このリストの順に publish するので、**未公開のものが途中に居ると、
  // その後ろが publish されない。**`@mnemora/anthropic` を4番目に置いていた時点では、
  // 失敗したときに `@mnemora/postgres` が取り残される形だった。
  //
  // 依存の向きとしては、`@mnemora/anthropic` は `@mnemora/core` にしか依存しないので
  // 最後に置いても整合する（`scripts/__tests__/publish-targets.test.mjs` が機械的に検査する）。
  { name: "@mnemora/anthropic", dir: "packages/anthropic" },
  // `@mnemora/local-embedding` も、上と同じ理由（当時は未公開だった）で末尾に置いてある。
  // 【実測】現在は公開済み（上記）。
  //
  // **`@mnemora/anthropic` との前後は、どちらでも規律に反しない。**規律が守ろうとしていたのは
  // 「**既に公開済みのものが、未公開のものの失敗で取り残されないこと**」であり、
  // 未公開どうしの順序はその目的に関係しない（どちらが先でも、公開済みの4つは先に完走する）。
  // 依存の向きとしても `@mnemora/core` にしか依存しないので、末尾で整合する
  // （`scripts/__tests__/publish-targets.test.mjs` が機械的に検査する）。
  { name: "@mnemora/local-embedding", dir: "packages/local-embedding" },
];
