import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  anchorExistsInTarget,
  findAdrAnchorCitations,
  findAdrLineNumberCitations,
  lineNumberAt,
} from "../adr-citation-lib.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** repo 直下から見た相対パスへ変換する（報告の逐語比較をしやすくするため）。 */
function toRepoRelative(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
}

/** `.md` ファイルを再帰的に集める（`node_modules`・`.git` は除く）。 */
function collectMarkdownFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(full, acc);
    } else if (entry.name.endsWith(".md")) {
      acc.push(full);
    }
  }
  return acc;
}

/** 「生きた文書」= docs/** から docs/decisions/ を除いたもの・AGENTS.md・README.md。 */
function isLivingDoc(repoRelativeFile) {
  if (repoRelativeFile.startsWith("docs/decisions/")) {
    return false;
  }
  return (
    repoRelativeFile.startsWith("docs/") ||
    repoRelativeFile === "AGENTS.md" ||
    repoRelativeFile === "README.md"
  );
}

/** 生きた文書（`docs/**` から `docs/decisions/` を除いたもの・`AGENTS.md`・`README.md`）を集める。 */
function collectLivingDocFiles() {
  const files = collectMarkdownFiles(path.join(REPO_ROOT, "docs"));
  for (const name of ["AGENTS.md", "README.md"]) {
    const p = path.join(REPO_ROOT, name);
    if (statSync(p, { throwIfNoEntry: false })) {
      files.push(p);
    }
  }
  return files.map(toRepoRelative).filter(isLivingDoc);
}

/** ADR 番号 → `docs/decisions/NNNN-slug.md` の絶対パスの対応表。 */
function buildAdrFileIndex() {
  const decisionsDir = path.join(REPO_ROOT, "docs/decisions");
  const map = new Map();
  for (const name of readdirSync(decisionsDir)) {
    if (!name.endsWith(".md")) {
      continue;
    }
    const m = name.match(/^(\d{4})-/);
    if (m) {
      map.set(m[1], path.join(decisionsDir, name));
    }
  }
  return map;
}

