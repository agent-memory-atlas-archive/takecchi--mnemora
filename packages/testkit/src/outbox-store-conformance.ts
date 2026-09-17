import { describe, expect, it } from "vitest";
import {
  OutboxLeaseConflictError,
  type Ctx,
  type OutboxJobKind,
  type OutboxJobRecord,
  type OutboxStore,
} from "@mnemora/core";

export interface SeedOutboxJobInput {
  kind: OutboxJobKind;
  payload?: Record<string, unknown>;
  availableAt?: Date;
}

export interface OutboxStoreConformanceOptions {
  name: string;
  createStore: () => OutboxStore | Promise<OutboxStore>;
  /**
   * `OutboxStore` 単体には「積む」操作が無い（`enqueue` は `MemoryStore.createObservationWithOutbox`
   * / `createMemoryWithOutbox` が同一トランザクションで行う、docs/architecture.md §3.4）。
   * この適合テストは `claimBatch`/`complete`/`fail` を単体で検査したいため、adapter に
   * 「生の outbox 行を直接作る」フックを要求する。
   */
  seedJob: (ctx: Ctx, input: SeedOutboxJobInput) => Promise<OutboxJobRecord>;
  /**
   * **本物の並行で `claimBatch` を測れる adapter だけが `true` を渡す**（ADR 0206）。
   *
   * `true` のとき「並行に撃った `claimBatch` が二重 claim しない」歯が走り、**省略/false の
   * ときは `it.skip` になる**——⟹ **測っていないことが、緑ではなく skip として見える。**
   *
   * ⛔ **`true` にしてよいのは、`Promise.all` で撃った `claimBatch` が実際に別のセッション
   * （別コネクション）で重なる adapter だけである。**単一プロセス内で逐次化される実装
   * （例: 本体に `await` を持たない in-memory 実装）が `true` を渡すと、**何も測らずに
   * 緑が出る。**
   *
   * ⚠ **この歯は、複数プロセスが実際にネットワーク越しで撃つ状況までは測らない。**
   * 測るのは単一プロセス内の複数接続までである。
   */
  supportsRealConcurrency?: boolean;
}

/**
 * この適合テスト自身が要求する claim のリース長。**契約検査のための固定値であり、
 * `runtime.tick`/`ClaimOutboxJobsOptions` の運用上の既定値ではない**（そちらは
 * ADR 0032 の通り既定値を持たない・呼び出し側が決める）。ここではリースの境界を
 * 明示的に検査する2本（先頭詰まり・リース失効後の再 claim）以外のテストで、
 * リース絡みの挙動が結果に影響しないよう十分に長い値を使う。
 */
const DEFAULT_LEASE_MS = 60_000;

/**
 * 並行 claim の歯（ADR 0206）の並行数とラウンド数。
 *
 * 🔴 **ラウンド数を減らさないこと。この歯の正しさは、ここにぶら下がっている。**
 *
 * 【実測 2026-09-17、`main` = `6daa09c`】`packages/postgres` の `claimBatch` から
 * `FOR UPDATE SKIP LOCKED` を丸ごと削った状態で、この歯を走らせた:
 *
 * | ラウンド数 | 試行 | 結果 |
 * | --- | --- | --- |
 * | **1** | 6 | 5 回 RED / **1 回 GREEN** ← 🔴 **壊れた実装を見逃した** |
 * | **10** | 4 | 4 回 RED（見逃し無し） |
 *
 * ⟹ **1ラウンドでは、壊れた実装を実際に取りこぼす。**⛔ **「10は多い、3で十分だろう」と
 * 減らさないこと**——見逃しは赤くならないので、**減らしたことが表に出ない。**
 * （変異なしの実装に対しては、10ラウンドで5試行とも緑。**偽陽性は観測していない。**）
 *
 * ⚠ **逆向きは保証していない。**`duplicateRounds === 0` は
 * **「このラウンド数では出なかった」以上を主張しない**——二重 claim が起きないことの
 * 証明ではない。
 */
