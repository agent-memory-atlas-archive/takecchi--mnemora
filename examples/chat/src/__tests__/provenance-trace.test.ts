import { describe, expect, it } from "vitest";
import type { Ctx, Memory, MemoryStore, Observation } from "@mnemora/core";
import { resultContainsObservation } from "../provenance-trace.js";

/**
 * Issue #496 完了条件3: 「同じ出典から答えの情報を欠く digest を作るケースで、出典到達が
 * 情報保持の証明ではないことを示す」。
 *
 * `resultContainsObservation`/`resolveExternalId`（`../provenance-trace.js`）は
 * `Memory.digest` を一切読まない——`memoryId → Memory.sourceObservationId →
 * Observation.externalId` だけを辿る。この歯は、そのことを**digest の中身を実際に
 * 変えて**固定する: 答えの情報を欠く digest と、答えをそのまま含む digest の両方に
 * 同じ `sourceObservationId` を持たせ、**どちらでも到達判定が true になる**ことを示す
 * （＝出典到達は情報保持の証明ではない）。
 *
 * ⭐ 陽性対照（答えを含む digest でも true）と陰性対照（別の出典なら false）を
 * 同じ検査の中に置く——「true が出た」だけでは、この探り棒が実際に区別している
 * ものが出典だけであることを示せない（`docs/autonomy.md` §2.2 の3番）。
 *
 * DB を使わない純粋な in-memory fake（`examples/chat/src/__tests__/compare-decay-clock.test.ts`
 * と同じ最小の偽物の作法）。`@mnemora/testkit` の `InMemoryMemoryStore` は
 * `packages/testkit/src/index.ts` が意図的に export していない
 * （プレースホルダ実装は公開 API ではない）ため、ここでは `get`/`getObservation` の
 * 2メソッドだけを持つ最小の fake を自分で組み立てる。
 */

const ctx: Ctx = { tenantId: "provenance-trace-test" };

const TARGET_EXTERNAL_ID = "ext-fact-statement";
const OTHER_EXTERNAL_ID = "ext-unrelated";

function buildFakeMemoryStore(
  memories: Record<string, Pick<Memory, "sourceObservationId"> & { digest: string }>,
  observations: Record<string, Pick<Observation, "externalId">>,
): MemoryStore {
  return {
    get: async (_ctx: Ctx, id: string) => {
      const m = memories[id];
      if (!m) return null;
      return { id, digest: m.digest, sourceObservationId: m.sourceObservationId } as Memory;
    },
    getObservation: async (_ctx: Ctx, id: string) => {
      const o = observations[id];
      if (!o) return null;
      return { id, externalId: o.externalId } as Observation;
    },
  } as unknown as MemoryStore;
}

describe("resultContainsObservation: 出典到達は digest の中身に依らない（Issue #496）", () => {
  it("答えの情報を欠く digest・答えをそのまま含む digest・別の出典の3件を並べ、区別しているのが出典だけであることを示す", async () => {
    const memoryStore = buildFakeMemoryStore(
      {
        // 陽性1（本題）: 要約に失敗し、答えの情報を一切持たない digest。
        // それでも sourceObservationId は正しい出典を指す。
        "mem-info-lost": {
          digest: "[要約失敗。内容は保持していません]",
          sourceObservationId: "obs-target",
        },
        // 陽性対照: 答え（「青」）をそのまま含む digest。同じ出典を指す。
        "mem-info-kept": {
          digest: "私の好きな色は青です。",
          sourceObservationId: "obs-target",
        },
        // 陰性対照: digest は答えを含むが、出典が別の Observation を指す。
        "mem-other-source": {
          digest: "私の好きな色は青です。",
          sourceObservationId: "obs-other",
        },
      },
      {
        "obs-target": { externalId: TARGET_EXTERNAL_ID },
        "obs-other": { externalId: OTHER_EXTERNAL_ID },
      },
    );

    // 陽性1: 情報を欠く digest でも、出典が一致すれば true。
    // ⟹ 出典到達は「情報が残った」ことの証明ではない（本題）。
    await expect(
      resultContainsObservation(
        memoryStore,
        ctx,
        [{ memoryId: "mem-info-lost" }],
        TARGET_EXTERNAL_ID,
      ),
    ).resolves.toBe(true);

    // 陽性対照: 答えを含む digest でも結果は変わらず true。
    // ⟹ digest の中身が判定に影響していないことの確認（関数が本当に digest を
    //   見ていないことの裏付け）。
    await expect(
      resultContainsObservation(
        memoryStore,
        ctx,
        [{ memoryId: "mem-info-kept" }],
        TARGET_EXTERNAL_ID,
      ),
    ).resolves.toBe(true);

    // 陰性対照: 同じ「答えを含む digest」でも、出典が別なら false。
    // ⟹ この探り棒が実際に区別しているのは出典であり、何にでも true を返す
    //   壊れた探り棒ではないことの確認。
    await expect(
      resultContainsObservation(
        memoryStore,
        ctx,
        [{ memoryId: "mem-other-source" }],
        TARGET_EXTERNAL_ID,
      ),
    ).resolves.toBe(false);
  });
});
