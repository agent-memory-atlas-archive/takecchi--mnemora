import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAdrEntries } from "../generate-adr-index-lib.mjs";

/**
 * `docs/decisions/*.md` に同じ4桁番号を名乗るファイルが2本以上無いかを検査する
 * 配線の歯（Issue #315）。
 *
 * ⚠ **この歯は `adr-index-freshness.test.mjs` に足していない。**
 * あのファイルは `GITHUB_REF` が `refs/heads/main` のときだけ走り、`pull_request`
 * では常に skip する（`describe.skipIf(!mainNow)`。理由は同ファイルの docstring
 * ——ADR PR の作成者は `docs/decisions/README.md` を触らない設計（ADR 0137）なので、
 * 索引の「陳腐化」検査を PR ブランチで無条件に走らせると、すべての ADR PR で
 * 赤くなってしまう）。
 *
 * しかし「番号が重複しているか」は**索引が最新かどうかに依存しない**
 * ——`docs/decisions/*.md` のファイル名だけで決まる。ADR PR 作成者が
 * 索引を触らないことと、重複番号を検出することは無関係であり、`main` 限定に
 * する理由が無い。重複は `main` へ着地する前に止めたい（Issue #315 の
 * 「起きかけた」実例: PR #310 の 0156 と、並行して open だった PR #313 の 0156）
 * ので、この歯は `describe.skipIf` を付けず、**PR ブランチでも無条件に走る**
 * （このファイルは `vitest.config.ts` の `include: ["scripts/**\/*.test.mjs"]` に
 * 素直に拾われ、`main` 限定の分岐を一切持たない）。
 *
 * 重複検出そのものの純関数としての単体テスト（`buildAdrEntries` が例外を
 * 投げること）は `generate-adr-index-lib.test.mjs` にある。このファイルは
 * **実ファイルへの配線**だけを見る——`adr-index-freshness.test.mjs` と同じ
 * 役割分担（このファイルの docstring 参照）。
 */

const decisionsDir = fileURLToPath(new URL("../../docs/decisions", import.meta.url));

function loadAdrFiles() {
  return readdirSync(decisionsDir)
    .filter((filename) => filename !== "README.md")
    .map((filename) => ({
      filename,
      content: readFileSync(`${decisionsDir}/${filename}`, "utf8"),
    }));
}

describe("docs/decisions/*.md に重複番号が無いか（PR でも無条件に走る）", () => {
  it("同じ4桁番号を名乗るファイルが2本以上無い", () => {
    const files = loadAdrFiles();
    // 重複があれば buildAdrEntries 自体が例外を投げる（Issue #315）。
    // ここでは「例外を投げずに構築できる」ことそのものを歯にする。
    expect(() => buildAdrEntries(files)).not.toThrow();
  });

  it("空振り防止: ADR ファイルが1件以上ある", () => {
    const files = loadAdrFiles();
    const entries = buildAdrEntries(files);
    expect(entries.length).toBeGreaterThan(0);
  });
});
