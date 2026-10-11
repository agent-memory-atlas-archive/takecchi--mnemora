import { describe, expect, it } from "vitest";
import { ObserveInputSchema } from "../observation.js";

const ok = (input: unknown) => ObserveInputSchema.safeParse(input).success;
const BLANK = "   ";

describe("本文以外の欄は、空白だけの文字列も受け付ける（ADR 0502 の範囲の外）", () => {
  it.each([
    ["utterance.subjectId", { kind: "utterance", text: "t", subjectId: BLANK }],
    ["utterance.externalId", { kind: "utterance", text: "t", externalId: BLANK }],
    ["event.subjectId", { kind: "event", name: "n", subjectId: BLANK }],
    ["event.externalId", { kind: "event", name: "n", externalId: BLANK }],
    ["document.subjectId", { kind: "document", content: "c", subjectId: BLANK }],
    ["document.externalId", { kind: "document", content: "c", externalId: BLANK }],
    [
      "memory_usage.externalId",
      { kind: "memory_usage", recallId: "r", usedMemoryIds: ["m"], externalId: BLANK },
    ],
    ["memory_usage.recallId", { kind: "memory_usage", recallId: BLANK, usedMemoryIds: ["m"] }],
    [
      "memory_usage.usedMemoryIds の要素",
      { kind: "memory_usage", recallId: "r", usedMemoryIds: [BLANK] },
    ],
    [
      "utterance.subjectCandidates の要素",
      { kind: "utterance", text: "t", subjectCandidates: [BLANK] },
    ],
  ])("%s", (_name, input) => {
    expect(ok(input)).toBe(true);
  });

  it("対照: 同じ欄でも、空文字は断る", () => {
    expect(ok({ kind: "utterance", text: "t", subjectId: "" })).toBe(false);
    expect(ok({ kind: "memory_usage", recallId: "", usedMemoryIds: ["m"] })).toBe(false);
  });
});

// `Ctx` の TSDoc（ctx.ts）が「observe の入力 schema は、次の欄の空文字を ZodError にする」と挙げた欄。
describe("observe の入力の、空文字を断ると約束した欄", () => {
  it.each([
    ["utterance.subjectId", { kind: "utterance", text: "t", subjectId: "" }],
    ["utterance.externalId", { kind: "utterance", text: "t", externalId: "" }],
    ["utterance.speaker", { kind: "utterance", text: "t", speaker: "" }],
    ["event.subjectId", { kind: "event", name: "n", subjectId: "" }],
    ["event.externalId", { kind: "event", name: "n", externalId: "" }],
    ["document.subjectId", { kind: "document", content: "c", subjectId: "" }],
    ["document.externalId", { kind: "document", content: "c", externalId: "" }],
    ["document.title", { kind: "document", content: "c", title: "" }],
    [
      "memory_usage.externalId",
      { kind: "memory_usage", recallId: "r", usedMemoryIds: ["m"], externalId: "" },
    ],
    ["memory_usage.recallId", { kind: "memory_usage", recallId: "", usedMemoryIds: ["m"] }],
    [
      "memory_usage.usedMemoryIds の要素",
      { kind: "memory_usage", recallId: "r", usedMemoryIds: [""] },
    ],
    [
      "utterance.subjectCandidates の要素",
      { kind: "utterance", text: "t", subjectCandidates: [""] },
    ],
  ])("%s が空文字なら断る", (_name, input) => {
    expect(ok(input)).toBe(false);
  });
});
