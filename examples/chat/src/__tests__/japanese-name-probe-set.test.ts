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
});
