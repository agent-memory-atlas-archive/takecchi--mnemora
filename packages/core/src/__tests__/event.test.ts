import { describe, expect, it } from "vitest";
import { MemoryEventSchema, NewMemoryEventSchema } from "../event.js";

function baseEvent() {
  return {
    id: "evt-1",
    tenantId: "tenant-1",
    memoryId: "mem-1",
    kind: "created" as const,
    at: new Date(),
    actor: { type: "system" as const },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
  };
}

describe("MemoryEventSchema", () => {
  it("accepts kind: 'created' で memoryId を持つ通常のイベント", () => {
    expect(MemoryEventSchema.safeParse(baseEvent()).success).toBe(true);
  });

  it("accepts kind: 'events_purged' で memoryId が null", () => {
    const event = { ...baseEvent(), kind: "events_purged" as const, memoryId: null };
    expect(MemoryEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects kind: 'events_purged' で memoryId が non-null（CHECK 制約の型側の表現）", () => {
    const event = { ...baseEvent(), kind: "events_purged" as const, memoryId: "mem-1" };
    expect(MemoryEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects 未知の kind", () => {
    const event = { ...baseEvent(), kind: "renamed" };
    expect(MemoryEventSchema.safeParse(event).success).toBe(false);
  });

  it("accepts kind: 'restored'（Issue #195、ADR 0122）", () => {
    const event = { ...baseEvent(), kind: "restored" as const };
    expect(MemoryEventSchema.safeParse(event).success).toBe(true);
  });
});

describe("NewMemoryEventSchema", () => {
  it("accepts at を省略した入力", () => {
    const { id, at, ...rest } = baseEvent();
    expect(NewMemoryEventSchema.safeParse(rest).success).toBe(true);
  });

  it("rejects events_purged で memoryId が non-null", () => {
    const { id, at, ...rest } = baseEvent();
    const event = { ...rest, kind: "events_purged" as const, memoryId: "mem-1" };
    expect(NewMemoryEventSchema.safeParse(event).success).toBe(false);
  });
});
