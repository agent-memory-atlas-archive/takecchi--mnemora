import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0114: `archiveDecayed` の「`memories.status` の更新と `memory_events` への
 * `kind='archived'` の追記は同一トランザクションである」という主張を、
 * **実際に片方を失敗させて**検査する。
 *
 * `requeue-embed-jobs-atomicity.postgres.test.ts`（ADR 0079）と同じ理由・同じ形——
 * 適合スイート（`packages/testkit/src/memory-store-conformance.ts`）の検査はすべて
 * 正常系であり、実装を「`UPDATE ... RETURNING` を打ってから、別の文で `INSERT`」の
 * 2文へ割る変異は正常系では同じ結果を返す。ここでは `memory_events` への INSERT を
 * 必ず失敗させるトリガーを一時的に作り、`archiveDecayed` が例外で終わったあとに
 * **`memories.status` が `active` のまま巻き戻っている**ことを見る。2文に割った実装なら
 * `UPDATE` だけがコミットされ、Memory は「archived になったのに、それを裏付ける
 * `archived` イベントが1件も無い」——`docs/memory-model.md` §9 が要求する
 * 「削除経路とジャーナルへの追記は同一トランザクション」の不変条件が破れた状態で残る。
 *
 * ⚠ トリガーは `finally` で必ず落とす（`resetTestDatabase()` はスキーマを作り直さない
 * ため、落とし忘れると同じプロセス内で後から走る他のテストファイルまで巻き込む）。
 */

const TENANT = "archive-decayed-atomicity-tenant";
const ctx: Ctx = { tenantId: TENANT };

const CREATE_FAILING_TRIGGER = `
  CREATE OR REPLACE FUNCTION archive_decayed_atomicity_block_insert() RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION 'archive-decayed-atomicity: memory_events insert blocked on purpose';
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER archive_decayed_atomicity_block
    BEFORE INSERT ON memory_events
    FOR EACH ROW EXECUTE FUNCTION archive_decayed_atomicity_block_insert();
`;

const DROP_FAILING_TRIGGER = `
  DROP TRIGGER IF EXISTS archive_decayed_atomicity_block ON memory_events;
  DROP FUNCTION IF EXISTS archive_decayed_atomicity_block_insert();
`;

/**
 * `requeue-embed-jobs-atomicity.postgres.test.ts` の `messageChain` と同一。
 * drizzle の `db.execute()` が投げる例外は `Failed query: <SQL>` という別の `Error` で
 * 包まれ、元の PostgreSQL のメッセージは `cause` 側に入る。
 */
function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return parts.join("\n<- caused by ->\n");
}

describe("archiveDecayed の原子性（ADR 0114）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    const { pool } = await getTestClient();
    // 念のためもう一度落とす（各 it の finally で落としているが、そこへ到達しないまま
    // 落ちた場合に後続のテストファイルへ漏らさないため）。
    await pool.query(DROP_FAILING_TRIGGER);
    await closeTestClient();
  });

  it("memory_events への INSERT が失敗したら、memories.status の更新も巻き戻る（片方だけ起きない）", async () => {
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const now = new Date("2026-06-01T00:00:00.000Z");
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "archive-decayed-atomicity-1",
        decayFloorAt: new Date(now.getTime() - 1_000),
      }),
    );

    await pool.query(CREATE_FAILING_TRIGGER);
    try {
      const error = await store.archiveDecayed(ctx, { now, limit: 10 }).then(
        () => null as unknown,
        (err: unknown) => err,
      );

      expect(messageChain(error)).toMatch(
        /archive-decayed-atomicity: memory_events insert blocked on purpose/,
      );

      // 🔴 ここが本題。UPDATE だけがコミットされていたら status は 'archived' になっている。
      const after = await store.get(ctx, memory.id);
      const events = await pool.query(
        "SELECT count(*)::int AS n FROM memory_events WHERE tenant_id = $1 AND memory_id = $2",
        [TENANT, memory.id],
      );
      expect({
        status: after?.status,
        eventCount: (events.rows[0] as { n: number }).n,
      }).toEqual({ status: "active", eventCount: 0 });
    } finally {
      await pool.query(DROP_FAILING_TRIGGER);
    }
  }, 60_000);

  it("トリガーを落とせば、同じ呼び出しが今度は成功して両方が起きる（上の歯が『常に赤い』のではないことの確認）", async () => {
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const now = new Date("2026-06-01T00:00:00.000Z");
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "archive-decayed-atomicity-2",
        decayFloorAt: new Date(now.getTime() - 1_000),
      }),
    );

    const result = await store.archiveDecayed(ctx, { now, limit: 10 });
    const after = await store.get(ctx, memory.id);
    const events = await pool.query(
      "SELECT kind, digest_snapshot FROM memory_events WHERE tenant_id = $1 AND memory_id = $2",
      [TENANT, memory.id],
    );

    expect({
      archivedIds: result.archived.map((a) => a.memoryId),
      status: after?.status,
      eventRows: events.rows,
    }).toEqual({
      archivedIds: [memory.id],
      status: "archived",
      eventRows: [{ kind: "archived", digest_snapshot: memory.digest }],
    });
  }, 60_000);
});