describe("findAdrLineNumberCitations（fixture）", () => {
  it("combined 形: docs/decisions/ 接頭辞あり", () => {
    const text = "詳細は `docs/decisions/0147-recall-footprint-estimator.md:118-121` を見ること。";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toEqual([
      {
        index: text.indexOf("`"),
        line: 1,
        raw: "`docs/decisions/0147-recall-footprint-estimator.md:118-121`",
        adrNumber: "0147",
        kind: "combined",
      },
    ]);
  });

  it("combined 形: 接頭辞なし・単一行番号", () => {
    const text = "`0082-tick-names-unsupported-job-kinds.md:216` に書いてある。";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ adrNumber: "0082", kind: "combined" });
  });

  it("combined 形: ファイル名がリテラルな連続ピリオドへ省略された形（実地で見つかった一族）", () => {
    const text = "解消は `docs/decisions/0070-....md:139-142` を見ること。";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ adrNumber: "0070", kind: "combined" });
  });

  it("combined 形: バッククォートの中に改行を1つ挟んで行番号が続く形", () => {
    const text = "残っている（`docs/decisions/0066-....md:11,\n241-267`）。解消は……";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      adrNumber: "0066",
      kind: "combined",
      raw: "`docs/decisions/0066-....md:11,\n241-267`",
    });
  });

  it("adr-comma-line 形: 全角読点 + 範囲 + 行", () => {
    const text = "ADR 0067、124-130行。【読んで確かめた】";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toEqual([
      { index: 0, line: 1, raw: "ADR 0067、124-130行", adrNumber: "0067", kind: "adr-comma-line" },
    ]);
  });

  it("adr-comma-line 形: 単一行番号", () => {
    const text = "ADR 0066、391行に明記。";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toEqual([
      { index: 0, line: 1, raw: "ADR 0066、391行", adrNumber: "0066", kind: "adr-comma-line" },
    ]);
  });

  it("adr-paren-colon 形", () => {
    const text = "ADR 0030（`:29-37`）が既にこれを名指ししていた";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toEqual([
      {
        index: 0,
        line: 1,
        raw: "ADR 0030（`:29-37`）",
        adrNumber: "0030",
        kind: "adr-paren-colon",
      },
    ]);
  });

  it("md-link-colon 形: リンクへ直接バッククォートコロンが続く（0字接続）", () => {
    const text = "[ADR 0078](./0078-strength-value-range.md)`:251-253` は逐語で";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toEqual([
      {
        index: 0,
        line: 1,
        raw: "[ADR 0078](./0078-strength-value-range.md)`:251-253`",
        adrNumber: "0078",
        kind: "md-link-colon",
      },
    ]);
  });

  it("md-link-colon 形: リンクと接続詞「の」を挟む形", () => {
    const text =
      "[ADR 0172](./decisions/0172-association-passes-decay-and-validity-gates.md) の `:249` が";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ adrNumber: "0172", kind: "md-link-colon" });
  });

  it("omitted-reference 形: 直前に登場した ADR ファイルを指す省略形（`同 `:NN``）", () => {
    const text =
      "`0082-tick-names-unsupported-job-kinds.md:216`: 「本体を実装する人は」\n" +
      "同 `:82`: 「作業の途中で」";
    const hits = findAdrLineNumberCitations(text);
    expect(hits.map((h) => h.kind)).toEqual(["combined", "omitted-reference"]);
    expect(hits[1]).toMatchObject({ adrNumber: "0082", raw: "同 `:82`" });
  });

  it("omitted-reference 形: 直前が markdown link 付きの ADR 引用でも解決できる", () => {
    const text =
      "加えて [ADR 0078](./0078-strength-value-range.md)`:251-253` は逐語で\n" +
      "「蓋だけを、先に付けた。」\n" +
      "と書いており、同 `:326-331` の「これが覆るとしたら」は";
    const hits = findAdrLineNumberCitations(text);
    const omitted = hits.find((h) => h.kind === "omitted-reference");
    expect(omitted).toMatchObject({ adrNumber: "0078", raw: "同 `:326-331`" });
  });

  it("omitted-reference 形: 直前の対象が ADR ではなくソースファイルなら数えない（`同ファイル`）", () => {
    const text =
      "`packages/local-embedding/src/local-embedding-provider.ts` の型を公開しない" +
      "（同ファイル `:51-53`）。";
    const hits = findAdrLineNumberCitations(text);
    expect(hits).toEqual([]);
  });

  it("複数の書き方が同じテキストに混在しても全部拾う", () => {
    const text = [
      "`docs/decisions/0070-version-comes-from-the-release-tag.md:66-78`",
      "ADR 0067、124-130行",
      "ADR 0030（`:29-37`）",
      "[ADR 0078](./0078-strength-value-range.md)`:251-253`",
    ].join("\n");
    const hits = findAdrLineNumberCitations(text);
    expect(hits.map((h) => h.kind)).toEqual([
      "combined",
      "adr-comma-line",
      "adr-paren-colon",
      "md-link-colon",
    ]);
  });

  describe("偽陽性の罠（「行」は row の意味でも大量に使われる）", () => {
    const traps = [
      [
        "「1行も変えない」は行番号ではない",
        "⛔ 実装は1行も変えない。本 ADR は測定と訂正の記録だけである。",
      ],
      [
        "「100,000行」は投入した件数であって行番号ではない",
        "100,000行を投入し、以降 ANALYZE を一切走らせない",
      ],
      [
        "ADR の直後でも「210行」は件数であって行番号ではない",
        "ADR 0108 が実測した通り、いまは 210行すべてで score.lexicalMatch の欄そのものが存在せず",
      ],
      [
        "「§11 行5」は他文書の節番号であって ADR の行番号ではない（行が数字の前に来る）",
        "docs/memory-model.md §11 行5・本節末尾「破棄系」の節が要求する",
      ],
      [
        "「ADR 64本」はADRの本数であって行番号ではない（4桁でない）",
        "docs/decisions/ 配下の ADR 64本（0001〜0064、READMEの一覧表の件数と一致）",
      ],
      [
        "ADR の直後の「1行目」は構造の説明であって特定行の引用ではない（実地の反例、間隔は拾いたい例より短い）",
        "ADR 0067 は `#` の見出しを1行目にしか持たず、節はすべて `- **見出し語**:` の箇条書きである。",
      ],
    ];
    it.each(traps)("%s", (_label, text) => {
      expect(findAdrLineNumberCitations(text)).toEqual([]);
    });
  });
});

