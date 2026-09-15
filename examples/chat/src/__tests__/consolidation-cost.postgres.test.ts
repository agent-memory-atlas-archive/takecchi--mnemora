import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { measureNewMemoriesEmbedding, runConsolidationCost } from "../consolidation-cost.js";
import { lookupLatestEmbedFailureKind } from "../embed-failure-kind.js";
import { warmupLocalEmbedding } from "../local-embedding-warmup.js";
import { localEmbeddingCacheDirEnv } from "../providers.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `consolidation-cost` サブコマンド(Issue #136)を、本物の Postgres + pgvector に対して
 * 実際に走らせる歯。
 *
 * 3つの観点に分ける:
 * 1. round の進行・打ち切り条件・store の増減(`deterministic` embedding。速い・
 *    ネットワーク不要——`identifier-arm.postgres.test.ts` と同じ判断)。
 * 2. ADR 0090 の `input_too_long` が実際に `embeddingStatus:"failed"` へ着地し、
 *    `outbox.last_error` から `kind` を読めること(`local` embedding が要る。実物)。
 * 3. サブコマンドの配線そのもの(本物の CLI を子プロセスで起動し、
 *    `MNEMORA_CONSOLIDATION_JSON` が実際に書かれること)。
 */
describe("consolidation-cost: round の進行(deterministic embedding、配線の検査)", () => {
  it("haystackSize=6・groupSize=3で、round が進むごとに activeCount が減り、候補が2件未満で打ち切る", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    });
    try {
      const json = await runConsolidationCost({
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        embeddingProvider: handle.embeddingProvider,
        pool: handle.pool,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        tenantId: `consolidation-cost-test-${Date.now()}`,
        groupSize: 3,
        budgetLadder: [32, 128],
        recallLimit: 50,
        measuredAt: new Date(),
        commit: null,
        haystackSize: 6,
      });

      expect(json.schemaVersion).toBe(1);
      expect(json.probeCount).toBe(7);
      expect(json.haystackSize).toBe(6);
      expect(json.groupSize).toBe(3);
      expect(json.budgetLadder).toEqual([32, 128]);

      // round0: 6 filler + 7 gold + 7 distractor = 20、まだ何も統合していない。
      expect(json.rounds[0]?.round).toBe(0);
      expect(json.rounds[0]?.consolidation).toBeNull();
      expect(json.rounds[0]?.store.activeCount).toBe(20);
      expect(json.rounds[0]?.store.supersededCount).toBe(0);

      // round1: 6 filler を3件ずつ2群に分け、2件の統合先を作る。
      // activeCount = 14(gold+distractor) + 2(統合先) = 16。
      expect(json.rounds[1]?.round).toBe(1);
      expect(json.rounds[1]?.consolidation?.groups).toBe(2);
      expect(json.rounds[1]?.consolidation?.newMemoryCount).toBe(2);
      expect(json.rounds[1]?.consolidation?.outcomes.consolidated).toBe(2);
      expect(json.rounds[1]?.store.activeCount).toBe(16);
      expect(json.rounds[1]?.store.supersededCount).toBe(6);

      // round2: 前回の統合結果2件を1群に統合。activeCount = 14 + 1 = 15。
      expect(json.rounds[2]?.round).toBe(2);
      expect(json.rounds[2]?.consolidation?.groups).toBe(1);
      expect(json.rounds[2]?.consolidation?.newMemoryCount).toBe(1);
      expect(json.rounds[2]?.store.activeCount).toBe(15);
      expect(json.rounds[2]?.store.supersededCount).toBe(8);

      // round3 は候補が1件(<2)しか残らないため打ち切り。
      expect(json.rounds).toHaveLength(3);
      expect(json.stoppedAfterRound).toBe(2);
      expect(json.stopReason).toBe("insufficient_candidates");

      // `allContentChars` は round が進むごとに単調に増える(ADR 0090 が「反復で
      // content が縮む保証は無い」と書いたことの実測)。
      const allContentChars = json.rounds.map((r) => r.store.allContentChars);
      for (let i = 1; i < allContentChars.length; i += 1) {
        expect(allContentChars[i]!).toBeGreaterThan(allContentChars[i - 1]!);
      }

      // deterministic embedding は失敗しない。
      for (const round of json.rounds) {
        if (round.consolidation) {
          expect(round.consolidation.embeddingStatus.failed).toBe(0);
          expect(round.consolidation.embeddingFailureKinds).toEqual([]);
        }
      }
    } finally {
      await handle.close();
    }
  });
});

