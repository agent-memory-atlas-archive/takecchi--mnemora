import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import type { Db } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";

/**
 * `PostgresMemoryStore.resolveContestedPair`（Issue #197、ADR 0150）の、**DB に触れる前**
 * の書き込み前ガードだけを検査する。`memory-store-contested-write-guard.test.ts`
 * （ADR 0140 の書き込み側ガード）と同じ形——この作業環境（`DATABASE_URL` 無し）では
 * `*.postgres.test.ts`／`conformance.postgres.test.ts` が一切実行できないため、
 * DB に触れる前の純粋な分岐だけをここで切り出して検査する。
 *
 * ⚠ **`resolveContestedPair` の CAS・トランザクション・SQL そのものの正しさはここでは
 * 検査しない。**それは `memory-store-conformance.ts` の `resolveContestedPair` 節
 * （`supportsResolveContestedPair: true` で `conformance.postgres.test.ts` から実行される）
 * が担う——**本物の Postgres が無いこの環境では未実行のまま**である（`AGENTS.md`・
 * 本ファイルの検査対象外）。
 *
 * ⚠ このファイルは `packages/postgres` の `test:db`（`vitest run`、DB 必須）経由でしか
 * package.json のスクリプトからは走らない（`memory-store-contested-write-guard.test.ts`
 * と同じ理由）。手元で DB 無しに実行するときは
 * `pnpm --filter @mnemora/postgres exec vitest run src/__tests__/resolve-contested-pair-guard.test.ts`
 * のように、このファイルを名指しで直接 vitest に渡すこと。
 */
const UNREACHABLE_DB = {} as unknown as Db;

const ctx: Ctx = { tenantId: "tenant-1" };

function event(memoryId: string): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    digestSnapshot: "digest",
    meta: {},
  };
}

describe("PostgresMemoryStore.resolveContestedPair — 書き込み前ガード（DB 不要）", () => {
  it("first.id === second.id は RangeError を投げ、DB には一切触れない（DB スタブに到達すれば TypeError になるはずが、そうならない）", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    const id = randomUUID();

    await expect(
      store.resolveContestedPair!(
        ctx,
        { id, status: "active", event: event(id) },
        { id, status: "active", event: event(id) },
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("first.id が UUID の形でなければ「memory not found」を投げ、DB には一切触れない", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    const badId = "not-a-uuid";
    const goodId = randomUUID();

    await expect(
      store.resolveContestedPair!(
        ctx,
        { id: badId, status: "active", event: event(badId) },
        { id: goodId, status: "superseded", supersededById: badId, event: event(goodId) },
      ),
    ).rejects.toThrow(/memory not found for tenant/);
  });

  it("second.id が UUID の形でなければ「memory not found」を投げ、DB には一切触れない", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    const goodId = randomUUID();
    const badId = "not-a-uuid";

    await expect(
      store.resolveContestedPair!(
        ctx,
        { id: goodId, status: "active", event: event(goodId) },
        { id: badId, status: "active", event: event(badId) },
      ),
    ).rejects.toThrow(/memory not found for tenant/);
  });

  it("両側とも id が UUID の形をしていて first.id !== second.id なら、ガードを素通しして DB スタブに実際に到達する（RangeError でも「memory not found」でもない失敗になる）", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    const first = randomUUID();
    const second = randomUUID();

    const rejection = expect(
      store.resolveContestedPair!(
        ctx,
        { id: first, status: "active", event: event(first) },
        { id: second, status: "superseded", supersededById: first, event: event(second) },
      ),
    ).rejects;
    await rejection.not.toBeInstanceOf(RangeError);
    await rejection.not.toThrow(/memory not found for tenant/);
  });
});
