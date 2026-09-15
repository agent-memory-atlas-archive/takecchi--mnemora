import { describe, expect, it } from "vitest";
import { DEFAULT_HAYSTACK_SIZE, buildHaystackUtterance } from "../probe-set.js";
import type { ProbeUtterance } from "../probe-set.js";
import {
  ASSOCIATION_PROBES,
  ASSOCIATION_QUERY_KEYWORDS,
  associationAnchorExternalId,
  associationDistractorExternalId,
  associationGoldExternalId,
  associationHaystackExternalId,
  buildAssociationProbeSetConversation,
  findAssociationBridgeViolations,
  findAssociationQueryLeakViolations,
  ASSOCIATION_HAYSTACK,
  ASSOCIATION_HAYSTACK_SIZE,
} from "../association-probe-set.js";

/**
 * Issue #291: 連想枠 probe set 自体の整合性(DB もネットワークも要らない)。
 *
 * ⚠ `ASSOCIATION_PROBES`(bridge/query/anchor/gold/distractor)は逐語であり検算済み
 * ——ここでは1文字も変えず、`identifier-probe-set.test.ts` と同じ形で「実際にそう
 * なっているか」だけを確認する。
 */
describe("association-probe-set", () => {
  it("12件、カテゴリが4件ずつ(ascii-id/proper-noun/common-noun)", () => {
    expect(ASSOCIATION_PROBES).toHaveLength(12);
    const counts: Record<string, number> = {};
    for (const probe of ASSOCIATION_PROBES) {
      counts[probe.category] = (counts[probe.category] ?? 0) + 1;
    }
    expect(counts).toEqual({ "ascii-id": 4, "proper-noun": 4, "common-noun": 4 });
  });

  it("probe id は重複しない", () => {
    const ids = ASSOCIATION_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("query は gold と bridge を共有しない(三角形の前提: query ≉ gold)", () => {
    for (const probe of ASSOCIATION_PROBES) {
      expect(probe.query.includes(probe.bridge)).toBe(false);
    }
  });

  it("anchor と gold は bridge を共有する(三角形の前提: anchor ≈ gold)", () => {
    for (const probe of ASSOCIATION_PROBES) {
      expect(probe.anchor.includes(probe.bridge)).toBe(true);
      expect(probe.gold.includes(probe.bridge)).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // externalId 関数の形
  // ---------------------------------------------------------------------------

  it("externalId 関数は assoc-<kind>-<id> / assoc-filler-NNNN の規約に従う", () => {
    expect(associationGoldExternalId("ascii-project")).toBe("assoc-gold-ascii-project");
    expect(associationAnchorExternalId("ascii-project")).toBe("assoc-anchor-ascii-project");
    expect(associationDistractorExternalId("ascii-project")).toBe("assoc-distractor-ascii-project");
    expect(associationHaystackExternalId(0)).toBe("assoc-filler-0000");
    expect(associationHaystackExternalId(12)).toBe("assoc-filler-0012");
  });

  // ---------------------------------------------------------------------------
  // 会話の組み立て
  // ---------------------------------------------------------------------------

  it("buildAssociationProbeSetConversation(): 既定の haystackSize で 12×3 + haystackSize = 96件", () => {
    const utterances = buildAssociationProbeSetConversation();
    expect(DEFAULT_HAYSTACK_SIZE).toBe(60);
    expect(utterances).toHaveLength(ASSOCIATION_PROBES.length * 3 + DEFAULT_HAYSTACK_SIZE);
    expect(utterances).toHaveLength(96);
  });

  it("buildAssociationProbeSetConversation(4): anchor/gold/distractor の externalId・kind・text が probe と対応する", () => {
    const utterances = buildAssociationProbeSetConversation(4);
    expect(utterances).toHaveLength(ASSOCIATION_PROBES.length * 3 + 4);
    for (const probe of ASSOCIATION_PROBES) {
      const anchor = utterances.find((u) => u.externalId === associationAnchorExternalId(probe.id));
      const gold = utterances.find((u) => u.externalId === associationGoldExternalId(probe.id));
      const distractor = utterances.find(
        (u) => u.externalId === associationDistractorExternalId(probe.id),
      );
      expect(anchor?.text).toBe(probe.anchor);
      expect(anchor?.kind).toBe("anchor");
      expect(anchor?.probeId).toBe(probe.id);
      expect(gold?.text).toBe(probe.gold);
      expect(gold?.kind).toBe("gold");
      expect(distractor?.text).toBe(probe.distractor);
      expect(distractor?.kind).toBe("distractor");
    }
    expect(utterances.some((u) => u.externalId === associationHaystackExternalId(0))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 歯1: bridge の漏れ(findAssociationBridgeViolations)——変異試験
  // ---------------------------------------------------------------------------

  describe("findAssociationBridgeViolations(歯1)", () => {
    it("正しい入力(実際の会話)では0件", () => {
      const utterances = buildAssociationProbeSetConversation(4);
      expect(findAssociationBridgeViolations(utterances)).toEqual([]);
    });

    it("bridge を漏らした発話を混ぜると違反を報告する(検査自体が機能することの確認)", () => {
      const utterances = buildAssociationProbeSetConversation(4);
      const leaking: ProbeUtterance = {
        externalId: "leak-test-0001",
        text: "PROJ-1234 の話が別の場所でも出ました。",
        kind: "haystack",
      };
      const violations = findAssociationBridgeViolations([...utterances, leaking]);
      expect(violations.length).toBeGreaterThan(0);
      expect(
        violations.some(
          (v) =>
            v.bridge === "PROJ-1234" &&
            v.probeId === "ascii-project" &&
            v.index === utterances.length,
        ),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 歯2: query の語彙漏れ(findAssociationQueryLeakViolations)——変異試験
  //
  // この関数は引数を取らない(`ASSOCIATION_PROBES`/`ASSOCIATION_QUERY_KEYWORDS` 自身から
  // 導く純関数)。⟹ 変異試験は、対象の probe の keyword 一覧を一時的に書き換えて
  // (実行後に必ず元へ戻す)行う——`ASSOCIATION_PROBES`/`ASSOCIATION_QUERY_KEYWORDS` の
  // 実データそのものは1件も書き換えない(このファイルの外へ持ち出さない一時的な変更)。
  // ---------------------------------------------------------------------------

  describe("findAssociationQueryLeakViolations(歯2)", () => {
    it("正しい入力(実際の ASSOCIATION_PROBES/ASSOCIATION_QUERY_KEYWORDS)では0件", () => {
      expect(findAssociationQueryLeakViolations()).toEqual([]);
    });

    it("query の内容語が gold に漏れていれば違反を報告する(検査自体が機能することの確認)", () => {
      const probeId = "ascii-project";
      const probe = ASSOCIATION_PROBES.find((p) => p.id === probeId);
      expect(probe).toBeDefined();
      const leakingKeyword = "顧客名";
      // 前提: このキーワードは実際に gold に含まれる(壊れた前提で検査したのでは
      // 何も証明しない)。
      expect(probe!.gold.includes(leakingKeyword)).toBe(true);

      const mutableKeywords = ASSOCIATION_QUERY_KEYWORDS as Record<string, string[]>;
      const original = mutableKeywords[probeId];
      mutableKeywords[probeId] = [...(original ?? []), leakingKeyword];
      try {
        const violations = findAssociationQueryLeakViolations();
        expect(violations).toContainEqual({ probeId, keyword: leakingKeyword, gold: probe!.gold });
      } finally {
        mutableKeywords[probeId] = original as string[];
      }

      // 元に戻したことの確認(後続テスト・他ファイルへ影響を残さない)。
      expect(findAssociationQueryLeakViolations()).toEqual([]);
    });
  });
});

describe("ASSOCIATION_HAYSTACK(専用 haystack) — なぜ buildHaystackUtterance を使わないか", () => {
  it("60件あり、1件も重複していない", () => {
    expect(ASSOCIATION_HAYSTACK_SIZE).toBe(60);
    expect(ASSOCIATION_HAYSTACK).toHaveLength(60);
    expect(new Set(ASSOCIATION_HAYSTACK).size).toBe(60);
  });

  it("⭐ probe-set.ts のテンプレート生成 haystack を1件も使っていない", () => {
    // 🔴 これが破れると、連想枠のプールがテンプレート由来の密なクラスタで
    // 埋まり、測りたいもの(設計した anchor→gold の枝)が枠に入れなくなる。
    // CI の実測(commit 4a4f014)で現に起きた退化である
    // (詳細は ASSOCIATION_HAYSTACK の docstring)。
    const templated = new Set(Array.from({ length: 200 }, (_, i) => buildHaystackUtterance(i)));
    for (const text of ASSOCIATION_HAYSTACK) {
      expect(templated.has(text)).toBe(false);
    }
  });

  it("⭐ 会話の haystack は ASSOCIATION_HAYSTACK から来ている(生成器から来ていない)", () => {
    const conversation = buildAssociationProbeSetConversation();
    const haystackTexts = conversation.filter((u) => u.kind === "haystack").map((u) => u.text);
    expect(haystackTexts).toHaveLength(60);
    for (const text of haystackTexts) {
      expect(ASSOCIATION_HAYSTACK).toContain(text);
    }
  });
});