describe("lineNumberAt（fixture）", () => {
  it("改行の数から1始まりの行番号を出す", () => {
    const text = "a\nb\nc";
    expect(lineNumberAt(text, 0)).toBe(1);
    expect(lineNumberAt(text, 2)).toBe(2);
    expect(lineNumberAt(text, 4)).toBe(3);
  });
});

describe("findAdrAnchorCitations + anchorExistsInTarget（fixture）", () => {
  it("0字接続: `ADR NNNN「...」`", () => {
    const text = "ADR 0067「⭐ (B) の一般化 — この ADR の芯」を読むこと。";
    const hits = findAdrAnchorCitations(text);
    expect(hits).toEqual([
      {
        index: 0,
        line: 1,
        raw: "ADR 0067「⭐ (B) の一般化 — この ADR の芯」",
        adrNumber: "0067",
        quote: "⭐ (B) の一般化 — この ADR の芯",
      },
    ]);
  });

  it("markdown link + 「...」も拾う（0字接続）", () => {
    const text =
      "[ADR 0202](./0202-postgres-shared-db-object-names.md)「引き受けた負債」を解消する";
    const hits = findAdrAnchorCitations(text);
    expect(hits).toEqual([
      {
        index: 0,
        line: 1,
        raw: "[ADR 0202](./0202-postgres-shared-db-object-names.md)「引き受けた負債」",
        adrNumber: "0202",
        quote: "引き受けた負債",
      },
    ]);
  });

  it("句点をまたぐ「...」は拾わない（無関係な段落の鉤括弧への誤爆を防ぐ）", () => {
    const text = "ADR 0067 は分岐ごと覆る」。**⟹ オーナーが「後者でいいです」と述べた。";
    const hits = findAdrAnchorCitations(text);
    expect(hits).toEqual([]);
  });

  it("改行をまたぐ「...」は拾わない", () => {
    const text = "ADR 0165 を読むこと。\n\n「これは無関係な引用」である。";
    expect(findAdrAnchorCitations(text)).toEqual([]);
  });

  it("⚠ 既知の限界: 30字以内・句点なしなら無関係な「...」も拾ってしまう（意図的な線引き、報告に明記）", () => {
    const text = "ADR 0999 とは別の段落に「離れた引用」がある。";
    const hits = findAdrAnchorCitations(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].quote).toBe("離れた引用");
  });

  describe("anchorExistsInTarget", () => {
    it("そのまま存在すれば true", () => {
      expect(anchorExistsInTarget("引き受けた負債", "- **引き受けた負債**:\n  ...")).toBe(true);
    });

    it("存在しなければ false", () => {
      expect(anchorExistsInTarget("存在しない架空の見出し", "- **決定**:\n  ...")).toBe(false);
    });

    it("末尾の素の数字を取り除くと一致する場合を拾う（見出しが番号無しで、引用側だけが項番を足す形）", () => {
      // 実地の例: docs/decisions/0119 の見出しは「引き受けた負債・覆えていない範囲」であり、
      // 「引き受けた負債3」という文字列そのものは存在しないが、末尾の数字を除いた
      // 「引き受けた負債」は前方一致で存在する。
      expect(
        anchorExistsInTarget("引き受けた負債3", "- **引き受けた負債・覆えていない範囲**:\n"),
      ).toBe(true);
    });

    it("数字が引用の一部として本当に存在する場合もそのまま拾う", () => {
      expect(anchorExistsInTarget("採らなかった案4", "（採らなかった案4）。次の一手は……")).toBe(
        true,
      );
    });

    it("太字 `**` の境界がずれていても中身が一致すれば拾う（記法だけの差）", () => {
      // 実地の例: docs/roadmap.md:402 の引用 `**オーナーの承認待ちである 【伝】**` は、
      // 引用先 ADR 0151 では `**オーナーの承認待ちである 【伝】。**`（句点が ** の内側にある）
      // という形で存在し、素の部分文字列比較では一致しない。
      expect(
        anchorExistsInTarget(
          "**オーナーの承認待ちである 【伝】**",
          "後者を採ったのはクローンの判断であり、**オーナーの承認待ちである 【伝】。**",
        ),
      ).toBe(true);
    });

    it("インラインコードのバッククォートの有無がずれていても中身が一致すれば拾う（記法だけの差）", () => {
      // 実地の例: docs/decisions/0038:87 の引用 `similarity` （バッククォート無し）は、
      // 引用先 ADR 0036 では `` `similarity` ``（バッククォート付き）で存在する。
      expect(
        anchorExistsInTarget(
          "similarity は −1 まで負になりうる",
          "`similarity` は **−1 まで負になりうる**（ADR 0033",
        ),
      ).toBe(true);
    });

    it("記法を揃えても中身が違えば false のまま（ニックネーム/言い換えは実在しないと判定する）", () => {
      // 実地の例: 複数の ADR が「ADR 0008「無いには種類がある」」という形で ADR 0008 を
      // 指すが、これは ADR 0008（見出し「「無い」を分類して返す」）の趣旨を要約した
      // ニックネームであり、本文のどこにも逐語では存在しない。
      expect(
        anchorExistsInTarget("無いには種類がある", "# ADR 0008: 「無い」を分類して返す\n"),
      ).toBe(false);
    });
  });
});

