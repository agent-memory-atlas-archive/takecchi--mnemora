import { describe, expect, it } from "vitest";
import { parseBenchChannels } from "../retrieval-quality.js";

/**
 * `MNEMORA_BENCH_CHANNELS` のパース(純関数。ADR 0148、Issue #179)。
 *
 * **既定は `undefined`**(=呼び出し側は `channels` を渡さず、`packages/core` 自身の
 * 既定 `["ann"]` に委ねる)——`consolidation-cost-options.test.ts` と同じ作法で、
 * 「未指定なら既定値、不正な値なら例外」を検査する。
 */
describe("parseBenchChannels", () => {
  it("未指定(undefined)なら undefined を返す(既定構成のまま1バイトも変えない)", () => {
    expect(parseBenchChannels(undefined)).toBeUndefined();
  });

  it("空文字なら undefined を返す", () => {
    expect(parseBenchChannels("")).toBeUndefined();
  });

  it("空白だけの文字列も undefined を返す", () => {
    expect(parseBenchChannels("   ")).toBeUndefined();
  });

  it("'ann' 単独をそのまま1要素の配列として返す", () => {
    expect(parseBenchChannels("ann")).toEqual(["ann"]);
  });

  it("'ann,lexical' をカンマ区切りで配列にする", () => {
    expect(parseBenchChannels("ann,lexical")).toEqual(["ann", "lexical"]);
  });

  it("各要素の前後の空白を trim する", () => {
    expect(parseBenchChannels(" ann , lexical ")).toEqual(["ann", "lexical"]);
  });

  it("'lexical' 単独も許す(ann を含めない構成も選べる)", () => {
    expect(parseBenchChannels("lexical")).toEqual(["lexical"]);
  });

  it("RECALL_CHANNELS に無い値が混ざっていたら例外(黙って無視しない)", () => {
    expect(() => parseBenchChannels("ann,recent")).toThrow(/MNEMORA_BENCH_CHANNELS/);
    expect(() => parseBenchChannels("annn")).toThrow(/MNEMORA_BENCH_CHANNELS/);
  });
});
