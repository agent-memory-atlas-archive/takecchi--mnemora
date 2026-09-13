import { describe, expect, it } from "vitest";
import {
  DEFAULT_JAPANESE_NAME_DENSE_HAYSTACK_SIZE,
  JAPANESE_NAME_PROBES,
  JAPANESE_NAME_TOPIC_KEYWORDS,
  buildJapaneseNameProbeSetConversation,
  findJapaneseNameTopicKeywordViolations,
} from "../japanese-name-probe-set.js";

/**
 * 日本語の固有名詞 probe set 自体の整合性（DB もネットワークも要らない）。
 *
 * ⚠ **これらの歯は「引けること」を一切要求していない。**この集合は
 * 「引けないものが在るかもしれない」領域を測るために置いたものであり、
 * **順位を主張する歯を置くと、実測が悪かったときに `main` が恒久的に赤くなる。**
 * ⟹ ここで測るのは**集合の形**（件数・重複・衝突・query の形）だけである。
 * 順位は `identifier-probes` が値として記録し、基準値との差は Job Summary に出る
 * ——⛔ 門にはしない。
 */
describe("japanese-name-probe-set", () => {
  it("4領域を12件で覆っている", () => {
    expect(JAPANESE_NAME_PROBES).toHaveLength(12);
    const categories = new Set(JAPANESE_NAME_PROBES.map((p) => p.category));
    expect(categories).toEqual(new Set(["person", "org", "product", "place"]));
  });

  it("probe id は重複しない", () => {
    const ids = JAPANESE_NAME_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("query は固有名詞そのものを含む（識別子 probe と同じ狙い）", () => {
    for (const probe of JAPANESE_NAME_PROBES) {
      const keywords = JAPANESE_NAME_TOPIC_KEYWORDS[probe.id] ?? [];
      const [goldName] = keywords;
      expect(goldName).toBeDefined();
      expect(probe.query.includes(goldName!)).toBe(true);
      expect(probe.fact.includes(goldName!)).toBe(true);
    }
  });

  it("すべて日本語である——ASCII の識別子を含まない（この集合の存在理由）", () => {
    // 🔴 赤の意味: この集合が ASCII 識別子を含み始めたら、それは
    // `identifier-probe-set.ts` と同じものを測っていることになり、
    // 「日本語の固有名詞を弁別できるか」という問いが静かに別の問いへ変わっている。
    for (const probe of JAPANESE_NAME_PROBES) {
      const keywords = JAPANESE_NAME_TOPIC_KEYWORDS[probe.id] ?? [];
      for (const name of keywords) {
        expect(/^[\x20-\x7e]+$/.test(name)).toBe(false);
      }
    }
  });

  it("密 haystack の密度は 60/12 = 5:1 である（識別子ベンチの初期設計と同じ）", () => {
    // 🔴 赤の意味: probe を増やして haystack を据え置くと、密条件は静かに
    // *易しく* なる（probe 1件あたりの「同じ書式の他人」が減るため）。
    // この歯は、その取り違えが黙って起きることを防ぐ。
    expect(DEFAULT_JAPANESE_NAME_DENSE_HAYSTACK_SIZE / JAPANESE_NAME_PROBES.length).toBe(5);
  });

  it("haystack は probe の固有名詞を1つも含まない（疎・密の両方）", () => {
    for (const kind of ["sparse", "dense"] as const) {
      const utterances = buildJapaneseNameProbeSetConversation(undefined, kind);
      const haystack = utterances.filter((u) => u.kind === "haystack").map((u) => u.text);
      expect(findJapaneseNameTopicKeywordViolations(haystack)).toEqual([]);
    }
  });

  it("gold と distractor が両方とも会話に現れる", () => {
    const utterances = buildJapaneseNameProbeSetConversation(undefined, "sparse");
    expect(utterances.filter((u) => u.kind === "gold")).toHaveLength(12);
    expect(utterances.filter((u) => u.kind === "distractor")).toHaveLength(12);
  });

  /**
   * ⭐ ADR 0110 が測った標本の構成を固定する。**順位は一切主張していない。**
   *
   * ADR 0110 は、この12件のうち **gold/distractor が文字列として1文字違いなのは5件**であり、
   * その5件の margin が `−8.0e-5`（`org-b`、最悪）から `+4.85e-2`（`org-c`、**12件中で最良**）まで
   * 全域に散らばっていることを実測した。
   *
   * ⟹ 🔑 **「日本語の1文字違いが引けない」は、この標本に支持されない。**
   * 効いているのは文字数ではなく、`tokenizer` が弁別部分を「単独1文字のトークン1個」に
   * 割るかどうかである（`org-a` の `第一` は1トークンに融合するので通り、
   * `org-b` の `一` は単独で立つので落ちる——**文字レベルの条件は完全に同じ**である）。
   */
  it("gold/distractor が1文字違いなのは5件である（ADR 0110 §2 の標本の形）", () => {
    // 🔴 赤の意味: **この集合の構成が変わった**ということ。とくに `org-b` を易しく
    // 書き換える（例: `開発一課` → `開発1課`）と赤くなる——ADR 0110 §7 案 D が
    // 「却下」とした道を、黙って踏めないようにするためである。⭐ 落ちている1件を
    // 易しくすることは、**測れるようになったものを捨てる**ことである。
    //
    // ⚠ **この歯は「文字数が原因だ」とは主張していない。**主張しているのは
    // 「1文字違いの probe が何件あるか」だけである。原因は弁別トークンが担う文字数
    // （ADR 0110 §5）であって、文字列の編集距離ではない。
    const oneCharDiff: { probeId: string; differingChars: string }[] = [];
    for (const [probeId, keywords] of Object.entries(JAPANESE_NAME_TOPIC_KEYWORDS)) {
      const g = [...(keywords[0] ?? "")];
      const d = [...(keywords[1] ?? "")];
      if (g.length !== d.length) continue;
      const positions = g.map((ch, i) => i).filter((i) => g[i] !== d[i]);
      if (positions.length !== 1) continue;
      const at = positions[0]!;
      oneCharDiff.push({ probeId, differingChars: `${g[at]}/${d[at]}` });
    }
    oneCharDiff.sort((a, b) => a.probeId.localeCompare(b.probeId));

    expect(
      oneCharDiff.map((entry) => entry.probeId),
      "日本語 probe の「1文字違い」の件数が変わった。ADR 0110 §2 は、この5件の margin が " +
        "−8.0e-5（org-b、最悪）から +4.85e-2（org-c、12件中で最良）まで散らばることを実測し、" +
        "「日本語の1文字違いが引けない」という読みを落とした。⟹ この集合を書き換えると、" +
        "その反例（通っている1文字違い4件）が標本から消え、誤った読みが復活しうる。" +
        "⛔ とくに org-b を易しくしないこと（ADR 0110 §7 案 D は却下されている）。",
    ).toEqual(["org-a", "org-b", "org-c", "person-c", "product-a"]);

    // 🔴 こちらが `org-b` を易しくする書き換えを実際に捕まえる歯である。
    // ADR 0110 §5.3 の実測: 同じ位置の1文字を漢字から算用数字・ラテン文字へ替えるだけで
    // ベクトルの変位は 2.2〜2.3 倍になり、`org-b` の margin は −8.0e-5 → +2.70e-2 と
    // **符号が反転する**（＝ probe が通るようになる）。⟹ 弁別する1文字が ASCII に
    // 変わることは「実装が良くなった」ではなく「**問いが易しくなった**」である。
    const asciiDifferences = oneCharDiff.filter((entry) =>
      /[\x20-\x7e]/.test(entry.differingChars.replace("/", "")),
    );
    expect(
      asciiDifferences,
      "1文字違いの probe の、弁別している1文字が ASCII になっている。ADR 0110 §5.3 の実測では、" +
        "同じ位置の漢字1文字を算用数字/ラテン文字へ替えるだけでベクトル変位は 2.2〜2.3 倍になり、" +
        "org-b の margin は −8.0e-5 から +2.70e-2 へ符号が反転する。⟹ この書き換えは probe を" +
        "通るようにするが、それは想起が良くなったのではなく問いが易しくなっただけである。" +
        "⛔ ADR 0110 §7 案 D（却下）を踏んでいる。新しい条件を測りたいなら、既存 probe を" +
        "書き換えるのではなく別の集合を足すこと（PR #192 がまさにその形である）。",
    ).toEqual([]);
  });
});