/**
 * ⭐ 再現率の歯: マネージャーが実地で数え直した「既知の引用」18件を、この歯そのものの中に
 * **静的なリテラル文字列として持つ**（実物ファイルを読まない）。
 *
 * ⚠ 前回はこれを `docs/release-v1.md` を読んで測っていたが、マネージャーが該当箇所を
 * アンカー形式へ移行したことで、実物ファイルとテストが食い違って赤くなった
 * （「腐る」歯だった）。⟹ **書き方の一族を検出できるかどうかは、実物の現状とは独立に
 * 証明できるべきである**——このテストはそれを、移行前の18件をリテラルに埋め込むことで
 * 実現する。マネージャーが今後どれだけ docs を書き換えても、この歯は腐らない。
 */
describe("再現率: 既知の18件（静的 fixture、doc の改変で腐らない）", () => {
  // 18件は元々 docs/release-v1.md に16件、docs/recall.md と docs/roadmap.md に
  // 同一文言の境界事例が1件ずつ（計2件）在った（マネージャーが最終的に「2件とも
  // ADR 0172 への真陽性」と訂正した）。
  const KNOWN_OLD_STYLE_CITATIONS = [
    {
      raw: "`docs/decisions/0070-version-comes-from-the-release-tag.md:66-78`",
      kind: "combined",
      adrNumber: "0070",
    },
    {
      raw: "`docs/decisions/0060-publish-with-pnpm-four-packages-at-0-1-0.md:54-66`",
      kind: "combined",
      adrNumber: "0060",
    },
    { raw: "ADR 0067、124-130行", kind: "adr-comma-line", adrNumber: "0067" },
    {
      raw: "`docs/decisions/0067-dry-run-fail-open-and-does-not-verify-trusted-publisher.md:118-134`",
      kind: "combined",
      adrNumber: "0067",
    },
    { raw: "ADR 0067、82-114行", kind: "adr-comma-line", adrNumber: "0067" },
    { raw: "`docs/decisions/0060-....md:140`", kind: "combined", adrNumber: "0060" },
    { raw: "`docs/decisions/0070-....md:139-142`", kind: "combined", adrNumber: "0070" },
    {
      raw: "`docs/decisions/0066-....md:11,\n241-267`",
      kind: "combined",
      adrNumber: "0066",
    },
    { raw: "`docs/decisions/0070-....md:113-116`", kind: "combined", adrNumber: "0070" },
    { raw: "`docs/decisions/0070-....md:122-131`", kind: "combined", adrNumber: "0070" },
    { raw: "`docs/decisions/0067-....md:100-103`", kind: "combined", adrNumber: "0067" },
    { raw: "`docs/decisions/0070-....md:118-121`", kind: "combined", adrNumber: "0070" },
    { raw: "ADR 0066、391行", kind: "adr-comma-line", adrNumber: "0066" },
    { raw: "`docs/decisions/0066-....md:131`", kind: "combined", adrNumber: "0066" },
    { raw: "`docs/decisions/0070-....md:138`", kind: "combined", adrNumber: "0070" },
    { raw: "`docs/decisions/0070-....md:174-175`", kind: "combined", adrNumber: "0070" },
    // 境界事例（docs/recall.md 由来。マネージャーが「ADR 0172 への真陽性」と訂正した）。
    {
      raw: "[ADR 0172](./decisions/0172-association-passes-decay-and-validity-gates.md) の `:249`",
      kind: "md-link-colon",
      adrNumber: "0172",
    },
    // 境界事例（docs/roadmap.md 由来。同一文言。真陽性としてもう1件、独立の行として数える）。
    {
      raw: "[ADR 0172](./decisions/0172-association-passes-decay-and-validity-gates.md) の `:249`",
      kind: "md-link-colon",
      adrNumber: "0172",
    },
  ];

  // 18件を、それぞれ別の行に埋め込んだ1本のテキストにする（`raw` 自身に改行を含むもの
  // ―combined 形の行またぎ―が1件あるので、行番号のズレを気にせず「全部見つかるか」だけを見る）。
  const FIXTURE_TEXT = KNOWN_OLD_STYLE_CITATIONS.map(
    (c, i) => `${i}. 文脈: ${c.raw} を見ること。`,
  ).join("\n");

  it("18件ちょうど見つかる（取りこぼしも過検出も無い）", () => {
    const hits = findAdrLineNumberCitations(FIXTURE_TEXT);
    expect(hits).toHaveLength(18);
  });

  it.each(KNOWN_OLD_STYLE_CITATIONS.map((c, i) => [i, c]))(
    "%i件目 ($kind, ADR $adrNumber) を拾う",
    (i, expected) => {
      const hits = findAdrLineNumberCitations(FIXTURE_TEXT);
      const found = hits.find((h) => h.raw === expected.raw && h.kind === expected.kind);
      expect(found).toBeDefined();
      expect(found.adrNumber).toBe(expected.adrNumber);
    },
  );
});

