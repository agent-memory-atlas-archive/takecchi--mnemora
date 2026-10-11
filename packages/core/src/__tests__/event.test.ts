import { describe, expect, it } from "vitest";
import {
  EventActorSchema,
  EventFilterSchema,
  MemoryEventSchema,
  NewMemoryEventSchema,
} from "../event.js";

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

// 以下は event.ts の TSDoc が書いている振る舞い。
describe("event の schema は TSDoc のとおりに受け付け、断る", () => {
  // `EventActor.type`: `"human"`・`"clone"` は呼び出し側が申告する公開の値。
  it.each(["human", "system", "clone"] as const)(
    "EventActorSchema は type: %s を受け付ける",
    (type) => {
      expect(EventActorSchema.safeParse({ type }).success).toBe(true);
      expect(
        MemoryEventSchema.safeParse({ ...baseEvent(), actor: { type, id: "who" } }).success,
      ).toBe(true);
    },
  );

  // `MemoryEvent.memoryId`: 「ほかの kind でも null は拒まない」「MemoryEventSchema も通る」。
  it("MemoryEventSchema は events_purged 以外の kind の memoryId: null も受け付ける", () => {
    expect(MemoryEventSchema.safeParse({ ...baseEvent(), memoryId: null }).success).toBe(true);
  });

  // `MemoryEvent.meta`: 値の中身は検査しない。core 自身も id の配列を入れる。
  it("MemoryEventSchema は meta の値が文字列でなくても受け付ける", () => {
    const meta = { reason: "r", memoryIds: ["mem-1", "mem-2"], count: 2, nested: { ok: true } };
    expect(MemoryEventSchema.safeParse({ ...baseEvent(), meta }).success).toBe(true);
  });

  // `EventFilterSchema`: limit: 0 を拒む。負数・非整数は store も例外にする（schema はもちろん拒む）。
  it.each([
    ["1", 1, true],
    ["0", 0, false],
    ["-1", -1, false],
    ["1.5", 1.5, false],
  ])("EventFilterSchema の limit: %s", (_label, limit, accepted) => {
    expect(EventFilterSchema.safeParse({ limit }).success).toBe(accepted);
  });
});
