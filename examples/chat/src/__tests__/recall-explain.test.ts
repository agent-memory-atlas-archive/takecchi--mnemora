import { describe, expect, it } from "vitest";
import type { RecallRecord } from "@mnemora/core";
import { formatRecallExplainDemo, type RecallExplainDemoResult } from "../recall-explain.js";

/**
 * `src/recall-explain.ts` の整形関数（`formatRecallExplainDemo`）の純粋な検査。
 * **DB を要求しない**——`RecallRecord` は手で組み立てたフィクスチャであり、
 * `runtime.getRecall`/`memoryStore.get` を一度も呼ばない（`scope.ts` に
 * `scope.postgres.test.ts` しか無いのとは違い、こちらは整形ロジックそのものを
 * DB 無しで検査できる形にしてある）。
 */

function baseRecord(overrides: Partial<RecallRecord> = {}): RecallRecord {
  return {
    recallId: "11111111-1111-4111-8111-111111111111",
    tenantId: "tenant-1",
    subjectId: null,
    query: { text: "好きな食べ物と趣味は何ですか?" },
    budget: null,
    omitted: [],
    usage: {
      chars: 42,
      estimatedTokens: 11,
      counter: "heuristic",
      byTier: { full: 42, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 2, countKind: "exact" },
    explain: { stages: [{ stage: "scope", executed: true }] },
    returnedMemories: { breakdownCaptured: true, memories: [] },
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
    ...overrides,
  };
}

function baseResult(overrides: Partial<RecallExplainDemoResult> = {}): RecallExplainDemoResult {
  return {
    tenantId: "tenant-1",
    recallId: "11111111-1111-4111-8111-111111111111",
    recallResultMemoryIds: [],
    record: baseRecord(),
    missingRecallId: "22222222-2222-4222-8222-222222222222",
    missingRecord: null,
    digestByMemoryId: {},
    ...overrides,
  };
}

describe("formatRecallExplainDemo", () => {
  it("breakdownCaptured: false を「内訳を持たない」と名指しで印字し、0や空に潰さない", () => {
    const result = baseResult({
      record: baseRecord({
        returnedMemories: {
          breakdownCaptured: false,
          memories: [{ memoryId: "memory-old" }],
        },
      }),
    });

    const output = formatRecallExplainDemo(result);

    expect(output).toContain("breakdownCaptured: false");
    expect(output).toContain("内訳を持たない");
    // ⛔ 内訳を「0」に読み替えていないこと——スコアの数値表現(例: "total=0")が
    // この行に紛れ込んでいないことを確認する。
    expect(output).not.toMatch(/total=0\.000/);
    // memoryId 自体は(内訳が無くても)表示されること。
    expect(output).toContain("memory-old");
    expect(output).toContain("(内訳なし)");
  });

  it("見つからない recall(null)を「見つからなかった」と名指しで印字する", () => {
    const result = baseResult({
      record: null,
      missingRecord: null,
    });

    const output = formatRecallExplainDemo(result);

    const occurrences = output.match(/見つからなかった/g) ?? [];
    // record 側・missingRecord 側の両方で1回ずつ出る。
    expect(occurrences.length).toBe(2);
    // 0件・空とは別の文言であること。
    expect(output).not.toMatch(/^0件$/m);
  });

  it("スコア内訳の各項目(similarity/lexicalMatch/decay/tagMatch/freshness/strength/total)が出る", () => {
    const result = baseResult({
      record: baseRecord({
        returnedMemories: {
          breakdownCaptured: true,
          memories: [
            {
              memoryId: "memory-1",
              retrievedVia: "ann",
              score: {
                similarity: 0.9,
                lexicalMatch: 0.5,
                decay: 0.8,
                tagMatch: 1,
                freshness: 0.7,
                strength: 1,
                total: 0.6,
              },
            },
          ],
        },
      }),
      digestByMemoryId: { "memory-1": "好きな食べ物はカレーです。" },
    });

    const output = formatRecallExplainDemo(result);

    expect(output).toContain("similarity=0.900");
    expect(output).toContain("lexicalMatch=0.500");
    expect(output).toContain("decay=0.800");
    expect(output).toContain("tagMatch=1.000");
    expect(output).toContain("freshness=0.700");
    expect(output).toContain("strength=1.000");
    expect(output).toContain("total=0.600");
    expect(output).toContain("好きな食べ物はカレーです。");
    expect(output).toContain("via=ann");
  });

  it("companionOf/associationOf が在るときだけ表示に出る", () => {
    const withCompanion = formatRecallExplainDemo(
      baseResult({
        record: baseRecord({
          returnedMemories: {
            breakdownCaptured: true,
            memories: [
              {
                memoryId: "memory-1",
                retrievedVia: "mandatory_companion",
                companionOf: "memory-2",
                score: {
                  decay: 1,
                  tagMatch: 1,
                  freshness: 1,
                  strength: 1,
                  total: 1,
                },
              },
            ],
          },
        }),
      }),
    );
    expect(withCompanion).toContain("companionOf=memory-2");

    const withoutCompanion = formatRecallExplainDemo(baseResult());
    expect(withoutCompanion).not.toContain("companionOf=");
  });

  it("omitted の内容(なぜ落ちたか)を印字する", () => {
    const result = baseResult({
      record: baseRecord({
        omitted: [{ kind: "not_indexed", reason: "pending", count: 1, countKind: "exact" }],
      }),
    });

    const output = formatRecallExplainDemo(result);

    expect(output).toContain("not_indexed");
    expect(output).toContain("pending");
  });
});