/**
 * 🔴 本物の歯1: 生きた文書（`docs/**` から `docs/decisions/` を除いたもの・`AGENTS.md`・
 * `README.md`）に、ADR への行番号引用が1件も無いこと。
 *
 * ⚠ これは実物ファイルを読む——マネージャーが `docs/release-v1.md` / `docs/recall.md` /
 * `docs/roadmap.md` の18件をアンカー形式へ移行した**後**の状態に対して測る
 * （移行前は赤かった。実際に赤いところを見た上で、移行後に緑になったことを確認した）。
 */
describe("🔴 本物の歯1: 生きた文書に ADR への行番号引用が無いこと（実物）", () => {
  it("生きた文書のどこにも、ADR を行番号で指す引用が無い", () => {
    const violations = [];
    for (const file of collectLivingDocFiles()) {
      const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
      for (const citation of findAdrLineNumberCitations(text)) {
        violations.push({ file, ...citation });
      }
    }
    expect(violations).toEqual([]);
  });

  it("⭐ mutation guard: 検出器は生きていて、ADR 本体（docs/decisions/）の中の行番号引用は実際に見つける", () => {
    // `docs/decisions/0087-runtime-forget-shape.md:57` は「ADR 0030（`:29-37`）」という
    // adr-paren-colon 形の引用を実際に持つ（ADR 本体が別の ADR を行番号で引く実例）。
    // ⛔ これは「生きた文書」の判定対象ではないので歯1の緑には影響しないが、
    // 「検出器が常に [] を返すよう壊れていないか」を確かめる canary として使う。
    const text = readFileSync(
      path.join(REPO_ROOT, "docs/decisions/0087-runtime-forget-shape.md"),
      "utf8",
    );
    const hits = findAdrLineNumberCitations(text);
    expect(hits.some((h) => h.kind === "adr-paren-colon" && h.adrNumber === "0030")).toBe(true);
  });
});

/**
 * 🔴 本物の歯2: 生きた文書のうち、行番号引用の移行対象だった3ファイル
 * （`docs/release-v1.md` / `docs/recall.md` / `docs/roadmap.md`）にある
 * `ADR NNNN「...」` アンカーが、全部引用先の ADR に実在すること。
 *
 * ⚠ **repo 全体には掛けない**（マネージャーの指示）。理由: ADR 本体は書き換えない
 * 作法なので、アンカーは構造的に腐らない——腐るのは行番号だけである。アンカー実在検査は
 * 「移行がちゃんと着地したか」を見るための歯であり、3ファイルに絞れば十分。
 *
 * 🔴 **実測: このアサーションは、いま緑ではない。**
 * この3ファイルには、今回の18件移行とは無関係の、**既存のニックネーム/言い換え引用**
 * （`ADR NNNN「(ADRの趣旨を要約した言葉)」` という形だが、その文字列自体は引用先 ADR の
 * どこにも逐語では存在しない）が以前から14件存在する。移行前の repo 全体調査でも
 * 同じ14件（同じファイル・同じ引用文字列。行番号だけがその後の編集でわずかにずれている
 * ものがある）を「実在しない」として検出しており、**今回の18件移行の対象ではなかった**
 * ことをこの歯の直前に自分で突き合わせて確認した。
 * 詳細と全14件の逐語は報告に書く。
 */