describe("consolidation-cost: 埋め込みの入力上限(ADR 0090)への着地", () => {
  it("巨大な utterance を observe すると embeddingStatus が failed になり、kind が input_too_long と分かる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "local",
      ...localEmbeddingCacheDirEnv(),
    });
    try {
      const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
      expect(warmup.ok, warmup.detail).toBe(true);
      const ctx = { tenantId: `consolidation-cost-toolong-${Date.now()}` };
      // ADR 0090: 8192 トークンの壁。
      //
      // [Issue #258 / ADR 0139] 元は「多様な語彙を含む長文」
      // (800件の filler sentence・約56,700字)を使っていたが、この構成は
      // tokenizer.encode() 自体が重く(実測: 3試行 41,885ms/41,365ms/42,926ms、
      // 平均約42秒)、CI 実測 234,066ms(与えられた120秒の約2倍。Issue #258)の
      // 主因だった。
      //
      // ⟹ `packages/local-embedding/src/__tests__/live.local-embedding.test.ts` の
      // `KANA_CYCLE` と同じ手法(46字を巡回させる)に切り替える。単純な1文字の繰り返しは
      // BPE に圧縮されて壁を越えない(ADR 0090 §1.2 の実測)が、46字を巡回させ連続する
      // 同一文字を無くすと増分が常に0か1になり、壁をきちんと越えられる(同ファイルの
      // 実測コメント参照)。
      //
      // この作業で実測(この env、@huggingface/transformers@4.2.0・
      // sirasagi62/ruri-v3-30m-ONNX 固定): 12,000字で 9,392 トークン
      // (> 上限8192、余裕 +1,200トークン/+14.6%——上限ちょうどに寄せすぎない)。
      // encode() は 870ms——旧構成(56,689字・13,493トークン・平均約42秒)の
      // **約48分の1**。トークン数は固定バージョンの tokenizer に対する純関数の
      // 結果であり決定的(実行のたびに変わらない)。速いのは、より少ない文字数を
      // 埋め込んでいるからではなく(むしろ文字数はこちらのほうが少ない=12,000字 vs
      // 56,689字)、**同じ46字が巡回するだけの文字列は、多様な英単語・数字が混ざる
      // 文字列より encode() 自体の計算コストが低い**ためだと考えられる
      // (ADR 0139 参照。厳密な原因分析——pretokenization の正規表現
      // マッチ回数等——はしていない)。
      const KANA_CYCLE =
        "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";
      const hugeText = Array.from(
        { length: 12_000 },
        (_, i) => KANA_CYCLE[i % KANA_CYCLE.length],
      ).join("");
      const observed = await handle.runtime.observe(ctx, {
        kind: "utterance",
        text: hugeText,
        externalId: "huge-one",
      });
      expect(observed.memoryIds).toHaveLength(1);
      const memoryId = observed.memoryIds[0]!;

      await handle.runtime.tick(ctx, { kinds: ["embed"], leaseMs: 30 * 60 * 1000 });

      const memory = await handle.memoryStore.get(ctx, memoryId);
      expect(memory?.embeddingStatus).toBe("failed");

      const kind = await lookupLatestEmbedFailureKind(handle.pool, ctx.tenantId, memoryId);
      expect(kind).toBe("input_too_long");

      const measured = await measureNewMemoriesEmbedding(handle.memoryStore, handle.pool, ctx, [
        memoryId,
      ]);
      expect(measured.embeddingStatus).toEqual({ ok: 0, pending: 0, failed: 1 });
      expect(measured.embeddingFailureKinds).toEqual(["input_too_long"]);
    } finally {
      await handle.close();
    }
    // 120_000 → 60_000: 上のコメントの実測(encode() が旧構成の約48分の1)により
    // 支配的だった費用を大きく削ったが、この env には Postgres が無く、DB を含む
    // この検査自体の総所要時間はこの作業で再現できていない(ADR 0139
    // 「確かめていないこと」)。ゼロ(既定の30秒)へは寄せず、CI のばらつきに対する
    // 余裕を明示的に残す——旧値(120秒)を全面的に信用しない一方、実測していない
    // 総所要への保険として、半分に留める。
  }, 60_000);
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

describe("consolidation-cost: MNEMORA_CONSOLIDATION_JSON の配線(本物の CLI を子プロセスで起動)", () => {
  it("サブコマンドが実際に走り、JSON を書く", () => {
    workDir = mkdtempSync(join(tmpdir(), "consolidation-cost-wiring-"));
    const jsonPath = join(workDir, "consolidation-cost.json");

    const env: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: requireDatabaseUrl(),
      MNEMORA_CONSOLIDATION_JSON: jsonPath,
    };
    delete env.OPENAI_API_KEY;

    const result = spawnSync(
      "pnpm",
      ["--filter", "@mnemora/example-chat", "run", "consolidation-cost"],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        timeout: 120_000,
      },
    );

    expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);
    expect(existsSync(jsonPath)).toBe(true);
    expect(result.stdout).toContain("[consolidation-cost] 機械可読な結果を書き出した");

    const json = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(json.schemaVersion).toBe(1);
    expect(json.status).toBe("measured");
    expect(json.llmMode).toBe("deterministic");
    expect(json.embeddingMode).toBe("local");
    expect(json.embeddingSpace.provider).toBe("local");
    expect(json.probeCount).toBe(7);
    expect(json.haystackSize).toBe(60);
    expect(json.groupSize).toBe(5);
    expect(Array.isArray(json.rounds)).toBe(true);
    expect(json.rounds.length).toBeGreaterThan(1);
    expect(json.rounds[0].consolidation).toBeNull();
    expect(json.commit === null || /^[0-9a-f]{40}$/.test(json.commit)).toBe(true);
  }, 120_000);
});
