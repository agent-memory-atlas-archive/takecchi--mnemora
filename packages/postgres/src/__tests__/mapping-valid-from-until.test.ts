import { describe, expect, it } from "vitest";
import { rowToMemory, type MemoryRow } from "../mapping.js";

/**
 * `rowToMemory`（`../mapping.ts`）が `valid_from`/`valid_until`（Issue #202、ADR 0145）を
 * `Date`/`null` へ正しく変換することを検査する歯。
 *
 * ⚠ **DB を要求しない。** `rowToMemory` は純関数（DB 接続を一切持たない、
 * `MemoryRow` → `Memory` の変換だけを行う）であり、`memory-store-contested-write-guard.test.ts`
 * の doc コメントが説明する族——「本物の Postgres + pgvector を要求する既存の
 * `*.postgres.test.ts`／DB 依存の `*.test.ts` では、この作業環境（`DATABASE_URL` 無し、
 * Issue #247）では一切実行できない」——には当たらない。ただし `packages/postgres` は
 * `test:db`（DB 必須）以外の plain `test` script を持たないため（`package.json` 参照）、
 * このファイルも `pnpm run test`（ルート）経由では実行されない。
 *
 * ⚠ **手元でDB無しに実行するときは、このファイルを名指しで直接 vitest に渡すこと**
 * （`memory-store-contested-write-guard.test.ts` と同じ理由・同じ手順）:
 * `pnpm --filter @mnemora/postgres exec vitest run src/__tests__/mapping-valid-from-until.test.ts`
 */

function baseRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    tenant_id: "tenant-1",
    subject_id: null,
    source_observation_id: null,
    extractor_version: null,
    content: "本文",
    content_hash: "hash-1",
    digest: "digest",
    digest_source: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    status: "active",
    superseded_by_id: null,
    contested_with_id: null,
    tags: [],
    occurred_at: null,
    recorded_at: "2026-01-01 00:00:00+00",
    last_reinforced_at: null,
    valid_from: null,
    valid_until: null,
    strength: 1,
    half_life_hours: 720,
    decay_floor_at: "2026-06-01 00:00:00+00",
    embedding_status: "pending",
    purged_at: null,
    created_at: "2026-01-01 00:00:00+00",
    updated_at: "2026-01-01 00:00:00+00",
    ...overrides,
  };
}

describe("rowToMemory — valid_from/valid_until（Issue #202、ADR 0145）", () => {
  it("valid_from/valid_until が非 null なら Date に変換する", () => {
    const memory = rowToMemory(
      baseRow({
        valid_from: "2025-01-01 00:00:00+00",
        valid_until: "2025-12-31 23:59:59+00",
      }),
    );
    expect(memory.validFrom).toBeInstanceOf(Date);
    expect(memory.validUntil).toBeInstanceOf(Date);
    expect(memory.validFrom?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(memory.validUntil?.toISOString()).toBe("2025-12-31T23:59:59.000Z");
  });

  it("valid_from/valid_until が null なら null のまま返す", () => {
    const memory = rowToMemory(baseRow({ valid_from: null, valid_until: null }));
    expect(memory.validFrom).toBeNull();
    expect(memory.validUntil).toBeNull();
  });

  it("occurred_at と valid_from/valid_until を混同しない — 3つの列がそれぞれ独立に変換される", () => {
    const memory = rowToMemory(
      baseRow({
        occurred_at: "2024-06-01 00:00:00+00",
        valid_from: "2025-01-01 00:00:00+00",
        valid_until: "2025-12-31 23:59:59+00",
      }),
    );
    expect(memory.occurredAt?.toISOString()).toBe("2024-06-01T00:00:00.000Z");
    expect(memory.validFrom?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(memory.validUntil?.toISOString()).toBe("2025-12-31T23:59:59.000Z");
  });
});
