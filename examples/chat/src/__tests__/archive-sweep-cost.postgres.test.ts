import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { runArchiveSweepCost } from "../archive-sweep-cost.js";
import { createMutableClock } from "../mutable-clock.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `archive-sweep-cost` サブコマンド(Issue #209)を、本物の Postgres + pgvector に対して
 * 実際に走らせる歯。`consolidation-cost.postgres.test.ts` と同じ観点分担:
 *
 * 1. 掃引の前後で store/omitted が実際に動くこと(`deterministic` embedding。速い・
 *    ネットワーク不要)。
 * 2. サブコマンドの配線そのもの(本物の CLI を子プロセスで起動し、
 *    `MNEMORA_ARCHIVE_SWEEP_JSON` が実際に書かれること。`local` embedding)。
 */
describe("archive-sweep-cost: 掃引の前後(deterministic embedding、配線の検査)", () => {
  it("halfLifeHours=1・haystackSize=6で、backdateしたfillerだけが掃かれ、gold/distractorは残る", async () => {
    await resetTestDatabase();
    await getTestClient();
    const clock = createMutableClock();
    const handle = await createExampleRuntime(
      requireDatabaseUrl(),
      { MNEMORA_LLM: "deterministic", MNEMORA_EMBEDDING: "deterministic" },
      {},
      clock,
    );
    try {
      const json = await runArchiveSweepCost({
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        embeddingProvider: handle.embeddingProvider,
        pool: handle.pool,
        clock,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        tenantId: `archive-sweep-cost-test-${Date.now()}`,
        halfLifeHours: 1,
        marginHours: 0.1,
        sweepLimit: 1000,
        budgetLadder: [32, 128],
        recallLimit: 50,
        measuredAt: new Date(),
        commit: null,
        haystackSize: 6,
      });

      expect(json.schemaVersion).toBe(1);
      expect(json.probeCount).toBe(7);
      expect(json.haystackSize).toBe(6);
      expect(json.halfLifeHours).toBe(1);
      expect(json.budgetLadder).toEqual([32, 128]);

      // before: 6 filler + 7 gold + 7 distractor = 20、まだ何も archived になっていない。
      expect(json.before.store.activeCount).toBe(20);
      expect(json.before.store.archivedCount).toBe(0);
      expect(json.before.store.supersededCount).toBe(0);
      expect(json.before.recall.unbudgeted.mean.omittedArchivedCount).toBe(0);
      for (const probe of json.before.recall.unbudgeted.probes) {
        expect(probe.omittedArchivedCount).toBe(0);
      }

      // 受け入れ条件1: 掃引がベンチ実行時間内に実際に発火する(6件のfillerが対象)。
      expect(json.sweep.supported).toBe(true);
      expect(json.sweep.archivedCount).toBe(6);
      expect(json.sweep.reachedLimit).toBe(false);

      // after: activeCount = 14(gold+distractor)、archivedCount = 6。
      expect(json.after.store.activeCount).toBe(14);
      expect(json.after.store.archivedCount).toBe(6);
      expect(json.after.store.supersededCount).toBe(0);

      // 受け入れ条件2: omitted の {kind:'filtered', condition:'archived'} が 0 → 正 へ動く。
      // `aggregateScope` はテナント/サブジェクトスコープ全体を数えるため、
      // どの probe から見ても掃かれた6件が同じ値で見える。
      expect(json.after.recall.unbudgeted.mean.omittedArchivedCount).toBe(6);
      for (const probe of json.after.recall.unbudgeted.probes) {
        expect(probe.omittedArchivedCount).toBe(6);
      }

      // 受け入れ条件2: `recall().usage.chars` が減るはず——目次帯(filteredArchivedを含む
      // 集約から要旨を作る digestBand)が縮む分、少なくとも増えてはいないことを確認する
      // (deterministic embedding は similarity が実質ランダムなので、`memories` 欄に
      // 載る候補の並びまでは主張しない——目次帯という構造的に動くはずの部分だけを見る)。
      expect(json.after.recall.unbudgeted.mean.usageChars).toBeLessThanOrEqual(
        json.before.recall.unbudgeted.mean.usageChars,
      );
    } finally {
      await handle.close();
    }
  });

  it("sweepLimitを掃引対象より小さくすると、reachedLimit:trueになる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const clock = createMutableClock();
    const handle = await createExampleRuntime(
      requireDatabaseUrl(),
      { MNEMORA_LLM: "deterministic", MNEMORA_EMBEDDING: "deterministic" },
      {},
      clock,
    );
    try {
      const json = await runArchiveSweepCost({
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        embeddingProvider: handle.embeddingProvider,
        pool: handle.pool,
        clock,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        tenantId: `archive-sweep-cost-limit-test-${Date.now()}`,
        halfLifeHours: 1,
        marginHours: 0.1,
        sweepLimit: 3,
        budgetLadder: [],
        recallLimit: 50,
        measuredAt: new Date(),
        commit: null,
        haystackSize: 6,
      });

      expect(json.sweep.archivedCount).toBe(3);
      expect(json.sweep.reachedLimit).toBe(true);
      expect(json.after.store.archivedCount).toBe(3);
      expect(json.after.store.activeCount).toBe(17); // 14 + 3(まだ掃かれていないfiller)
    } finally {
      await handle.close();
    }
  });
});

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

let workDir: string | undefined;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

afterAll(async () => {
  await closeTestClient();
});

describe("archive-sweep-cost: MNEMORA_ARCHIVE_SWEEP_JSON の配線(本物の CLI を子プロセスで起動)", () => {
  it("サブコマンドが実際に走り、JSON を書く", () => {
    workDir = mkdtempSync(join(tmpdir(), "archive-sweep-cost-wiring-"));
    const jsonPath = join(workDir, "archive-sweep-cost.json");

    const env: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: requireDatabaseUrl(),
      MNEMORA_ARCHIVE_SWEEP_JSON: jsonPath,
    };
    delete env.OPENAI_API_KEY;

    const result = spawnSync(
      "pnpm",
      ["--filter", "@mnemora/example-chat", "run", "archive-sweep-cost"],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        timeout: 120_000,
      },
    );

    expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);
    expect(existsSync(jsonPath)).toBe(true);
    expect(result.stdout).toContain("[archive-sweep-cost] 機械可読な結果を書き出した");

    const json = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(json.schemaVersion).toBe(1);
    expect(json.status).toBe("measured");
    expect(json.llmMode).toBe("deterministic");
    expect(json.embeddingMode).toBe("local");
    expect(json.embeddingSpace.provider).toBe("local");
    expect(json.probeCount).toBe(7);
    expect(json.haystackSize).toBe(60);
    expect(json.sweep.supported).toBe(true);
    expect(json.sweep.archivedCount).toBe(60);
    expect(json.after.store.archivedCount).toBe(60);
    expect(json.commit === null || /^[0-9a-f]{40}$/.test(json.commit)).toBe(true);
  }, 120_000);
});
