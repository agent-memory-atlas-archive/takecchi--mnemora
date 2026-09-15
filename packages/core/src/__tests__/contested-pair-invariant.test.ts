import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryId } from "../ids.js";
import type { Memory, MemoryStatus, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `contested` の対向関係（`docs/memory-model.md` §5 機構2・機構3）が**一対一**である、
 * という前提を測る。ADR 0046。
 *
 * ⚠ **ここで固定するのは「破れた入力が来たときの振る舞い」ではない。**
 * 「破れているかどうか」を測れる形にするだけである——`recall()` が壊れた鎖に対して
 * 何を返すべきかは `contested` を作る主体が入る Phase 2 の判断であり、ここでは決めない。
 *
 * ⚠ **この検査器は本番コードではない。**`packages/core/src` の公開 API には足していない。
 * 本番の呼び出し元が無い関数を輸出することは、ADR 0024 の「実装の無いものを『予約』と書き残さない」に
 * 反する。測るための道具は測る場所に置く。
 */
type ContestedInvariantViolation =
  /** `status = 'contested'` なのに対向を指していない。⟹ 単独で返され、機構2 が破れる。 */
  | { kind: "contested_without_opposite"; memoryId: MemoryId }
  /** 対向を指しているのに `status` が `contested` でない。 */
  | { kind: "opposite_without_contested_status"; memoryId: MemoryId; status: MemoryStatus }
  /** 対向として指された id が、渡された集合に存在しない。 */
  | { kind: "opposite_missing"; memoryId: MemoryId; oppositeId: MemoryId }
  /** 自分自身を対向として指している。 */
  | { kind: "opposite_is_self"; memoryId: MemoryId }
  /** 対向が指し返していない（鎖 A→B→C はこの形で捕まる）。 */
  | {
      kind: "opposite_not_mutual";
      memoryId: MemoryId;
      oppositeId: MemoryId;
      oppositePointsTo: MemoryId | null;
    }
  /** 同じ対向を2件以上が指している。⟹ 一対一ではない。 */
  | { kind: "opposite_shared"; memoryId: MemoryId; oppositeId: MemoryId; claimedBy: MemoryId[] };

/**
 * 集合の中で、`contested` の一対一が破れている箇所を全部返す。破れていなければ空配列。
 *
 * **1件の Memory が複数の破れ方を同時に持つことがある**（例: 対向を指しているが `status` が
 * `contested` でなく、かつ対向も指し返していない）。**その場合は両方返す。**
 * 片方に丸めると、直した側だけを見て「直った」と読めてしまう。
 *
 * ⚠ **`opposite_not_mutual` は「指し返していない」であって「指し先が無い」ではない。**
 * 指し先が集合に無い場合は `opposite_missing` が先に立ち、`opposite_not_mutual` は出さない
 * ——`undefined` を「別の誰かを指している」と読み替えないため。
 */
function findContestedPairViolations(memories: readonly Memory[]): ContestedInvariantViolation[] {
  const byId = new Map(memories.map((m) => [m.id, m]));
  const claimants = new Map<MemoryId, MemoryId[]>();
  for (const m of memories) {
    if (m.contestedWithId) {
      claimants.set(m.contestedWithId, [...(claimants.get(m.contestedWithId) ?? []), m.id]);
    }
  }

  const violations: ContestedInvariantViolation[] = [];
  for (const m of memories) {
    const oppositeId = m.contestedWithId ?? null;
    if (m.status === "contested" && oppositeId === null) {
      violations.push({ kind: "contested_without_opposite", memoryId: m.id });
    }
    if (oppositeId === null) continue;

    if (m.status !== "contested") {
      violations.push({
        kind: "opposite_without_contested_status",
        memoryId: m.id,
        status: m.status,
      });
    }
    if (oppositeId === m.id) {
      violations.push({ kind: "opposite_is_self", memoryId: m.id });
      continue;
    }
    const opposite = byId.get(oppositeId);
    if (opposite === undefined) {
      violations.push({ kind: "opposite_missing", memoryId: m.id, oppositeId });
    }
    // ⚠ `opposite` が居ないときに `null !== m.id` を「指し返していない」と読ませない。
    // 存在の判定を条件から外すと**この歯が赤くなる**（`TypeError` ではなく、
    // 「出してはいけない違反を出した」というアサーションで落ちる）。
    const oppositePointsTo = opposite === undefined ? null : (opposite.contestedWithId ?? null);
    if (opposite !== undefined && oppositePointsTo !== m.id) {
      violations.push({
        kind: "opposite_not_mutual",
        memoryId: m.id,
        oppositeId,
        oppositePointsTo,
      });
    }
    const others = claimants.get(oppositeId) ?? [];
    if (others.length > 1) {
      violations.push({ kind: "opposite_shared", memoryId: m.id, oppositeId, claimedBy: others });
    }
  }
  return violations;
}

const NOW = new Date("2026-01-01T00:00:00.000Z");

/** 検査器の歯のための `Memory`。**store を通さない**——測りたいのは検査器であって store ではない。 */
function memoryFixture(overrides: Partial<Memory> & { id: MemoryId }): Memory {
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `content-${overrides.id}`,
    contentHash: `hash-${overrides.id}`,
    digest: `digest-${overrides.id}`,
    digestSource: "llm",
    provenance: { kind: "stated", sourceObservationId: "obs-1", at: NOW.toISOString() },
    status: "active",
    supersededById: null,
    contestedWithId: null,
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "ready",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * `runtime.markContested` の歯のための、まだ何とも対向していない `active` な `NewMemory`。
 * `store.createMemory` へそのまま渡せる（`memoryFixture` は完成済みの `Memory` を返すため
 * `createMemory` の入力型 `NewMemory` とは形が違う——ここでは別に用意する）。
 */
function newActiveMemory(digest: string): NewMemory {
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `content-${digest}`,
    contentHash: `hash-${digest}`,
    digest,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
  };
}

/** 破れていない対向ペア。**両側が互いを指し、両側とも `contested`。** */
function mutualPair(): Memory[] {
  return [
    memoryFixture({ id: "mem-a", status: "contested", contestedWithId: "mem-b" }),
    memoryFixture({ id: "mem-b", status: "contested", contestedWithId: "mem-a" }),
  ];
}

describe("contested の一対一（ADR 0046）— 不変条件そのものを測る", () => {
  it("🔴 破れていない対向ペアには何も出ない（空振りしていないことを同時に確かめる）", () => {
    const memories = mutualPair();
    // ⚠ 「空配列だった」だけでは、検査器が何も見ていない場合と区別できない。
    // 対向を持つ Memory が実際に2件在ることを、同じ歯の中で確かめる。
    expect(memories.filter((m) => m.contestedWithId !== null)).toHaveLength(2);
    expect(findContestedPairViolations(memories)).toEqual([]);
  });

  it("🔴 contested なのに対向を指していない Memory を捕まえる", () => {
    // ⚠ これは**現に repo 内の fixture が持っている形**である
    // （`recall-pipeline.test.ts` の `setupContestedPair` の b 側）。
    // 段3は「候補として見つかった側」から対向を辿るので、b 単独で候補になると
    // 対向が取られないまま返る——機構2（単独で返してはならない）が破れる。
    const memories = [
      memoryFixture({ id: "mem-a", status: "contested", contestedWithId: "mem-b" }),
      memoryFixture({ id: "mem-b", status: "contested" }),
    ];
    expect(findContestedPairViolations(memories)).toContainEqual({
      kind: "contested_without_opposite",
      memoryId: "mem-b",
    });
  });

  it("🔴 対向を指しているのに status が contested でない Memory を捕まえる", () => {
    const memories = [
      memoryFixture({ id: "mem-a", status: "active", contestedWithId: "mem-b" }),
      memoryFixture({ id: "mem-b", status: "contested", contestedWithId: "mem-a" }),
    ];
    expect(findContestedPairViolations(memories)).toContainEqual({
      kind: "opposite_without_contested_status",
      memoryId: "mem-a",
      status: "active",
    });
  });

  it("🔴 集合に存在しない id を対向として指している Memory を捕まえる", () => {
    const memories = [
      memoryFixture({ id: "mem-a", status: "contested", contestedWithId: "mem-missing" }),
    ];
    expect(findContestedPairViolations(memories)).toContainEqual({
      kind: "opposite_missing",
      memoryId: "mem-a",
      oppositeId: "mem-missing",
    });
  });

  it("🔴 対向が居ないときに『指し返していない』とは言わない（別の誰かを指していると読み替えない）", () => {
    // ⚠ `byId.get()` の `undefined` を「指し返していない」に潰すと、
    // **存在しない**と**指し先が違う**が同じ顔になる。次の一手が違う（前者は参照整合性、
    // 後者は対向の張り替え）ので、潰してはいけない区別である（ADR 0008 の判定基準）。
    const violations = findContestedPairViolations([
      memoryFixture({ id: "mem-a", status: "contested", contestedWithId: "mem-missing" }),
    ]);
    expect(violations.some((v) => v.kind === "opposite_not_mutual")).toBe(false);
  });

  it("🔴 自分自身を対向として指している Memory を捕まえる", () => {
    // ⚠ 自己参照は**相互性の検査を素通りする**（自分が自分を指し返しているため）。
    // 専用の判定が要る、という前提をここで固定する。
    const violations = findContestedPairViolations([
      memoryFixture({ id: "mem-a", status: "contested", contestedWithId: "mem-a" }),
    ]);
    expect(violations).toContainEqual({ kind: "opposite_is_self", memoryId: "mem-a" });
    expect(violations.some((v) => v.kind === "opposite_not_mutual")).toBe(false);
  });

  it("🔴 鎖 A→B→C を捕まえる（対向が指し返していない）", () => {
    const memories = [
      memoryFixture({ id: "mem-a", status: "contested", contestedWithId: "mem-b" }),
      memoryFixture({ id: "mem-b", status: "contested", contestedWithId: "mem-c" }),
      memoryFixture({ id: "mem-c", status: "contested", contestedWithId: "mem-a" }),
    ];
    const violations = findContestedPairViolations(memories);
    // 3件とも指し返されていない。**1件だけ見て「捕まえた」と言わない。**
    expect(violations).toContainEqual({
      kind: "opposite_not_mutual",
      memoryId: "mem-a",
      oppositeId: "mem-b",
      oppositePointsTo: "mem-c",
    });
    expect(violations.filter((v) => v.kind === "opposite_not_mutual")).toHaveLength(3);
  });

  it("🔴 同じ対向を2件が指している状態を捕まえる（一対一ではない）", () => {
    const memories = [
      memoryFixture({ id: "mem-a", status: "contested", contestedWithId: "mem-c" }),
      memoryFixture({ id: "mem-b", status: "contested", contestedWithId: "mem-c" }),
      memoryFixture({ id: "mem-c", status: "contested", contestedWithId: "mem-a" }),
    ];
    const violations = findContestedPairViolations(memories);
    expect(violations).toContainEqual({
      kind: "opposite_shared",
      memoryId: "mem-b",
      oppositeId: "mem-c",
      claimedBy: ["mem-a", "mem-b"],
    });
    // ⚠ 相互性だけでは捕まらない側を持つ形にしてある——`mem-a` と `mem-c` は
    // 互いを指しており、相互性の検査は通る。**それでも一対一ではない。**
    expect(violations.some((v) => v.kind === "opposite_not_mutual" && v.memoryId === "mem-a")).toBe(
      false,
    );
  });
});

const ctx: Ctx = { tenantId: "tenant-1" };

function llmReturning(contents: string[]): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_c: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse({
        memories: contents.map((content) => ({
          content,
          digest: content.slice(0, 8),
          provenanceKind: "stated" as const,
        })),
      }) as T,
  };
}