const CONCURRENT_CLAIM_CONCURRENCY = 8;
const CONCURRENT_CLAIM_ROUNDS = 10;

/**
 * `OutboxStore` の適合テスト（roadmap.md 段階3、ADR 0005 の transactional outbox「運搬役」側）。
 *
 * 検査する契約:
 * - `claimBatch` は未処理（completed/failed 双方が null）かつ `availableAt <= now` の
 *   ジョブだけを返す
 * - `claimBatch` は `kinds` で絞り込める
 * - `claimBatch` は `limit` を超えない
 * - `claimBatch` で claim したジョブは、同じ claim 条件で二重に返らない
 *   （逐次の呼び出しについて。下の complete/fail・リースの項目）
 * - **並行に撃った `claimBatch` が、同じジョブを二重に claim しない**（ADR 0206）
 *   ⚠ **これを検査するのは `supportsRealConcurrency: true` を渡した adapter に対してだけである。**
 *   渡さない adapter では `it.skip` になる——⟹ **測っていないことが緑ではなく skip として
 *   見える。**理由と、boolean のフラグを採らなかった経緯は同フックの doc と ADR 0206。
 *   ⛔ **この歯が守っているのは `FOR UPDATE` の行ロックであって `SKIP LOCKED` ではない**
 *   【実測】——`SKIP LOCKED` だけを外しても赤くならない（ADR 0206 の「測ったこと」）。
 *   ⟹ **この項目が緑でも、`SKIP LOCKED` は検査されていない。**
 *   ⚠ **複数プロセスが実際にネットワーク越しで撃つ状況は、いまも測っていない。**
 *   この歯は単一プロセス内の複数接続までである。詳細は
 *   docs/architecture.md「確かめていないこと」節、ADR 0032「確かめていないこと」節を見ること。
 * - `complete` / `fail` の後、そのジョブは再び `claimBatch` に現れない
 * - テナント分離: 他テナントの未処理ジョブが `claimBatch` に現れない
 * - **claim のリース（ADR 0032）**: リース内で claim 済みの行は再 claim されず、
 *   `ORDER BY available_at ASC LIMIT n` の先頭を占め続けて後続の行を詰まらせない
 *   （オーナーの「先頭詰まり」仮説の検査）。リースが切れた行は再び claim される
 *   （`claimed_at IS NULL` だけにする案を却下した理由そのもの——見えない停止にしない）。
 */
