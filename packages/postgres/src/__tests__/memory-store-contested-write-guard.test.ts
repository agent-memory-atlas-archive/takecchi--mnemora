import { describe, expect, it } from "vitest";
import { ContestedWithoutCompanionError } from "@mnemora/core";
import type { Ctx, NewMemory, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import type { Db } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";

/**
 * [ADR 0140](../../../../docs/decisions/0140-contested-write-side-companion-required.md)
 * の書き込み側ガードだけを検査する。
 *
 * ⚠ **DB を要求しない。** ガードは `this.db.execute`/`this.db.transaction` を一度も
 * 呼ぶ前に投げる——このファイルの `store` は本物の接続を一切持たない `Db`（型だけ満たす
 * スタブ、実行時には決して参照されない）で構築する。ガードを通過してしまえば必ず
 * `this.db.execute is not a function`（または同種の TypeError）で落ちるので、
 * 「ガードが実際に本体のクエリより先に発火した」ことは、このスタブが素通しされずに
 * 例外の型が {@link ContestedWithoutCompanionError} であることそのもので確認できる。
 *
 * この歯がある理由: `packages/postgres` の変異試験は本物の Postgres + pgvector を
 * 要求する既存の `*.postgres.test.ts`／DB 依存の `*.test.ts` では、この作業環境
 * （`DATABASE_URL` 無し、Issue #247）では一切実行できない。ガード自体は DB に触れる前の
 * 純粋な分岐なので、ここだけは本物の DB 無しで変異試験まで完結できる——
 * 「確かめていない」を無闇に増やさないための意図的な切り出し。
 *
 * ⚠ **このファイルは `packages/postgres` の `test:db`（`vitest run`、DB 必須）経由でしか
 * package.json のスクリプトからは走らない**（`packages/postgres` に非DBの `test` script が
 * 無いため）。手元でDB無しに実行するときは
 * `pnpm --filter @mnemora/postgres exec vitest run src/__tests__/memory-store-contested-write-guard.test.ts`
 * のように、このファイルを名指しで直接 vitest に渡すこと。
 */
const UNREACHABLE_DB = {} as unknown as Db;

const ctx: Ctx = { tenantId: "tenant-1" };

function contestedInput(overrides: Partial<NewMemory> = {}): NewMemory {
  return buildNewMemoryFixture({
    tenantId: "tenant-1",
    status: "contested",
    ...overrides,
  });
}

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

describe("PostgresMemoryStore — ADR 0140 書き込み側ガード（DB 不要）", () => {
  it("createMemory: status='contested' かつ contestedWithId 無し を拒否する", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(store.createMemory(ctx, contestedInput())).rejects.toBeInstanceOf(
      ContestedWithoutCompanionError,
    );
  });

  it("createMemory: status='contested' かつ contestedWithId が null でも拒否する", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(
      store.createMemory(ctx, contestedInput({ contestedWithId: null })),
    ).rejects.toBeInstanceOf(ContestedWithoutCompanionError);
  });

  it("createMemory: status='contested' かつ contestedWithId 有り は素通しする（DB スタブに実際に到達する＝TypeError）", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    // ガードを通過した先で `this.db.execute` を呼ぼうとして落ちる——
    // ContestedWithoutCompanionError ではないことで、ガードが誤って発火していないと分かる。
    await expect(
      store.createMemory(ctx, contestedInput({ contestedWithId: "mem-companion" })),
    ).rejects.not.toBeInstanceOf(ContestedWithoutCompanionError);
  });

  it("createMemory: status='active'（既定）は contestedWithId 無しでも拒否しない（DB スタブに到達する）", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(
      store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" })),
    ).rejects.not.toBeInstanceOf(ContestedWithoutCompanionError);
  });

  it("createMemoryWithOutbox: status='contested' かつ contestedWithId 無し を拒否する", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(
      store.createMemoryWithOutbox(ctx, contestedInput(), ["embed"]),
    ).rejects.toBeInstanceOf(ContestedWithoutCompanionError);
  });

  it("updateStatus: status='contested' への書き込みを常に拒否する", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(store.updateStatus(ctx, "mem-1", "contested")).rejects.toBeInstanceOf(
      ContestedWithoutCompanionError,
    );
  });

  it("updateStatus: status='active'/'archived'/'superseded'/'forgotten' は拒否しない（DB スタブに到達する）", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    for (const status of ["active", "archived", "superseded", "forgotten"] as const) {
      await expect(store.updateStatus(ctx, "mem-1", status)).rejects.not.toBeInstanceOf(
        ContestedWithoutCompanionError,
      );
    }
  });

  it("updateStatusWithEvent: status='contested' への書き込みを常に拒否する", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(
      store.updateStatusWithEvent(ctx, "mem-1", "contested", {}, event("mem-1")),
    ).rejects.toBeInstanceOf(ContestedWithoutCompanionError);
  });

  it("supersedeWithNewMemories: news に1件でも status='contested' かつ contestedWithId 無し があれば拒否する", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(
      store.supersedeWithNewMemories!(
        ctx,
        [
          { input: buildNewMemoryFixture({ tenantId: "tenant-1" }), jobKinds: [] },
          { input: contestedInput(), jobKinds: [] },
        ],
        [],
      ),
    ).rejects.toBeInstanceOf(ContestedWithoutCompanionError);
  });

  it("supersedeWithNewMemories: news が全件 lone contested でなければ拒否しない（DB スタブに到達する）", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(
      store.supersedeWithNewMemories!(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: "tenant-1" }), jobKinds: [] }],
        [],
      ),
    ).rejects.not.toBeInstanceOf(ContestedWithoutCompanionError);
  });
});
