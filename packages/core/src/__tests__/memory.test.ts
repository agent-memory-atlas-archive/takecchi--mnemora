import { describe, expect, it } from "vitest";
import {
  DigestSourceSchema,
  EmbeddingStatusSchema,
  isStrengthInRange,
  MAX_STRENGTH,
  MemorySchema,
  MemoryStatusSchema,
  NewMemorySchema,
} from "../memory.js";

function validMemory() {
  return {
    id: "mem-1",
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: "obs-1",
    extractorVersion: "v1",
    content: "本文",
    contentHash: "abc123",
    digest: "要旨",
    digestSource: "llm" as const,
    provenance: {
      kind: "stated" as const,
      sourceObservationId: "obs-1",
      at: "2026-01-01T00:00:00.000Z",
    },
    status: "active" as const,
    supersededById: null,
    contestedWithId: null,
    tags: ["a", "b"],
    occurredAt: null,
    recordedAt: new Date(),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date(),
    embeddingStatus: "pending" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("MemorySchema", () => {
  it("accepts 完全な Memory", () => {
    expect(MemorySchema.safeParse(validMemory()).success).toBe(true);
  });

  it("rejects halfLifeHours が 0 以下", () => {
    const memory = validMemory();
    memory.halfLifeHours = 0;
    expect(MemorySchema.safeParse(memory).success).toBe(false);
  });

  it("rejects digest が空文字（NOT NULL 制約の型側の表現）", () => {
    const memory = validMemory();
    memory.digest = "";
    expect(MemorySchema.safeParse(memory).success).toBe(false);
  });
});

// `Memory.strength` の値域は `(0, MAX_STRENGTH]`（ADR 0078）。0 は含めない（`status: 'forgotten'` と同じことを言う道を作らない）。
describe("strength の値域は (0, MAX_STRENGTH]", () => {
  it.each([
    ["0", 0, false],
    ["Number.MIN_VALUE", Number.MIN_VALUE, true],
    ["MAX_STRENGTH", MAX_STRENGTH, true],
  ])("%s", (_label, strength, inRange) => {
    expect(isStrengthInRange(strength)).toBe(inRange);

    const memory = validMemory();
    memory.strength = strength;
    expect(MemorySchema.safeParse(memory).success).toBe(inRange);

    const { id, createdAt, updatedAt, status, supersededById, contestedWithId, ...rest } = memory;
    expect(NewMemorySchema.safeParse(rest).success).toBe(inRange);
  });
});

describe("MemoryStatusSchema — 5値すべて", () => {
  for (const status of ["active", "superseded", "contested", "archived", "forgotten"]) {
    it(`accepts '${status}'`, () => {
      expect(MemoryStatusSchema.safeParse(status).success).toBe(true);
    });
  }

  it("rejects 未知の status", () => {
    expect(MemoryStatusSchema.safeParse("deleted").success).toBe(false);
  });
});

describe("EmbeddingStatusSchema — 4値すべて", () => {
  for (const status of ["pending", "ready", "failed", "skipped"]) {
    it(`accepts '${status}'`, () => {
      expect(EmbeddingStatusSchema.safeParse(status).success).toBe(true);
    });
  }

  it("rejects 未知の embeddingStatus", () => {
    expect(EmbeddingStatusSchema.safeParse("unknown").success).toBe(false);
  });
});

describe("DigestSourceSchema — 2値すべて", () => {
  for (const source of ["llm", "fallback"]) {
    it(`accepts '${source}'`, () => {
      expect(DigestSourceSchema.safeParse(source).success).toBe(true);
    });
  }

  it("rejects 未知の digestSource", () => {
    expect(DigestSourceSchema.safeParse("human").success).toBe(false);
  });
});

describe("NewMemorySchema", () => {
  it("accepts status を省略した入力（既定は store 側の責務）", () => {
    const { id, createdAt, updatedAt, status, supersededById, contestedWithId, ...rest } =
      validMemory();
    const result = NewMemorySchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it("rejects contentHash を欠く入力", () => {
    const { id, createdAt, updatedAt, contentHash, ...rest } = validMemory();
    const result = NewMemorySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});
