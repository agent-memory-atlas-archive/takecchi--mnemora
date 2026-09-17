import type { Ctx, MemoryStore } from "@mnemora/core";

/**
 * `recall()` が返した Memory が、どの Observation から生まれたかを辿る
 * （経緯: ADR 0052。文字列一致からこの系譜追跡へ置き換えた理由はそちらを見る）。
 *
 * 🔴 **この関数が証明するのは、出典への到達だけである**（`docs/autonomy.md` §2.2 の2番、
 * ADR 0224）。**`digest` の中身は一切見ない**——要約で答えの情報が失われていても、
 * `sourceObservationId` を辿って同じ `externalId` に着けば true になる。⟹ **「情報が
 * 残った」「全文なしで答えられた」ことの証明には使えない。**その区別と、情報保持・
 * 回答正誤を測る側の設計は
 * [ADR 0226](../../../docs/decisions/0226-compare-provenance-reached-vs-information-retained.md)
 * を見ること。
 *
 * 使う経路は**公開 interface だけ**である:
 *
 *   `recall().memories[i].memoryId`
 *     → `memoryStore.get(ctx, memoryId)`
 *     → `Memory.sourceObservationId`
 *     → `memoryStore.getObservation(ctx, sourceObservationId)`
 *     → `Observation.externalId`
 *
 * 辿れないケース（`sourceObservationId` が無い、`getObservation` が null）は `null` を返す
 * ——**辿れないことを黙って別の何かに読み替えない**（文字列一致へのフォールバックはしない）。
 */
export async function resolveExternalId(
  memoryStore: MemoryStore,
  ctx: Ctx,
  memoryId: string,
): Promise<string | null> {
  const memory = await memoryStore.get(ctx, memoryId);
  if (!memory || !memory.sourceObservationId) {
    return null;
  }
  const observation = await memoryStore.getObservation(ctx, memory.sourceObservationId);
  return observation?.externalId ?? null;
}

/**
 * `recall()` の結果に、指定した `externalId` の Observation 由来の Memory が
 * 含まれているかを判定する。
 *
 * **provider が擬似か本物かに依らない。**digest の中身を一切見ないため、
 * 記録の再生（ADR 0051）でも実 API でも、同じ意味の判定になる。
 *
 * 🔴 **ただし「同じ意味の判定」とは「出典に到達したかの判定」という意味である。**
 * `resolveExternalId` の docstring の通り、これは出典到達だけを見る——情報保持・
 * 回答正誤は測らない（`docs/autonomy.md` §2.2 の2番、ADR 0224、ADR 0226）。
 */
export async function resultContainsObservation(
  memoryStore: MemoryStore,
  ctx: Ctx,
  memories: readonly { memoryId: string }[],
  externalId: string,
): Promise<boolean> {
  for (const memory of memories) {
    if ((await resolveExternalId(memoryStore, ctx, memory.memoryId)) === externalId) {
      return true;
    }
  }
  return false;
}