export function describeOutboxStoreConformance(options: OutboxStoreConformanceOptions): void {
  const { name, createStore, seedJob, supportsRealConcurrency } = options;

  describe(`OutboxStore conformance (${name})`, () => {
    it("claimBatch は available_at <= now の未処理ジョブを返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await seedJob(ctx, { kind: "extract", payload: { observationId: "obs-1" } });

      const claimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.kind).toBe("extract");
    });

    it("claimBatch は availableAt が未来のジョブを返さない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const future = new Date(Date.now() + 1000 * 60 * 60);
      await seedJob(ctx, { kind: "extract", availableAt: future });

      const claimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(claimed).toEqual([]);
    });

    it("claimBatch は kinds で絞り込める", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await seedJob(ctx, { kind: "extract" });
      await seedJob(ctx, { kind: "embed" });

      const claimed = await store.claimBatch(ctx, {
        kinds: ["embed"],
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(claimed.every((job) => job.kind === "embed")).toBe(true);
      expect(claimed.length).toBeGreaterThanOrEqual(1);
    });

    it("claimBatch は limit を超えない件数を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await seedJob(ctx, { kind: "extract" });
      await seedJob(ctx, { kind: "extract" });
      await seedJob(ctx, { kind: "extract" });

      const claimed = await store.claimBatch(ctx, {
        limit: 2,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(claimed.length).toBeLessThanOrEqual(2);
    });

    it("complete したジョブは再び claimBatch に現れない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const job = await seedJob(ctx, { kind: "extract" });

      const firstClaim = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(firstClaim.map((j) => j.id)).toContain(job.id);
      const claimedJob = firstClaim.find((j) => j.id === job.id)!;

      await store.complete(ctx, job.id, claimedJob.attempts);

      const secondClaim = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(secondClaim.map((j) => j.id)).not.toContain(job.id);
    });

    it("fail したジョブは再び claimBatch に現れない（Phase 1 は自動リトライしない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const job = await seedJob(ctx, { kind: "extract" });

      // job はまだ claim されていない(seedJob 直後、attempts は生成時の値のまま)ため、
      // その attempts を渡す。
      await store.fail(ctx, job.id, "simulated failure", job.attempts);

      const claimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(claimed.map((j) => j.id)).not.toContain(job.id);
    });

    it("complete は存在しないジョブ id に対して例外を投げない（べき等な終端更新、expectedAttempts の値に関わらず）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.complete(ctx, "does-not-exist", 0)).resolves.not.toThrow();
      await expect(store.complete(ctx, "does-not-exist", 999)).resolves.not.toThrow();
    });

    it("fail は存在しないジョブ id に対して例外を投げない（べき等な終端更新、expectedAttempts の値に関わらず）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.fail(ctx, "does-not-exist", "boom", 0)).resolves.not.toThrow();
      await expect(store.fail(ctx, "does-not-exist", "boom", 999)).resolves.not.toThrow();
    });

    it("クロステナントの claimBatch は他テナントの未処理ジョブを返さない", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      await seedJob(ctxA, { kind: "extract" });

      const claimedB = await store.claimBatch(ctxB, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(claimedB).toEqual([]);
    });

    // -------------------------------------------------------------------
    // claim のリース（ADR 0032）
    // -------------------------------------------------------------------

    it("リース内で claim 済みの行は再 claim されず、後続の未処理行に到達できる（先頭詰まりの検査、オーナーの仮説）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const base = new Date("2026-01-01T00:00:00.000Z");
      // stuck が available_at で先頭に来るよう、later より前の時刻にする。
      const stuck = await seedJob(ctx, { kind: "extract", availableAt: base });
      const later = await seedJob(ctx, {
        kind: "extract",
        availableAt: new Date(base.getTime() + 1000),
      });

      // stuck を claim する(ワーカーが処理中、というシナリオ。complete/fail はまだ呼ばない)。
      const firstClaim = await store.claimBatch(ctx, {
        limit: 1,
        now: new Date(base.getTime() + 2000),
        claimedBy: "worker-1",
        leaseMs: 60_000,
      });
      expect(firstClaim.map((j) => j.id)).toEqual([stuck.id]);

      // 次の tick。リース(60秒)はまだ生きている(3秒しか経っていない)。
      // オーナーの仮説どおり先頭詰まりが起きるなら、limit=1 の枠は毎回 stuck に
      // 占有され続け、later には永久に到達できない。
      const secondClaim = await store.claimBatch(ctx, {
        limit: 1,
        now: new Date(base.getTime() + 3000),
        claimedBy: "worker-1",
        leaseMs: 60_000,
      });
      expect(secondClaim.map((j) => j.id)).toEqual([later.id]);
    });

    it("リースが切れた claim 済みの行は再び claim される（見えない停止にしない。claimed_at IS NULL 単独案を却下した理由そのもの）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const base = new Date("2026-01-01T00:00:00.000Z");
      const job = await seedJob(ctx, { kind: "extract", availableAt: base });
      const leaseMs = 1000;

      const firstClaim = await store.claimBatch(ctx, {
        limit: 10,
        now: base,
        claimedBy: "worker-1",
        leaseMs,
      });
      expect(firstClaim.map((j) => j.id)).toEqual([job.id]);

      // リースが切れる前 — まだ完了していないワーカーの行を横取りしない。
      const beforeExpiry = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(base.getTime() + leaseMs - 1),
        claimedBy: "worker-2",
        leaseMs,
      });
      expect(beforeExpiry.map((j) => j.id)).not.toContain(job.id);

      // リースがちょうど切れた瞬間 — 再び claim できる(止まったワーカーからの回収)。
      const afterExpiry = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(base.getTime() + leaseMs),
        claimedBy: "worker-2",
        leaseMs,
      });
      expect(afterExpiry.map((j) => j.id)).toContain(job.id);
    });

    // -------------------------------------------------------------------
    // complete / fail の CAS（ADR 0142, Issue #233）
    // -------------------------------------------------------------------

    it("complete は claim 時の attempts と一致すれば成功する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const job = await seedJob(ctx, { kind: "extract" });

      const claimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      const claimedJob = claimed.find((j) => j.id === job.id)!;

      await expect(store.complete(ctx, job.id, claimedJob.attempts)).resolves.not.toThrow();
    });

    it("complete は attempts が一致しないと OutboxLeaseConflictError を投げ、行を変更しない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const job = await seedJob(ctx, { kind: "extract" });

      const claimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      const claimedJob = claimed.find((j) => j.id === job.id)!;
      const wrongAttempts = claimedJob.attempts - 1;

      const error = await store.complete(ctx, job.id, wrongAttempts).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(OutboxLeaseConflictError);
      const conflict = error as OutboxLeaseConflictError;
      expect(conflict.jobId).toBe(job.id);
      expect(conflict.expectedAttempts).toBe(wrongAttempts);
      expect(conflict.observedAttempts).toBe(claimedJob.attempts);

      // 弾かれたので、行は complete されていないまま——claimBatch にはまだ現れないが
      // (リースが有効なので)、少なくとも上の complete によって completedAt が
      // 付いていないことを、再度 claim して確認する(リースを切らして再取得)。
      const reclaimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(Date.now() + DEFAULT_LEASE_MS + 1),
        claimedBy: "worker-2",
        leaseMs: DEFAULT_LEASE_MS,
      });
      expect(reclaimed.map((j) => j.id)).toContain(job.id);
    });

    it("fail は attempts が一致しないと OutboxLeaseConflictError を投げる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const job = await seedJob(ctx, { kind: "extract" });

      const claimed = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(),
        claimedBy: "worker-1",
        leaseMs: DEFAULT_LEASE_MS,
      });
      const claimedJob = claimed.find((j) => j.id === job.id)!;
      const wrongAttempts = claimedJob.attempts - 1;

      const error = await store
        .fail(ctx, job.id, "boom", wrongAttempts)
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(OutboxLeaseConflictError);
      const conflict = error as OutboxLeaseConflictError;
      expect(conflict.jobId).toBe(job.id);
      expect(conflict.expectedAttempts).toBe(wrongAttempts);
      expect(conflict.observedAttempts).toBe(claimedJob.attempts);
    });

    it("⭐ 再現(Issue #233): リース失効後に再claim・completeされたジョブを、遅れたワーカーのfail/completeが上書きできない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const base = new Date();
      const leaseMs = 1000;
      const job = await seedJob(ctx, { kind: "extract", availableAt: base });

      // ワーカーA が claim する(リース取得)。
      const claimA = await store.claimBatch(ctx, {
        limit: 10,
        now: base,
        claimedBy: "worker-A",
        leaseMs,
      });
      const jobAsClaimedByA = claimA.find((j) => j.id === job.id)!;
      expect(jobAsClaimedByA).toBeDefined();

      // リースが切れる(時計を進める)。
      const afterExpiry = new Date(base.getTime() + leaseMs);

      // ワーカーB が同じジョブを再 claim して complete する。
      const claimB = await store.claimBatch(ctx, {
        limit: 10,
        now: afterExpiry,
        claimedBy: "worker-B",
        leaseMs,
      });
      const jobAsClaimedByB = claimB.find((j) => j.id === job.id)!;
      expect(jobAsClaimedByB).toBeDefined();
      expect(jobAsClaimedByB.attempts).toBeGreaterThan(jobAsClaimedByA.attempts);
      await store.complete(ctx, job.id, jobAsClaimedByB.attempts);

      // ワーカーA が遅れて、自分が claim した時点の attempts で fail を呼ぶ
      // ——自分のリースはもう有効ではないので、弾かれるはず。
      const staleCall = store
        .fail(ctx, job.id, "worker-A: stale failure", jobAsClaimedByA.attempts)
        .catch((err: unknown) => err);
      const error = await staleCall;
      expect(error).toBeInstanceOf(OutboxLeaseConflictError);

      // 上の `expect(error).toBeInstanceOf(OutboxLeaseConflictError)` は
      // 「Aのfailが実際に(SQL/状態変更として)実行される前に弾かれた」ことの証拠になる
      // ——本実装はどちらも「CASが一致しない場合、対象行への書き込みを一切行わずに
      // 例外を投げる」形（`attempts = expectedAttempts` を満たす行が無ければ0行更新、
      // または一致しないことを確認してから投げる）にしてあるため、例外が飛んだ時点で
      // Aのfailは行に触れていない。これが本 Issue #233 の核心（遅れたワーカーが新しい
      // ワーカーの結果を「黙って上書きする」ことの直接の否定）である。
      // 追加の確認として、ジョブが(Bのcompleteのまま)終端状態を保っていることを、
      // さらにリースを切らして再claimできない(＝終端のまま)ことでも確かめる。
      const finalCheck = await store.claimBatch(ctx, {
        limit: 10,
        now: new Date(afterExpiry.getTime() + leaseMs + 1),
        claimedBy: "worker-3",
        leaseMs,
      });
      expect(finalCheck.map((j) => j.id)).not.toContain(job.id);
    });

    // 本物の並行で二重 claim を検査する歯（ADR 0206、Issue 205 の1本目）。
    // `supportsRealConcurrency: true` を渡さない adapter では `it.skip` になる——
    // ⟹ 「測っていない」が緑ではなく skip として見える。
    const maybeConcurrentIt = supportsRealConcurrency ? it : it.skip;

    maybeConcurrentIt("並行に撃った claimBatch が、同じジョブを二重に claim しない", async () => {
      const store = await createStore();

      let duplicateRounds = 0;
      const samples: string[][] = [];
      for (let round = 0; round < CONCURRENT_CLAIM_ROUNDS; round++) {
        // ラウンドごとにテナントを変える。claim 可能なジョブをちょうど1本にして
        // `limit: 1` で撃つと、二重 claim が起きたときに「同じ id が複数の呼び出しに
        // 返る」という形で必ず表に出る。
        const ctx: Ctx = { tenantId: `concurrent-claim-${round}` };
        await seedJob(ctx, { kind: "extract" });

        const now = new Date();
        const batches = await Promise.all(
          Array.from({ length: CONCURRENT_CLAIM_CONCURRENCY }, (_, worker) =>
            store.claimBatch(ctx, {
              limit: 1,
              now,
              claimedBy: `concurrent-worker-${worker}`,
              leaseMs: DEFAULT_LEASE_MS,
            }),
          ),
        );

        const claimedIds = batches.flatMap((batch) => batch.map((job) => job.id));
        // ⛔ 「合計が1本である」ことは検査しない。競合下では `SKIP LOCKED` 相当の実装が
        // 「ロック中の行を、この呼び出しでは単に飛ばす」だけで、どれか1本が必ず拾う保証は
        // していない【実測 2026-09-17: ジョブ5本・limit=3・4並行で、合計が5未満になる
        // ラウンドが出た】。拾い残しは次の tick が拾う——設計上の許容範囲であって故障では
        // ない。⟹ ここで検査してよいのは「**二重に返らない**」ことだけである。
        if (new Set(claimedIds).size !== claimedIds.length) {
          duplicateRounds++;
          if (samples.length < 3) {
            samples.push(claimedIds);
          }
        }
      }

      // 失敗時に「何ラウンドで、どの id が重複したか」が出るように、まとめて比較する。
      expect({ duplicateRounds, samples }).toEqual({ duplicateRounds: 0, samples: [] });
    });
  });
}
