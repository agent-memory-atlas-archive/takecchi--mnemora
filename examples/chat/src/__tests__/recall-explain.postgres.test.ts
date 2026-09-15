import { afterAll, describe, expect, it } from "vitest";
import { runRecallExplainDemo } from "../recall-explain.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `examples/chat/src/recall-explain.ts` の歯——`Runtime.getRecall`（Issue #312、
 * ADR 0161）が、`recall()` の戻り値からは分からない「後から」を実際に満たすことを、
 * 本物の Postgres に対して検査する。
 *
 * provider は `@mnemora/testkit` の決定的な擬似実装（`scope.postgres.test.ts` と
 * 同じ規約——`env: {}` を渡して deterministic モードを強制する）。DB は擬似物で
 * 代替しない。
 */
describe("examples/chat: explain（Runtime.getRecall、本物の Postgres）", () => {
  it(
    "recall() が返した recallId を getRecall で引き直すと、recall() の返り値と同じ" +
      "memoryId 集合が、スコア内訳つきで読み戻せる",
    async () => {
      await resetTestDatabase();
      await getTestClient();
      const handle = await createExampleRuntime(requireDatabaseUrl(), {});
      try {
        expect(handle.mode).toBe("deterministic");
        const result = await runRecallExplainDemo(
          handle.runtime,
          handle.memoryStore,
          "example-chat-explain-test",
        );

        // 前提: そもそも recall() が返した記憶が0件でないこと
        // （0件のまま比較すると「集合が一致する」が無意味な緑になる）。
        expect(result.recallResultMemoryIds.length).toBeGreaterThan(0);

        const record = result.record;
        if (!record) {
          throw new Error("getRecall が null を返した — recallId が読み戻せていない");
        }
        expect(record.recallId).toBe(result.recallId);

        const returned = record.returnedMemories;
        expect(returned.breakdownCaptured).toBe(true);
        if (!returned.breakdownCaptured) {
          throw new Error("breakdownCaptured が false — 新規行のはずなのに内訳が無い");
        }

        const fromGetRecall = new Set(returned.memories.map((m) => m.memoryId));
        const fromRecall = new Set(result.recallResultMemoryIds);
        expect(fromGetRecall).toEqual(fromRecall);

        // スコア内訳つきで読み戻せていること（各項の型・retrievedVia の値域）。
        for (const m of returned.memories) {
          expect(typeof m.score.total).toBe("number");
          expect(typeof m.score.decay).toBe("number");
          expect(typeof m.score.tagMatch).toBe("number");
          expect(typeof m.score.freshness).toBe("number");
          expect(typeof m.score.strength).toBe("number");
          expect(["ann", "lexical", "mandatory_companion", "association"]).toContain(
            m.retrievedVia,
          );
        }

        // digest は getRecall からは届かない（ADR 0155 決定1）——別途 memoryStore.get で
        // 引けていることを確認する。
        for (const memoryId of fromGetRecall) {
          expect(result.digestByMemoryId[memoryId]).toBeTruthy();
        }
      } finally {
        await handle.close();
      }
    },
  );

  it("あえて embed させなかった3件目が、omitted に not_indexed(pending) として現れる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const result = await runRecallExplainDemo(
        handle.runtime,
        handle.memoryStore,
        "example-chat-explain-test-omitted",
      );
      const record = result.record;
      if (!record) {
        throw new Error("getRecall が null を返した");
      }
      const pendingOmission = record.omitted.find(
        (o) => o.kind === "not_indexed" && o.reason === "pending",
      );
      expect(pendingOmission).toBeDefined();
    } finally {
      await handle.close();
    }
  });

  it("存在しない recallId で getRecall を呼ぶと null が返る（例外にしない）", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const result = await runRecallExplainDemo(
        handle.runtime,
        handle.memoryStore,
        "example-chat-explain-test-missing",
      );
      expect(result.missingRecord).toBeNull();
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
