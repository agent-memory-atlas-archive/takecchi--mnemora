import { describe, expect, it } from "vitest";
import { compareScoredCandidates } from "../recall-runtime.js";
import type { ScoreBreakdown } from "../recall.js";

/**
 * 段2（再スコア）の並び順（`recall-runtime.ts` の `scored.sort`）のタイブレーク
 * （Issue #339 / ADR 0170）。
 *
 * **背景**: `Array.prototype.sort` は安定（ES2019+）——`score.total` が同点のとき、
 * 明示のタイブレークが無ければ入力配列の順序（= adapter が返した順序）をそのまま
 * 保つ。⭐門 `compare`（`examples/chat`）の 322 ターン行で、`PostgresVectorStore`
 * の ANN 検索が返す重複コンテンツ（同じ filler 文を大量に使い回す合成会話）の
 * 完全な distance タイが、`memory_id`（fresh ingest のたびに振り直されるランダムな
 * UUID）に依存する並びを透過させ、`recall()` の結果を ingest のたびに変えていた
 * （Issue #339）。`compareScoredCandidates` は、`packages/core` 自身がこれに
 * 依存しないよう明示のタイブレークを持つ。
 *
 * `ScoredCandidate` の最小の作り方は `threshold-partition.test.ts` の
 * `candidate()` ヘルパーと同じ作法（型は export していないので `as unknown as
 * Parameters<...>[0]` で組み立てる）。
 */

function candidate(
  id: string,
  total: number,
  opts: { occurredAt?: Date | null; recordedAt: Date },
): Parameters<typeof compareScoredCandidates>[0] {
  const score: ScoreBreakdown = { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total };
  return {
    memory: {
      id,
      occurredAt: opts.occurredAt ?? null,
      recordedAt: opts.recordedAt,
    },
    retrievedVia: "ann",
    score,
  } as unknown as Parameters<typeof compareScoredCandidates>[0];
}

describe("compareScoredCandidates（Issue #339 / ADR 0170）", () => {
  it("score.total が違えば、それだけで決まる（高い方が先）", () => {
    const higher = candidate("higher", 0.9, { recordedAt: new Date("2026-01-01T00:00:00Z") });
    const lower = candidate("lower", 0.1, { recordedAt: new Date("2026-01-02T00:00:00Z") });
    // recordedAt は逆向き（lower の方が新しい）でも、score.total が優先される。
    expect(compareScoredCandidates(higher, lower)).toBeLessThan(0);
    expect(compareScoredCandidates(lower, higher)).toBeGreaterThan(0);
  });

  it("score.total が同点なら、実効時刻（occurredAt ?? recordedAt）が新しい方を先にする", () => {
    const older = candidate("older", 0.5, { recordedAt: new Date("2026-01-01T00:00:00Z") });
    const newer = candidate("newer", 0.5, { recordedAt: new Date("2026-01-02T00:00:00Z") });
    // 入力の順序に関わらず、常に newer が先に来ることを両方向で確認する
    // （Array.prototype.sort に丸投げしていないことの直接証拠）。
    expect(compareScoredCandidates(older, newer)).toBeGreaterThan(0);
    expect(compareScoredCandidates(newer, older)).toBeLessThan(0);
    const sorted = [older, newer].sort(compareScoredCandidates);
    expect(sorted.map((c) => c.memory.id)).toEqual(["newer", "older"]);
    const sortedReverseInput = [newer, older].sort(compareScoredCandidates);
    expect(sortedReverseInput.map((c) => c.memory.id)).toEqual(["newer", "older"]);
  });

  it("occurredAt が在ればそちらを実効時刻として使う（recordedAt は無視する）", () => {
    // occurredAt が同じなら、recordedAt が逆向きでも同点 → id にフォールバックする。
    const a = candidate("a-id", 0.5, {
      occurredAt: new Date("2020-06-01T00:00:00Z"),
      recordedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const b = candidate("b-id", 0.5, {
      occurredAt: new Date("2020-06-01T00:00:00Z"),
      recordedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const sorted = [b, a].sort(compareScoredCandidates);
    // occurredAt が完全一致 ⟹ id の昇順（a-id が先）にフォールバックする。
    expect(sorted.map((c) => c.memory.id)).toEqual(["a-id", "b-id"]);
  });

  it("score.total も実効時刻も同点なら、memory.id の昇順にフォールバックする（最終手段）", () => {
    const sameTime = new Date("2026-01-01T00:00:00Z");
    const z = candidate("zzz", 0.5, { recordedAt: sameTime });
    const a = candidate("aaa", 0.5, { recordedAt: sameTime });
    const sorted = [z, a].sort(compareScoredCandidates);
    expect(sorted.map((c) => c.memory.id)).toEqual(["aaa", "zzz"]);
  });
});