describe("contested の一対一（ADR 0046）— Runtime を一巡させても破れない", () => {
  it("🔴 observe → tick → reextract で作られた Memory は、一対一を破らない", async () => {
    // ⚠ **この歯が Phase 1 で見ているのは「破れていないこと」だけであり、**
    // **「`contested` が作られること」は見ていない。**`observe`/`tick`/`reextract` は
    // 今日も `contested` を一切書かないので、対向関係の枝は通らない
    // （Issue #197 / ADR 0134 で `Runtime.markContested` が追加された後も、この3つの
    // 経路自体は変わっていない——下の describe を参照）。
    //
    // **⟹ それを「Runtime は contested を書かない」という歯にはしない。**
    // その前提が変わるのは事故ではなく**予定**（矛盾検出。Issue #197 で実際に変わった）
    // であり、予定で赤くなる歯は、実装してはいけないという意味になってしまう。
    // ここで固定するのは「`contested` を作る主体が入っても、作られた対向関係は一対一である」
    // という契約のほうである。
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmReturning(["体を動かすのが好き", "水泳が苦手"]),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });

    const observed = await runtime.observe(ctx, { kind: "utterance", text: "運動の話をした" });
    await runtime.tick(ctx, { leaseMs: 60_000 });
    const reextracted = await runtime.reextract(ctx, observed.observationId);

    const ids = [
      ...observed.memoryIds,
      ...reextracted.memoryIds,
      ...reextracted.supersededMemoryIds,
    ];
    const memories = await stores.memoryStore.getMany(ctx, [...new Set(ids)]);
    // ⚠ 空振り防止。Runtime が1件も作っていなければ、下の期待は何も見ていない。
    expect(memories.length).toBeGreaterThan(0);
    expect(findContestedPairViolations(memories)).toEqual([]);
  });
});

