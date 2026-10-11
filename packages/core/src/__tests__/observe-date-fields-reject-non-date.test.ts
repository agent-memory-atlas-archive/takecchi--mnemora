import { describe, expect, it } from "vitest";
import { ObserveInputSchema } from "../observation.js";

// `Observation.occurredAt` の TSDoc: 「schema は `Date` であることしか検査しない」。`validFrom`・`validUntil` も
// 同じ扱い（`Observation.validFrom` の doc）。日時の文字列や数を `Date` へ読み替えて通すことはしない。

const ok = (input: unknown) => ObserveInputSchema.safeParse(input).success;
const BASES = {
  utterance: { kind: "utterance", text: "t" },
  event: { kind: "event", name: "n" },
  document: { kind: "document", content: "c" },
} as const;
const FIELDS = ["occurredAt", "validFrom", "validUntil"] as const;
const CASES = Object.entries(BASES).flatMap(([kind, base]) =>
  FIELDS.map((field) => [`${kind}.${field}`, base, field] as const),
);

describe("observe の入力の日時の欄は Date だけを受け付ける", () => {
  it.each(CASES)("%s は Date なら受け付ける", (_name, base, field) => {
    expect(ok({ ...base, [field]: new Date("2026-01-01T00:00:00.000Z") })).toBe(true);
  });

  it.each(CASES)("%s は日時の文字列なら断る", (_name, base, field) => {
    expect(ok({ ...base, [field]: "2026-01-01T00:00:00.000Z" })).toBe(false);
  });

  it.each(CASES)("%s はエポックミリ秒の数なら断る", (_name, base, field) => {
    expect(ok({ ...base, [field]: Date.UTC(2026, 0, 1) })).toBe(false);
  });
});
