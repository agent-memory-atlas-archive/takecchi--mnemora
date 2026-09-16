import { describe, expect, it } from "vitest";
import {
  VALIDITY_PROBES,
  buildValidityConversation,
  currentExternalId,
  historicalValidAt,
  otherExternalId,
} from "../validity-probe-set.js";

/**
 * 純関数だけを検査する（`time-term-arm.test.ts` と同型）。**⛔ DB も provider も
 * 使わない**——`buildValidityConversation`/`VALIDITY_PROBES`/`historicalValidAt` という
 * 「仕組み」だけを検査する。recall() を実際に走らせる検査は
 * `validity.postgres.test.ts`（本物の Postgres、Issue #280）の側に置く。
 */

describe("buildValidityConversation", () => {
  it("current/other の text は厳密に等しい（ペアの本文を同一にすることがこの arm の要）", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    for (const probe of VALIDITY_PROBES) {
      const [current, other] = buildValidityConversation(probe, now);
      expect(current!.text).toBe(other!.text);
      expect(current!.text).toBe(probe.fact);
    }
  });

  it("externalId は current/other で違う（externalId 規約どおり）", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    const [current, other] = buildValidityConversation(VALIDITY_PROBES[0]!, now);
    expect(current!.externalId).toBe(currentExternalId(VALIDITY_PROBES[0]!.id));
    expect(other!.externalId).toBe(otherExternalId(VALIDITY_PROBES[0]!.id));
    expect(current!.externalId).not.toBe(other!.externalId);
  });

  it("validFrom/validUntil は now から daysAgo 日ぶんだけ正しく引かれる（正=過去）", () => {
    const now = new Date("2026-09-08T12:00:00.000Z");
    const probe = VALIDITY_PROBES.find((p) => p.id === "address")!;
    const [current, other] = buildValidityConversation(probe, now);
    // current: validFrom 30日前・validUntil 無し。
    expect(current!.validFrom).toEqual(new Date("2026-08-09T12:00:00.000Z"));
    expect(current!.validUntil).toBeUndefined();
    // other: validFrom 365日前・validUntil 30日前。
    expect(other!.validFrom).toEqual(new Date("2025-09-08T12:00:00.000Z"));
    expect(other!.validUntil).toEqual(new Date("2026-08-09T12:00:00.000Z"));
  });

  it("daysAgo が負の probe では未来の Date になる（daysAgo 規約: 正で過去、負で未来）", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    const probe = VALIDITY_PROBES.find((p) => p.id === "subscription-plan")!;
    const [, other] = buildValidityConversation(probe, now);
    // other: validFrom は -30（30日後）。
    expect(other!.validFrom).toEqual(new Date("2026-10-08T00:00:00.000Z"));
    expect(other!.validFrom!.getTime()).toBeGreaterThan(now.getTime());
  });

  it("daysAgo が null の欄は undefined になる（validFrom/validUntil を渡さない、と同値）", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    const probe = VALIDITY_PROBES.find((p) => p.id === "address")!;
    const [current] = buildValidityConversation(probe, now);
    expect(current!.validUntil).toBeUndefined();
  });
});

describe("historicalValidAt", () => {
  it("historicalValidAtDaysAgo を持つ probe は Date を返す", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    const probe = VALIDITY_PROBES.find((p) => p.id === "address")!;
    expect(probe.historicalValidAtDaysAgo).toBeDefined();
    const at = historicalValidAt(probe, now);
    expect(at).toEqual(new Date("2026-05-31T00:00:00.000Z"));
  });

  it("historicalValidAtDaysAgo を持たない probe は undefined を返す", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    const probe = VALIDITY_PROBES.find((p) => p.id === "subscription-plan")!;
    expect(probe.historicalValidAtDaysAgo).toBeUndefined();
    expect(historicalValidAt(probe, now)).toBeUndefined();
  });

  it("『address』probe の historicalValidAt では other が真・current がまだ真になっていない（受け入れ条件1の前提）", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    const probe = VALIDITY_PROBES.find((p) => p.id === "address")!;
    const at = historicalValidAt(probe, now)!;
    const [current, other] = buildValidityConversation(probe, now);

    // other: validFrom <= at < validUntil（真であるべき）。
    expect(other!.validFrom!.getTime()).toBeLessThanOrEqual(at.getTime());
    expect(other!.validUntil!.getTime()).toBeGreaterThan(at.getTime());
    // current: validFrom > at（まだ真になっていないべき）。
    expect(current!.validFrom!.getTime()).toBeGreaterThan(at.getTime());
  });
});

describe("VALIDITY_PROBES", () => {
  it("fact は probe ごとに先頭40字が衝突しない（DeterministicLLMProvider の digest 切り出しと同じ注意、time-term-probe-set.ts 参照）", () => {
    const prefixes = VALIDITY_PROBES.map((p) => p.fact.slice(0, 40));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("otherReason は 'expired'/'not_yet_valid' のどちらも少なくとも1 probe が持つ（決定3の2値が両方とも実際に生成される経路を持つことの前提）", () => {
    const reasons = new Set(VALIDITY_PROBES.map((p) => p.otherReason));
    expect(reasons.has("expired")).toBe(true);
    expect(reasons.has("not_yet_valid")).toBe(true);
  });
});