describe("contested の一対一（ADR 0046）— Issue #197 / ADR 0134: markContested が作る対向は一対一を破らない", () => {
  it("🔴 runtime.markContested で作った相互ペアは、検査器が『破れていない』側として認める形と一致する", async () => {
    // ⚠ ADR 0046 の「出たこと2」——「相互ペア A↔B は、公開 interface の組み合わせでは
    // 構成できない」——を、本 PR がここで初めて覆す。この歯は、`mutualPair()`（この
    // ファイル冒頭、手作りの fixture）と**同じ形**を、`Runtime` を実際に一巡させて
    // 作れることを確かめる。手作りの fixture との違いは、これは店を経由した本物の
    // 書き込みであるという点だけである。
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmReturning(["体を動かすのが好き", "水泳が苦手"]),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });

    const a = await stores.memoryStore.createMemory(ctx, newActiveMemory("A"));
    const b = await stores.memoryStore.createMemory(ctx, newActiveMemory("B"));

    const result = await runtime.markContested(ctx, a.id, b.id);
    expect(result).toEqual({
      supported: true,
      outcome: { kind: "contested", first: expect.anything(), second: expect.anything() },
    });

    const memories = await stores.memoryStore.getMany(ctx, [a.id, b.id]);
    expect(memories).toHaveLength(2);
    expect(memories.every((m) => m.status === "contested")).toBe(true);
    expect(memories.find((m) => m.id === a.id)?.contestedWithId).toBe(b.id);
    expect(memories.find((m) => m.id === b.id)?.contestedWithId).toBe(a.id);
    // ⟹ 検査器そのもの（この PR は変更していない）が、これを「破れていない」と認める。
    expect(findContestedPairViolations(memories)).toEqual([]);
  });
});
