import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import {
  buildNewMemoryFixture,
  buildNewObservationFixture,
  buildProvenanceFixture,
} from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * Issue #273 / ADR 0182: `memories_provenance_kind_matches_provenance`
 * （`migrations/0016_provenance_kind_matches_provenance.sql` /
 * `0017_provenance_kind_matches_provenance_validate.sql`）が、実際に
 * `provenance_kind` 列と `provenance->>'kind'`（jsonb）の一致を守ることを検査する。
 *
 * この歯は `packages/testkit` の conformance suite には乗らない——`provenanceKind` は
 * `MemoryStore` インターフェース（core の `Memory` 型）に出てこず（`mapping.ts` の
 * `rowToMemory` が読み戻していない）、adapter 非依存の適合テストからはこの列自体が
 * 見えないため（Issue #273 の調査結果）。`packages/postgres` 固有の歯としてここに置く。
 *
 * **⚠ CI（postgres ジョブ）でしか走らない。** `DATABASE_URL` が無い作業環境では
 * `requireDatabaseUrl()`（`getTestClient()` 経由）が例外を投げ、テストランナー自体が
 * 起動しない（Issue #247 と同じ制約）。
 */
describe("memories_provenance_kind_matches_provenance", () => {
  const ctx: Ctx = { tenantId: "tenant-1" };

  it("実際の書き込み経路（createMemory / createMemoryWithOutbox / supersedeWithNewMemories）は、いずれも一致した行しか作らない", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);

    const observation = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: "tenant-1" }),
    );

    // createMemory: stated（実在の observation を要求する kind）
    const stated = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: "tenant-1",
        contentHash: "hash-stated",
        sourceObservationId: observation.id,
        provenance: {
          kind: "stated",
          sourceObservationId: observation.id,
          at: new Date().toISOString(),
        },
      }),
    );
    expect(stated.provenance.kind).toBe("stated");

    // createMemoryWithOutbox: inferred
    const { memory: inferred } = await store.createMemoryWithOutbox(
      ctx,
      buildNewMemoryFixture({
        tenantId: "tenant-1",
        contentHash: "hash-inferred",
        sourceObservationId: observation.id,
        provenance: {
          kind: "inferred",
          model: "test-model",
          promptVersion: "v1",
          basis: { memoryIds: [], observationIds: [observation.id] },
          confidence: 0.5,
        },
      }),
      [],
    );
    expect(inferred.provenance.kind).toBe("inferred");

    // supersedeWithNewMemories: consolidated（news 側）
    const target = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "hash-target" }),
    );
    const { created } = await store.supersedeWithNewMemories(
      ctx,
      [
        {
          input: buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "hash-consolidated",
            provenance: buildProvenanceFixture("consolidated"),
          }),
          jobKinds: [],
        },
      ],
      [
        {
          id: target.id,
          supersededByIndex: 0,
          expectedStatus: "active",
          event: {
            tenantId: "tenant-1",
            memoryId: target.id,
            kind: "superseded",
            actor: { type: "system" },
            digestSnapshot: "digest",
            meta: {},
          },
        },
      ],
    );
    expect(created[0]?.memory.provenance.kind).toBe("consolidated");

    // 生 SQL で「列 provenance_kind」と「jsonb provenance->>'kind'」が全行で一致していることを
    // 直接確認する（アプリの型を経由せず、DB の実データを見る）。
    const { pool } = await getTestClient();
    const { rows } = await pool.query<{ mismatched: string }>(`
      SELECT count(*)::text AS mismatched FROM memories
      WHERE tenant_id = 'tenant-1' AND provenance_kind <> (provenance->>'kind')
    `);
    expect(rows[0]?.mismatched).toBe("0");
  });

  it("生 SQL で provenance_kind と provenance->>'kind' がずれた行を INSERT しようとすると reject される", async () => {
    await resetTestDatabase();
    const { pool } = await getTestClient();

    await expect(
      pool.query(`
        INSERT INTO memories (
          id, tenant_id, source_observation_id, extractor_version,
          content, content_hash, digest, digest_source,
          provenance_kind, provenance,
          status, tags,
          recorded_at,
          strength, half_life_hours, decay_floor_at,
          embedding_status,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(), 'tenant-1', NULL, NULL,
          'content', 'hash-mismatch', 'digest', 'llm',
          'consolidated', '{"kind":"imported","batchId":"b"}'::jsonb,
          'active', '{}',
          now(),
          1, 720, now(),
          'pending',
          now(), now()
        )
      `),
    ).rejects.toThrow(/memories_provenance_kind_matches_provenance/);
  });

  it("生 SQL で既存行を UPDATE してずらそうとしても reject される（今日 UPDATE 経路は無いが、将来足されても DB 側で拒否される）", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: "tenant-1",
        contentHash: "hash-update-guard",
        provenance: buildProvenanceFixture("imported"),
      }),
    );

    await expect(
      pool.query(`UPDATE memories SET provenance_kind = 'consolidated' WHERE id = $1`, [memory.id]),
    ).rejects.toThrow(/memories_provenance_kind_matches_provenance/);

    await expect(
      pool.query(
        `UPDATE memories SET provenance = '{"kind":"consolidated","sources":["x"]}'::jsonb WHERE id = $1`,
        [memory.id],
      ),
    ).rejects.toThrow(/memories_provenance_kind_matches_provenance/);
  });
});