describe("🔴 移行の検算: この PR が入れたアンカーが、引用先の ADR に実在すること", () => {
  // ⛔ これは「歯」ではなく**移行が着地したかの検算**である。
  //
  // ⚠ `ADR NNNN「…」` という構文だけでは、次の3つを区別できない【実測】:
  //   1. **本物のアンカー** — 引用先に実在する見出し・太字ラベル
  //   2. **あだ名** — 趣旨を言い換えた短い名詞句。例: `ADR 0008「無いには種類がある」` は
  //      repo 全体で18箇所使われているが、ADR 0008 の本文には0回しか現れない
  //      （見出しは「「無い」を分類して返す」）
  //   3. **逐語の引用そのもの** — 例: `docs/roadmap.md` の
  //      `[ADR 0114](…) **検討して採らなかった案5**: 「…」` は、`「」` が
  //      アンカーではなく引用文である
  //
  // ⟹ **生きた文書3本に絞っても、61件中14件が「実在しない」と出る**【実測】——
  // その14件はどれも 2. か 3. であり、壊れているのではない。
  // ⛔ **だから「見つかったアンカーは全部実在する」を歯にはできない。**
  // ⟹ 代わりに、**この PR が実際に入れたものだけ**を名指しで検算する。
  //
  // ⭐ この一覧が腐らない理由: **ADR の本文は書き換えない**（ADR 0064）。
  // ⟹ 一度実在した文字列は、そこに在り続ける。冒頭への追記はアンカーを1文字も動かさない。
  const INTRODUCED_ANCHORS = [
    ["0070", "⭐ 測ったこと1 — `workspace:^` は書き込んだ版で解決される（この設計の要）"],
    ["0070", "⭐ 測ったこと3 — Trusted Publishing (OIDC) と provenance が実際に通った"],
    ["0070", "npm 上の `0.1.0` がどの commit とも一致しない"],
    ["0070", "npm error 403 Forbidden - PUT https://registry.npmjs.org/@mnemora%2fcore"],
    ["0070", "不一致なら npm は 404 を返す"],
    ["0070", "attestation 2件"],
    ["0070", '`npm publish --tag ""` の挙動をこの器で確かめていない'],
    ["0060", "2. `npm pack` は `workspace:*` を置換しない。`pnpm pack` は置換する。"],
    ["0066", "⭐ 測ったこと10 — npm 上の `0.1.0` は、この ADR が入る commit と一致しない"],
    ["0066", "⚠ npm は保存時に設定を検証しない"],
    ["0066", "Node 22 同梱の npm 10.x では OIDC の交換を実装しておらず"],
    ["0067", "⭐ (B) の一般化 — この ADR の芯"],
    ["0067", "(B) 🔴 予行は、信頼発行元の設定を検算していない"],
    ["0067", "同じ `OIDC permission denied` が返る可能性を、この作業者は排除できていない"],
    ["0172", "段3.5 の候補は段2の閾値分割を通らない"],
  ];

  const adrFileIndex = buildAdrFileIndex();

  it.each(INTRODUCED_ANCHORS)("ADR %s「%s」が引用先に実在する", (adrNumber, anchor) => {
    const targetPath = adrFileIndex.get(adrNumber);
    expect(targetPath).toBeDefined();
    const targetText = readFileSync(targetPath, "utf8");
    expect(anchorExistsInTarget(anchor, targetText)).toBe(true);
  });

  it("⭐ mutation guard: 実在しない架空の引用は、実物の ADR 本文に対して false になる", () => {
    const targetText = readFileSync(
      path.join(
        REPO_ROOT,
        "docs/decisions/0067-dry-run-fail-open-and-does-not-verify-trusted-publisher.md",
      ),
      "utf8",
    );
    expect(
      anchorExistsInTarget("この文字列はどの ADR にも実在しない架空のアンカー_QA9Z", targetText),
    ).toBe(false);
  });
});
