import { describe, expect, it } from "vitest";
import { CtxSchema } from "../ctx.js";

describe("CtxSchema", () => {
  it("accepts tenantId のみ（subjectId は省略可）", () => {
    const result = CtxSchema.safeParse({ tenantId: "tenant-1" });
    expect(result.success).toBe(true);
  });

  it("accepts tenantId と subjectId の両方", () => {
    const result = CtxSchema.safeParse({ tenantId: "tenant-1", subjectId: "subject-1" });
    expect(result.success).toBe(true);
  });

  it("rejects 空文字の tenantId", () => {
    const result = CtxSchema.safeParse({ tenantId: "" });
    expect(result.success).toBe(false);
  });

  // `Ctx` の TSDoc: 「CtxSchema は min(1) を書いている」（Runtime と store はこの schema で ctx を検査しない）。
  it("rejects 空文字の subjectId", () => {
    const result = CtxSchema.safeParse({ tenantId: "tenant-1", subjectId: "" });
    expect(result.success).toBe(false);
  });

  it("rejects tenantId が無い入力", () => {
    const result = CtxSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
