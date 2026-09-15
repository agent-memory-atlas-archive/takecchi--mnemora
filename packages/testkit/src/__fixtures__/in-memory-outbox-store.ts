import {
  OutboxLeaseConflictError,
  type ClaimOutboxJobsOptions,
  type Ctx,
  type OutboxJobRecord,
  type OutboxStore,
} from "@mnemora/core";

/**
 * `OutboxStore` のインメモリ・プレースホルダ実装（roadmap.md 段階3）。
 *
 * `jobs` 配列は呼び出し側から共有参照として渡される想定
 * （`InMemoryMemoryStore.outboxJobs` と同じ配列を渡すことで、`createObservationWithOutbox` /
 * `createMemoryWithOutbox` が積んだジョブをここから claim/complete/fail できる）。
 *
 * `claimBatch` のリース意味論（ADR 0032）は `PostgresOutboxStore` と一致させてある
 * ——`packages/testkit` の適合テスト（`outbox-store-conformance.ts`）が両方の実装に
 * 対して同じ歯を走らせるため、ここで食い違うと歯が嘘をつく。
 *
 * `complete`/`fail` の CAS 意味論（ADR 0142, Issue #233）も同じ理由で一致させてある
 * ——`attempts` が `expectedAttempts` と一致する行だけを更新し、一致しなければ
 * {@link OutboxLeaseConflictError} を投げる。
 */
export class InMemoryOutboxStore implements OutboxStore {
  constructor(private readonly jobs: OutboxJobRecord[]) {}

  async claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]> {
    // リースが切れたとみなす境界時刻。`PostgresOutboxStore` と同じ `<=`（両端含む）。
    const leaseExpiresBefore = opts.now.getTime() - opts.leaseMs;
    const eligible = this.jobs.filter((job) => {
      const claimedAt = job.claimedAt ?? null;
      return (
        job.tenantId === ctx.tenantId &&
        (opts.kinds === undefined || opts.kinds.includes(job.kind)) &&
        (job.completedAt ?? null) === null &&
        (job.failedAt ?? null) === null &&
        job.availableAt <= opts.now &&
        // claim されたことが無い、またはリースが切れている（ADR 0032）。
        (claimedAt === null || claimedAt.getTime() <= leaseExpiresBefore)
      );
    });
    eligible.sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime());
    const claimed = eligible.slice(0, opts.limit);
    for (const job of claimed) {
      job.claimedAt = opts.now;
      job.claimedBy = opts.claimedBy;
      job.attempts += 1;
    }
    return claimed.map((job) => ({ ...job }));
  }

  async complete(ctx: Ctx, jobId: string, expectedAttempts: number): Promise<void> {
    const job = this.jobs.find((j) => j.id === jobId && j.tenantId === ctx.tenantId);
    if (!job) {
      return;
    }
    if (job.attempts !== expectedAttempts) {
      throw new OutboxLeaseConflictError(jobId, expectedAttempts, job.attempts);
    }
    job.completedAt = new Date();
  }

  async fail(ctx: Ctx, jobId: string, error: string, expectedAttempts: number): Promise<void> {
    const job = this.jobs.find((j) => j.id === jobId && j.tenantId === ctx.tenantId);
    if (!job) {
      return;
    }
    if (job.attempts !== expectedAttempts) {
      throw new OutboxLeaseConflictError(jobId, expectedAttempts, job.attempts);
    }
    job.failedAt = new Date();
    job.lastError = error;
  }
}
