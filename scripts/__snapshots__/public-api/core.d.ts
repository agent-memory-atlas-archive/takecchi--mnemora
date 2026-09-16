// ===== dist/ann-truncation.d.ts =====
import type { ScoringStrategy } from "./strategies/scoring.js";
export type AnnTruncationVerdict = {
    kind: "provably_safe";
    safetyRatio: number;
    assumptions: readonly string[];
} | {
    kind: "loss_possible";
    safetyRatio: number;
    assumptions: readonly string[];
} | {
    kind: "undecidable";
    reason: string;
};
export interface DecideAnnTruncationInput {
    strategy: ScoringStrategy;
    queryTags: readonly string[];
    lastAnnSimilarity: number;
    lastReturnedTotal: number | null;
    scoreThreshold: number;
}
export declare function decideAnnTruncation(input: DecideAnnTruncationInput): AnnTruncationVerdict;

// ===== dist/clock.d.ts =====
import type { Clock } from "./interfaces/clock.js";
export declare const systemClock: Clock;
export declare function fixedClock(at: Date): Clock;

// ===== dist/ctx.d.ts =====
import { z } from "zod";
export interface Ctx {
    tenantId: string;
    subjectId?: string;
}
export declare const CtxSchema: z.ZodObject<{
    tenantId: z.ZodString;
    subjectId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;

// ===== dist/digest-band.d.ts =====
import type { DigestBandLimitedBy, DigestEntry } from "./recall.js";
export interface PackDigestBandOptions {
    limit: number;
    maxChars: number;
    maxEntryChars: number;
}
export interface PackedDigestBand {
    band: DigestEntry[];
    limitedBy?: DigestBandLimitedBy;
}
export declare const DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS = 63;
export declare const DIGEST_BAND_ENTRY_SEPARATOR_CHARS = 1;
export declare function packDigestBand(candidates: readonly DigestEntry[], eligible: number, opts: PackDigestBandOptions): PackedDigestBand;

// ===== dist/embedding.d.ts =====
import { z } from "zod";
export interface EmbeddingSpaceId {
    provider: string;
    model: string;
    dimensions: number;
}
export declare const EmbeddingSpaceIdSchema: z.ZodObject<{
    provider: z.ZodString;
    model: z.ZodString;
    dimensions: z.ZodNumber;
}, z.core.$strip>;

// ===== dist/event-retention-purge.d.ts =====
import type { Ctx } from "./ctx.js";
import type { MemoryStore, PurgeExpiredEventsResult } from "./interfaces/memory-store.js";
import type { TenantSettingsStore } from "./interfaces/tenant-settings-store.js";
export type PurgeExpiredEventsForTenantOutcome = {
    kind: "unset";
} | {
    kind: "unlimited";
} | {
    kind: "store_unsupported";
} | {
    kind: "executed";
    result: PurgeExpiredEventsResult;
};
export interface PurgeExpiredEventsForTenantOptions {
    limit: number;
    dryRun?: boolean;
    now?: Date;
}
export declare function purgeExpiredEventsForTenant(ctx: Ctx, deps: {
    memoryStore: MemoryStore;
    tenantSettingsStore: TenantSettingsStore;
}, opts: PurgeExpiredEventsForTenantOptions): Promise<PurgeExpiredEventsForTenantOutcome>;

// ===== dist/event.d.ts =====
import { z } from "zod";
import type { EventId, MemoryId } from "./ids.js";
export type MemoryEventKind = "created" | "updated" | "superseded" | "archived" | "forgotten" | "purged" | "events_purged" | "restored";
export declare const MemoryEventKindSchema: z.ZodEnum<{
    superseded: "superseded";
    forgotten: "forgotten";
    archived: "archived";
    created: "created";
    updated: "updated";
    purged: "purged";
    events_purged: "events_purged";
    restored: "restored";
}>;
export interface EventActor {
    type: "human" | "system" | "clone";
    id?: string;
}
export declare const EventActorSchema: z.ZodObject<{
    type: z.ZodEnum<{
        human: "human";
        system: "system";
        clone: "clone";
    }>;
    id: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export interface MemoryEvent {
    id: EventId;
    tenantId: string;
    memoryId: MemoryId | null;
    kind: MemoryEventKind;
    at: Date;
    actor: EventActor;
    digestSnapshot?: string | null;
    sizeBeforeBytes?: number | null;
    meta: Record<string, unknown>;
}
export declare const MemoryEventSchema: z.ZodObject<{
    id: z.ZodString;
    tenantId: z.ZodString;
    memoryId: z.ZodNullable<z.ZodString>;
    kind: z.ZodEnum<{
        superseded: "superseded";
        forgotten: "forgotten";
        archived: "archived";
        created: "created";
        updated: "updated";
        purged: "purged";
        events_purged: "events_purged";
        restored: "restored";
    }>;
    at: z.ZodDate;
    actor: z.ZodObject<{
        type: z.ZodEnum<{
            human: "human";
            system: "system";
            clone: "clone";
        }>;
        id: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    digestSnapshot: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sizeBeforeBytes: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    meta: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strip>;
export type NewMemoryEvent = Omit<MemoryEvent, "id" | "at"> & {
    at?: Date;
};
export declare const NewMemoryEventSchema: z.ZodObject<{
    tenantId: z.ZodString;
    memoryId: z.ZodNullable<z.ZodString>;
    kind: z.ZodEnum<{
        superseded: "superseded";
        forgotten: "forgotten";
        archived: "archived";
        created: "created";
        updated: "updated";
        purged: "purged";
        events_purged: "events_purged";
        restored: "restored";
    }>;
    at: z.ZodOptional<z.ZodDate>;
    actor: z.ZodObject<{
        type: z.ZodEnum<{
            human: "human";
            system: "system";
            clone: "clone";
        }>;
        id: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    digestSnapshot: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sizeBeforeBytes: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    meta: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strip>;
export interface EventFilter {
    memoryId?: MemoryId;
    kind?: MemoryEventKind;
    since?: Date;
    until?: Date;
    limit?: number;
}
export declare const EventFilterSchema: z.ZodObject<{
    memoryId: z.ZodOptional<z.ZodString>;
    kind: z.ZodOptional<z.ZodEnum<{
        superseded: "superseded";
        forgotten: "forgotten";
        archived: "archived";
        created: "created";
        updated: "updated";
        purged: "purged";
        events_purged: "events_purged";
        restored: "restored";
    }>>;
    since: z.ZodOptional<z.ZodDate>;
    until: z.ZodOptional<z.ZodDate>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;

// ===== dist/extraction.d.ts =====
import { z } from "zod";
import type { Ctx } from "./ctx.js";
import type { LLMProvider, PromptSpec } from "./interfaces/llm-provider.js";
import type { DigestSource, NewMemory } from "./memory.js";
import type { Observation } from "./observation.js";
export declare const ExtractedMemoryCandidateSchema: z.ZodObject<{
    content: z.ZodString;
    digest: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    provenanceKind: z.ZodEnum<{
        stated: "stated";
        inferred: "inferred";
    }>;
    confidence: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type ExtractedMemoryCandidate = z.infer<typeof ExtractedMemoryCandidateSchema>;
export declare const ExtractionResultSchema: z.ZodObject<{
    memories: z.ZodArray<z.ZodObject<{
        content: z.ZodString;
        digest: z.ZodOptional<z.ZodString>;
        tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
        provenanceKind: z.ZodEnum<{
            stated: "stated";
            inferred: "inferred";
        }>;
        confidence: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export declare function buildExtractionPrompt(observation: Observation): PromptSpec;
export declare function truncateForFallbackDigest(content: string, maxLength: number): string;
export interface ResolvedDigest {
    digest: string;
    digestSource: DigestSource;
}
export declare function resolveDigest(candidate: Pick<ExtractedMemoryCandidate, "content" | "digest">, fallbackLength: number): ResolvedDigest;
export type ExtractionOutcome = "ok" | "llm_failed_whole_observation" | "skipped";
export interface ExtractionFailure {
    kind: string | null;
    message: string;
}
export declare function describeExtractionFailure(error: unknown): ExtractionFailure;
export interface ExtractCandidatesResult {
    candidates: ExtractedMemoryCandidate[];
    usedWholeObservationFallback: boolean;
    failure: ExtractionFailure | null;
}
export declare function extractCandidates(llmProvider: LLMProvider, ctx: Ctx, observation: Observation): Promise<ExtractCandidatesResult>;
export interface BuildNewMemoryParams {
    ctx: Ctx;
    observation: Observation;
    candidate: ExtractedMemoryCandidate;
    hashContent: (content: string) => string;
    extractorVersion: string;
    llmModelId: string;
    promptVersion: string;
    halfLifeHours: number;
    now: Date;
    digestFallbackLength: number;
    activitySeq?: number;
    halfLifeRecalls?: number;
}
export declare function buildNewMemoryFromCandidate(params: BuildNewMemoryParams): NewMemory;

// ===== dist/heuristic-token-counter.d.ts =====
import type { TokenCounter } from "./interfaces/token-counter.js";
export declare const heuristicTokenCounter: TokenCounter;

// ===== dist/idempotent-create.d.ts =====
export interface IdempotentCreateResult<T> {
    readonly value: T;
    readonly created: boolean;
}
export declare function resolveIdempotentCreate<T>(existing: T | null | undefined, insert: () => T): IdempotentCreateResult<T>;

// ===== dist/ids.d.ts =====
export type MemoryId = string;
export type ObservationId = string;
export type EventId = string;
export type RecallId = string;

// ===== dist/index.d.ts =====
export * from "./ctx.js";
export * from "./ids.js";
export * from "./provenance.js";
export * from "./observation.js";
export * from "./memory.js";
export * from "./recall.js";
export * from "./digest-band.js";
export * from "./ann-truncation.js";
export * from "./recall-footprint.js";
export * from "./event.js";
export * from "./embedding.js";
export * from "./outbox.js";
export * from "./idempotent-create.js";
export * from "./interfaces/memory-store.js";
export * from "./interfaces/vector-store.js";
export * from "./interfaces/lexical-store.js";
export * from "./interfaces/event-store.js";
export * from "./interfaces/llm-provider.js";
export * from "./interfaces/embedding-provider.js";
export * from "./interfaces/scheduler.js";
export * from "./interfaces/token-counter.js";
export * from "./interfaces/clock.js";
export * from "./interfaces/outbox-store.js";
export * from "./interfaces/tenant-settings-store.js";
export * from "./strategies/decay.js";
export * from "./strategies/scoring.js";
export * from "./strategies/reextract.js";
export * from "./strategies/consolidate.js";
export * from "./strategies/reflect.js";
export * from "./heuristic-token-counter.js";
export * from "./clock.js";
export * from "./inline-scheduler.js";
export * from "./extraction.js";
export * from "./runtime.js";
export * from "./recall-runtime.js";
export * from "./recall-output-validation.js";
export * from "./event-retention-purge.js";

// ===== dist/inline-scheduler.d.ts =====
import type { Ctx } from "./ctx.js";
import type { OutboxJob, Scheduler } from "./interfaces/scheduler.js";
export declare class InlineScheduler implements Scheduler {
    private readonly handler;
    constructor(handler: (ctx: Ctx, job: OutboxJob) => Promise<void>);
    enqueue(ctx: Ctx, job: OutboxJob): Promise<void>;
}

// ===== dist/interfaces/clock.d.ts =====
export interface Clock {
    now(): Date;
}

// ===== dist/interfaces/embedding-provider.d.ts =====
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
export interface EmbeddingProvider {
    readonly space: EmbeddingSpaceId;
    embed(ctx: Ctx, texts: string[]): Promise<number[][]>;
}

// ===== dist/interfaces/event-store.d.ts =====
import type { Ctx } from "../ctx.js";
import type { EventId } from "../ids.js";
import type { EventFilter, MemoryEvent, NewMemoryEvent } from "../event.js";
export interface EventStore {
    append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent>;
    get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null>;
    list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]>;
}

// ===== dist/interfaces/lexical-store.d.ts =====
import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { MemoryStatus } from "../memory.js";
import type { ProvenanceKind } from "../provenance.js";
export interface LexicalFilter {
    tenantId: string;
    status?: MemoryStatus[];
    subjectId?: string;
    excludeProvenanceKinds?: ProvenanceKind[];
    occurredAfter?: Date;
    occurredBefore?: Date;
    validAt?: Date;
}
export interface LexicalHit {
    memoryId: MemoryId;
    coverage: number;
    rank: number;
}
export interface LexicalStore {
    search(ctx: Ctx, query: string, opts: {
        limit: number;
        filter: LexicalFilter;
    }): Promise<LexicalHit[]>;
}

// ===== dist/interfaces/llm-provider.d.ts =====
import type { z } from "zod";
import type { Ctx } from "../ctx.js";
export interface PromptMessage {
    role: "system" | "user" | "assistant";
    content: string;
}
export interface PromptSpec {
    system?: string;
    messages: PromptMessage[];
}
export interface LLMResponse {
    content: string;
}
export interface StructuredRequest<T> {
    prompt: PromptSpec;
    schema: z.ZodType<T>;
}
export interface LLMProvider {
    complete(ctx: Ctx, req: PromptSpec): Promise<LLMResponse>;
    completeStructured<T>(ctx: Ctx, req: StructuredRequest<T>): Promise<T>;
}

// ===== dist/interfaces/memory-store.d.ts =====
import type { Ctx } from "../ctx.js";
import type { MemoryEvent, NewMemoryEvent } from "../event.js";
import type { MemoryId, ObservationId, RecallId } from "../ids.js";
import type { EmbeddingStatus, Memory, MemoryStatus, NewMemory } from "../memory.js";
import type { NewObservation, Observation } from "../observation.js";
import type { OutboxJobRecord } from "../outbox.js";
import type { NewRecallRecord, NotIndexedReason, RecallRecord, RecallScope, ScopeAggregate } from "../recall.js";
import type { OutboxJobKind } from "./scheduler.js";
import type { DecayClock } from "./tenant-settings-store.js";
export declare class MemoryStatusConflictError extends Error {
    readonly memoryId: MemoryId;
    readonly expectedStatus: MemoryStatus;
    readonly observedStatus: MemoryStatus | null;
    constructor(memoryId: MemoryId, expectedStatus: MemoryStatus, observedStatus: MemoryStatus | null);
}
export declare class ContestedWithoutCompanionError extends Error {
    readonly method: "updateStatus" | "updateStatusWithEvent" | "createMemory" | "createMemoryWithOutbox" | "supersedeWithNewMemories";
    readonly memoryId: MemoryId | null;
    constructor(method: "updateStatus" | "updateStatusWithEvent" | "createMemory" | "createMemoryWithOutbox" | "supersedeWithNewMemories", memoryId: MemoryId | null);
}
export declare function isContestedWithoutCompanion(status: MemoryStatus | undefined, contestedWithId: MemoryId | null | undefined): boolean;
export declare class MemoryPurgeConflictError extends Error {
    readonly memoryId: MemoryId;
    readonly observedStatus: MemoryStatus | null;
    readonly observedPurgedAt: Date | null;
    constructor(memoryId: MemoryId, observedStatus: MemoryStatus | null, observedPurgedAt: Date | null);
}
export declare const PURGE_TOMBSTONE_CONTENT = "[purged]";
export declare const PURGE_TOMBSTONE_DIGEST = "[purged]";
export declare const EMBEDDING_STATUS_ROLLBACK: {
    readonly from: "ready";
    readonly to: "failed";
};
export declare function isEmbeddingStatusRollback(current: EmbeddingStatus, next: EmbeddingStatus): boolean;
export interface AggregateScopeOptions {
    digestBand?: {
        limit: number;
        excludeMemoryIds: readonly MemoryId[];
    };
}
export interface MemoryStore {
    createObservation(ctx: Ctx, input: NewObservation): Promise<Observation>;
    getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null>;
    createObservationWithOutbox(ctx: Ctx, input: NewObservation, jobKinds: OutboxJobKind[]): Promise<{
        observation: Observation;
        created: boolean;
        jobs: OutboxJobRecord[];
    }>;
    createMemory(ctx: Ctx, input: NewMemory): Promise<Memory>;
    createMemoryWithOutbox(ctx: Ctx, input: NewMemory, jobKinds: OutboxJobKind[]): Promise<{
        memory: Memory;
        created: boolean;
        jobs: OutboxJobRecord[];
    }>;
    get(ctx: Ctx, id: MemoryId): Promise<Memory | null>;
    getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]>;
    listBySourceObservation(ctx: Ctx, observationId: ObservationId, extractorVersion: string | null): Promise<Memory[]>;
    updateStatus(ctx: Ctx, id: MemoryId, status: MemoryStatus, opts?: {
        supersededById?: MemoryId;
        expectedStatus?: MemoryStatus;
    }): Promise<Memory>;
    updateStatusWithEvent(ctx: Ctx, id: MemoryId, status: MemoryStatus, opts: {
        supersededById?: MemoryId;
        expectedStatus?: MemoryStatus;
    }, event: NewMemoryEvent): Promise<{
        memory: Memory;
        event: MemoryEvent;
    }>;
    setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory>;
    reinforce(ctx: Ctx, id: MemoryId, at: Date, opts?: ReinforceOptions): Promise<Memory>;
    recordUsage(ctx: Ctx, recallId: RecallId, memoryIds: MemoryId[]): Promise<{
        insertedMemoryIds: MemoryId[];
    }>;
    aggregateScope(ctx: Ctx, scope: RecallScope, opts?: AggregateScopeOptions): Promise<ScopeAggregate>;
    createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId>;
    getRecall(ctx: Ctx, id: RecallId): Promise<RecallRecord | null>;
    requeueEmbedJobs(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult>;
    supersedeWithNewMemories?(ctx: Ctx, news: ReadonlyArray<{
        input: NewMemory;
        jobKinds: OutboxJobKind[];
    }>, supersede: ReadonlyArray<{
        id: MemoryId;
        supersededByIndex: number;
        expectedStatus?: MemoryStatus;
        event: NewMemoryEvent;
    }>): Promise<{
        created: Array<{
            memory: Memory;
            created: boolean;
            jobs: OutboxJobRecord[];
        }>;
        superseded: MemoryEvent[];
        conflicted: Array<{
            id: MemoryId;
            observedStatus: MemoryStatus;
        }>;
    }>;
    purgeExpiredEvents?(ctx: Ctx, opts: PurgeExpiredEventsOptions): Promise<PurgeExpiredEventsResult>;
    archiveDecayed?(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<ArchiveDecayedResult>;
    purgeMemory?(ctx: Ctx, id: MemoryId, tombstone: {
        content: string;
        digest: string;
    }, event: NewMemoryEvent): Promise<{
        memory: Memory;
        event: MemoryEvent;
    }>;
    markContestedPair?(ctx: Ctx, first: {
        id: MemoryId;
        event: NewMemoryEvent;
    }, second: {
        id: MemoryId;
        event: NewMemoryEvent;
    }): Promise<{
        first: Memory;
        second: Memory;
        events: [
            MemoryEvent,
            MemoryEvent
        ];
    }>;
    resolveContestedPair?(ctx: Ctx, first: {
        id: MemoryId;
        status: "active" | "superseded";
        supersededById?: MemoryId;
        event: NewMemoryEvent;
    }, second: {
        id: MemoryId;
        status: "active" | "superseded";
        supersededById?: MemoryId;
        event: NewMemoryEvent;
    }): Promise<{
        first: Memory;
        second: Memory;
        events: [
            MemoryEvent,
            MemoryEvent
        ];
    }>;
}
export interface ReinforceOptions {
    nowSeq?: number;
}
export interface ArchiveDecayedOptions {
    now: Date;
    limit: number;
    nowSeq?: number;
    clock?: DecayClock;
}
export interface ArchiveDecayedResult {
    archived: Array<{
        memoryId: MemoryId;
        decayFloorAt: Date;
    }>;
    reachedLimit: boolean;
}
export interface PurgeExpiredEventsOptions {
    olderThan: Date;
    limit: number;
    dryRun?: boolean;
}
export interface PurgeExpiredEventsResult {
    purged: number;
    reachedLimit: boolean;
    oldestPurgedAt: Date | null;
    newestPurgedAt: Date | null;
    dryRun: boolean;
}
export interface RequeueEmbedJobsOptions {
    statuses: NotIndexedReason[];
    memoryIds?: MemoryId[];
    limit: number;
}
export interface RequeueEmbedJobsResult {
    requeued: number;
    memoryIds: MemoryId[];
}

// ===== dist/interfaces/outbox-store.d.ts =====
import type { Ctx } from "../ctx.js";
import type { OutboxJobRecord } from "../outbox.js";
import type { OutboxJobKind } from "./scheduler.js";
export interface ClaimOutboxJobsOptions {
    kinds?: OutboxJobKind[];
    limit: number;
    now: Date;
    claimedBy: string;
    leaseMs: number;
}
export declare class OutboxLeaseConflictError extends Error {
    readonly jobId: string;
    readonly expectedAttempts: number;
    readonly observedAttempts: number | null;
    constructor(jobId: string, expectedAttempts: number, observedAttempts: number | null);
}
export interface OutboxStore {
    claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]>;
    complete(ctx: Ctx, jobId: string, expectedAttempts: number): Promise<void>;
    fail(ctx: Ctx, jobId: string, error: string, expectedAttempts: number): Promise<void>;
}

// ===== dist/interfaces/scheduler.d.ts =====
import type { Ctx } from "../ctx.js";
export type OutboxJobKind = "extract" | "embed" | "consolidate" | "reflect" | (string & {});
export interface OutboxJob {
    id: string;
    tenantId: string;
    kind: OutboxJobKind;
    payload: Record<string, unknown>;
    availableAt?: Date;
}
export interface Scheduler {
    enqueue(ctx: Ctx, job: OutboxJob): Promise<void>;
}

// ===== dist/interfaces/tenant-settings-store.d.ts =====
import type { Ctx } from "../ctx.js";
export declare const DEFAULT_HALF_LIFE_HOURS = 720;
export declare function isHalfLifeHoursInRange(value: number): boolean;
export type EventRetention = {
    kind: "unset";
} | {
    kind: "unlimited";
} | {
    kind: "days";
    days: number;
};
export type EventRetentionSetting = Exclude<EventRetention, {
    kind: "unset";
}>;
export declare const EVENT_RETENTION_DAYS_INVALID_MESSAGE = "event retention days must be a positive integer";
export declare function assertValidEventRetentionDays(days: number): void;
export type DecayClock = "wall" | "activity" | "either";
export declare const DEFAULT_DECAY_CLOCK: DecayClock;
export declare const DEFAULT_HALF_LIFE_RECALLS = 720;
export declare function isHalfLifeRecallsInRange(value: number): boolean;
export declare const DECAY_CLOCK_INVALID_MESSAGE = "decay clock must be 'wall', 'activity', or 'either'";
export declare function assertValidDecayClock(value: string): asserts value is DecayClock;
export interface TenantSettingsStore {
    getDefaultHalfLifeHours(ctx: Ctx): Promise<number>;
    getEventRetention(ctx: Ctx): Promise<EventRetention>;
    setEventRetention(ctx: Ctx, retention: EventRetentionSetting): Promise<void>;
    getDecayClock?(ctx: Ctx): Promise<DecayClock>;
    setDecayClock?(ctx: Ctx, clock: DecayClock): Promise<void>;
    getDefaultHalfLifeRecalls?(ctx: Ctx): Promise<number>;
    getActivitySeq?(ctx: Ctx): Promise<number>;
}
export declare const DECAY_CLOCK_UNSUPPORTED_MESSAGE = "this TenantSettingsStore does not support setDecayClock";
export declare function readDecayClock(store: TenantSettingsStore, ctx: Ctx): Promise<DecayClock>;
export declare function readActivitySeq(store: TenantSettingsStore, ctx: Ctx): Promise<number>;
export declare function readDefaultHalfLifeRecalls(store: TenantSettingsStore, ctx: Ctx): Promise<number>;
export declare function writeDecayClock(store: TenantSettingsStore, ctx: Ctx, clock: DecayClock): Promise<void>;

// ===== dist/interfaces/token-counter.d.ts =====
export interface TokenCounter {
    count(text: string): {
        tokens: number;
        counter: "heuristic" | "exact";
    };
}

// ===== dist/interfaces/vector-store.d.ts =====
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { MemoryId } from "../ids.js";
import type { MemoryStatus } from "../memory.js";
import type { ProvenanceKind } from "../provenance.js";
export interface VectorFilter {
    tenantId: string;
    status?: MemoryStatus[];
    decayFloorAtAfter?: Date;
    subjectId?: string;
    excludeProvenanceKinds?: ProvenanceKind[];
    occurredAfter?: Date;
    occurredBefore?: Date;
    decayFloorSeqAfter?: number;
    decayFloorAnyAxis?: boolean;
    validAt?: Date;
}
export interface VectorEntry {
    memoryId: MemoryId;
    vector: number[];
}
export interface VectorHit {
    memoryId: MemoryId;
    distance: number;
}
export interface VectorStore {
    upsert(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId, vector: number[]): Promise<void>;
    search(ctx: Ctx, space: EmbeddingSpaceId, query: number[], opts: {
        limit: number;
        filter: VectorFilter;
    }): Promise<VectorHit[]>;
    delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void>;
    getVectors?(ctx: Ctx, space: EmbeddingSpaceId, memoryIds: MemoryId[]): Promise<VectorEntry[]>;
}

// ===== dist/memory.d.ts =====
import { z } from "zod";
import type { MemoryId, ObservationId } from "./ids.js";
import { type Provenance } from "./provenance.js";
export type MemoryStatus = "active" | "superseded" | "contested" | "archived" | "forgotten";
export declare const MemoryStatusSchema: z.ZodEnum<{
    superseded: "superseded";
    forgotten: "forgotten";
    archived: "archived";
    active: "active";
    contested: "contested";
}>;
export declare const MAX_STRENGTH = 1;
export declare function isStrengthInRange(value: number): boolean;
export type EmbeddingStatus = "pending" | "ready" | "failed" | "skipped";
export declare const EmbeddingStatusSchema: z.ZodEnum<{
    pending: "pending";
    failed: "failed";
    skipped: "skipped";
    ready: "ready";
}>;
export type DigestSource = "llm" | "fallback";
export declare const DigestSourceSchema: z.ZodEnum<{
    llm: "llm";
    fallback: "fallback";
}>;
export interface Memory {
    id: MemoryId;
    tenantId: string;
    subjectId?: string | null;
    sourceObservationId?: ObservationId | null;
    extractorVersion?: string | null;
    content: string;
    contentHash: string;
    digest: string;
    digestSource: DigestSource;
    provenance: Provenance;
    status: MemoryStatus;
    supersededById?: MemoryId | null;
    contestedWithId?: MemoryId | null;
    tags: string[];
    occurredAt?: Date | null;
    recordedAt: Date;
    lastReinforcedAt?: Date | null;
    validFrom?: Date | null;
    validUntil?: Date | null;
    strength: number;
    halfLifeHours: number;
    decayFloorAt: Date;
    decayBaseSeq?: number | null;
    decayFloorSeq?: number | null;
    halfLifeRecalls?: number | null;
    embeddingStatus: EmbeddingStatus;
    purgedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
}
export type NewMemory = Omit<Memory, "id" | "createdAt" | "updatedAt" | "status" | "supersededById" | "contestedWithId"> & Partial<Pick<Memory, "status" | "supersededById" | "contestedWithId">>;
export declare const MemorySchema: z.ZodObject<{
    id: z.ZodString;
    tenantId: z.ZodString;
    subjectId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sourceObservationId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    extractorVersion: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    content: z.ZodString;
    contentHash: z.ZodString;
    digest: z.ZodString;
    digestSource: z.ZodEnum<{
        llm: "llm";
        fallback: "fallback";
    }>;
    provenance: z.ZodDiscriminatedUnion<[
        z.ZodObject<{
            kind: z.ZodLiteral<"stated">;
            sourceObservationId: z.ZodString;
            speaker: z.ZodOptional<z.ZodString>;
            at: z.ZodString;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"inferred">;
            model: z.ZodString;
            promptVersion: z.ZodString;
            basis: z.ZodObject<{
                memoryIds: z.ZodArray<z.ZodString>;
                observationIds: z.ZodArray<z.ZodString>;
            }, z.core.$strip>;
            confidence: z.ZodNumber;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"consolidated">;
            sources: z.ZodArray<z.ZodString>;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"reflected">;
            sources: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"imported">;
            batchId: z.ZodString;
        }, z.core.$strip>
    ], "kind">;
    status: z.ZodEnum<{
        superseded: "superseded";
        forgotten: "forgotten";
        archived: "archived";
        active: "active";
        contested: "contested";
    }>;
    supersededById: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    contestedWithId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    tags: z.ZodArray<z.ZodString>;
    occurredAt: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    recordedAt: z.ZodDate;
    lastReinforcedAt: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    validFrom: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    validUntil: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    strength: z.ZodNumber;
    halfLifeHours: z.ZodNumber;
    decayFloorAt: z.ZodDate;
    decayBaseSeq: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    decayFloorSeq: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    halfLifeRecalls: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    embeddingStatus: z.ZodEnum<{
        pending: "pending";
        failed: "failed";
        skipped: "skipped";
        ready: "ready";
    }>;
    purgedAt: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    createdAt: z.ZodDate;
    updatedAt: z.ZodDate;
}, z.core.$strip>;
export declare const NewMemorySchema: z.ZodObject<{
    sourceObservationId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    digest: z.ZodString;
    strength: z.ZodNumber;
    tags: z.ZodArray<z.ZodString>;
    subjectId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    tenantId: z.ZodString;
    extractorVersion: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    content: z.ZodString;
    contentHash: z.ZodString;
    digestSource: z.ZodEnum<{
        llm: "llm";
        fallback: "fallback";
    }>;
    provenance: z.ZodDiscriminatedUnion<[
        z.ZodObject<{
            kind: z.ZodLiteral<"stated">;
            sourceObservationId: z.ZodString;
            speaker: z.ZodOptional<z.ZodString>;
            at: z.ZodString;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"inferred">;
            model: z.ZodString;
            promptVersion: z.ZodString;
            basis: z.ZodObject<{
                memoryIds: z.ZodArray<z.ZodString>;
                observationIds: z.ZodArray<z.ZodString>;
            }, z.core.$strip>;
            confidence: z.ZodNumber;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"consolidated">;
            sources: z.ZodArray<z.ZodString>;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"reflected">;
            sources: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"imported">;
            batchId: z.ZodString;
        }, z.core.$strip>
    ], "kind">;
    occurredAt: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    recordedAt: z.ZodDate;
    lastReinforcedAt: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    validFrom: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    validUntil: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    halfLifeHours: z.ZodNumber;
    decayFloorAt: z.ZodDate;
    decayBaseSeq: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    decayFloorSeq: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    halfLifeRecalls: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    embeddingStatus: z.ZodEnum<{
        pending: "pending";
        failed: "failed";
        skipped: "skipped";
        ready: "ready";
    }>;
    purgedAt: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    status: z.ZodOptional<z.ZodEnum<{
        superseded: "superseded";
        forgotten: "forgotten";
        archived: "archived";
        active: "active";
        contested: "contested";
    }>>;
    supersededById: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    contestedWithId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;

// ===== dist/observation.d.ts =====
import { z } from "zod";
import type { ObservationId } from "./ids.js";
export interface Observation {
    id: ObservationId;
    tenantId: string;
    subjectId?: string | null;
    externalId?: string | null;
    kind: string;
    payload: unknown;
    occurredAt?: Date | null;
    recordedAt: Date;
    validFrom?: Date | null;
    validUntil?: Date | null;
}
export type NewObservation = Omit<Observation, "id" | "recordedAt"> & {
    recordedAt?: Date;
};
export declare const ObservationSchema: z.ZodObject<{
    id: z.ZodString;
    tenantId: z.ZodString;
    subjectId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    externalId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    kind: z.ZodString;
    payload: z.ZodUnknown;
    occurredAt: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    recordedAt: z.ZodDate;
    validFrom: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    validUntil: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
}, z.core.$strip>;
export declare const NewObservationSchema: z.ZodObject<{
    kind: z.ZodString;
    subjectId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    tenantId: z.ZodString;
    occurredAt: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    validFrom: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    validUntil: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    externalId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    payload: z.ZodUnknown;
    recordedAt: z.ZodOptional<z.ZodDate>;
}, z.core.$strip>;
export type ExtractMode = "sync" | "deferred";
export declare const ExtractModeSchema: z.ZodEnum<{
    sync: "sync";
    deferred: "deferred";
}>;
export type ObserveInputKind = "utterance" | "event" | "memory_usage" | "document";
export interface ObserveUtteranceInput {
    kind: "utterance";
    subjectId?: string;
    externalId?: string;
    occurredAt?: Date;
    validFrom?: Date;
    validUntil?: Date;
    extract?: ExtractMode;
    speaker?: string;
    text: string;
}
export interface ObserveEventInput {
    kind: "event";
    subjectId?: string;
    externalId?: string;
    occurredAt?: Date;
    validFrom?: Date;
    validUntil?: Date;
    extract?: ExtractMode;
    name: string;
    data?: Record<string, unknown>;
}
export interface ObserveDocumentInput {
    kind: "document";
    subjectId?: string;
    externalId?: string;
    occurredAt?: Date;
    validFrom?: Date;
    validUntil?: Date;
    extract?: ExtractMode;
    title?: string;
    content: string;
}
export interface ObserveMemoryUsageInput {
    kind: "memory_usage";
    recallId: string;
    usedMemoryIds: string[];
}
export type ObserveInput = ObserveUtteranceInput | ObserveEventInput | ObserveDocumentInput | ObserveMemoryUsageInput;
export declare const ObserveInputSchema: z.ZodDiscriminatedUnion<[
    z.ZodObject<{
        kind: z.ZodLiteral<"utterance">;
        subjectId: z.ZodOptional<z.ZodString>;
        externalId: z.ZodOptional<z.ZodString>;
        occurredAt: z.ZodOptional<z.ZodDate>;
        validFrom: z.ZodOptional<z.ZodDate>;
        validUntil: z.ZodOptional<z.ZodDate>;
        extract: z.ZodOptional<z.ZodEnum<{
            sync: "sync";
            deferred: "deferred";
        }>>;
        speaker: z.ZodOptional<z.ZodString>;
        text: z.ZodString;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"event">;
        subjectId: z.ZodOptional<z.ZodString>;
        externalId: z.ZodOptional<z.ZodString>;
        occurredAt: z.ZodOptional<z.ZodDate>;
        validFrom: z.ZodOptional<z.ZodDate>;
        validUntil: z.ZodOptional<z.ZodDate>;
        extract: z.ZodOptional<z.ZodEnum<{
            sync: "sync";
            deferred: "deferred";
        }>>;
        name: z.ZodString;
        data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"document">;
        subjectId: z.ZodOptional<z.ZodString>;
        externalId: z.ZodOptional<z.ZodString>;
        occurredAt: z.ZodOptional<z.ZodDate>;
        validFrom: z.ZodOptional<z.ZodDate>;
        validUntil: z.ZodOptional<z.ZodDate>;
        extract: z.ZodOptional<z.ZodEnum<{
            sync: "sync";
            deferred: "deferred";
        }>>;
        title: z.ZodOptional<z.ZodString>;
        content: z.ZodString;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"memory_usage">;
        recallId: z.ZodString;
        usedMemoryIds: z.ZodArray<z.ZodString>;
    }, z.core.$strip>
], "kind">;
export declare function observeInputKindToObservationKind(kind: ObserveInputKind): string;

// ===== dist/outbox.d.ts =====
import { z } from "zod";
import type { OutboxJobKind } from "./interfaces/scheduler.js";
export interface OutboxJobRecord {
    id: string;
    tenantId: string;
    kind: OutboxJobKind;
    payload: Record<string, unknown>;
    availableAt: Date;
    claimedAt?: Date | null;
    claimedBy?: string | null;
    attempts: number;
    completedAt?: Date | null;
    failedAt?: Date | null;
    lastError?: string | null;
    createdAt: Date;
}
export declare const OutboxJobRecordSchema: z.ZodObject<{
    id: z.ZodString;
    tenantId: z.ZodString;
    kind: z.ZodString;
    payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    availableAt: z.ZodDate;
    claimedAt: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    claimedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    attempts: z.ZodNumber;
    completedAt: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    failedAt: z.ZodOptional<z.ZodNullable<z.ZodDate>>;
    lastError: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    createdAt: z.ZodDate;
}, z.core.$strip>;

// ===== dist/provenance.d.ts =====
import { z } from "zod";
export type ProvenanceKind = "stated" | "inferred" | "consolidated" | "reflected" | "imported";
export declare const ProvenanceKindSchema: z.ZodEnum<{
    stated: "stated";
    inferred: "inferred";
    consolidated: "consolidated";
    reflected: "reflected";
    imported: "imported";
}>;
export interface StatedProvenance {
    kind: "stated";
    sourceObservationId: string;
    speaker?: string;
    at: string;
}
export interface InferredProvenance {
    kind: "inferred";
    model: string;
    promptVersion: string;
    basis: {
        memoryIds: string[];
        observationIds: string[];
    };
    confidence: number;
}
export interface ConsolidatedProvenance {
    kind: "consolidated";
    sources: string[];
}
export interface ReflectedProvenance {
    kind: "reflected";
    sources?: string[];
}
export interface ImportedProvenance {
    kind: "imported";
    batchId: string;
}
export type Provenance = StatedProvenance | InferredProvenance | ConsolidatedProvenance | ReflectedProvenance | ImportedProvenance;
export declare const ProvenanceSchema: z.ZodDiscriminatedUnion<[
    z.ZodObject<{
        kind: z.ZodLiteral<"stated">;
        sourceObservationId: z.ZodString;
        speaker: z.ZodOptional<z.ZodString>;
        at: z.ZodString;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"inferred">;
        model: z.ZodString;
        promptVersion: z.ZodString;
        basis: z.ZodObject<{
            memoryIds: z.ZodArray<z.ZodString>;
            observationIds: z.ZodArray<z.ZodString>;
        }, z.core.$strip>;
        confidence: z.ZodNumber;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"consolidated">;
        sources: z.ZodArray<z.ZodString>;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"reflected">;
        sources: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"imported">;
        batchId: z.ZodString;
    }, z.core.$strip>
], "kind">;

// ===== dist/recall-footprint.d.ts =====
import type { RecallResult } from "./recall.js";
export interface FootprintStructuralConstants {
    defaultRecallLimit: number;
    defaultDigestBandLimit: number;
    digestBandMaxChars: number;
    digestBandMaxEntryChars: number;
    digestBandEntryFixedOverheadChars: number;
    digestBandEntrySeparatorChars: number;
}
export declare const FOOTPRINT_STRUCTURAL_CONSTANTS: FootprintStructuralConstants;
export type FootprintCoefficientName = "charsPerDigest" | "fixedIndexChars";
export type FootprintProfileOrigin = {
    kind: "builtin_default";
    measuredFrom: string;
    measuredUnder: FootprintStructuralConstants;
} | {
    kind: "calibrated";
    sampleCount: number;
    observedMemoryCount: {
        min: number;
        max: number;
    };
    borrowedFromDefault: readonly FootprintCoefficientName[];
};
export interface RecallFootprintProfile {
    origin: FootprintProfileOrigin;
    charsPerDigest: number;
    fixedIndexChars: number;
}
export declare const BUILTIN_RECALL_FOOTPRINT_PROFILE: RecallFootprintProfile;
export declare const DEFAULT_FOOTPRINT_TOLERANCE = 0.05;
export interface RecallFootprintSample {
    totalChars: number;
    memoryCount: number;
    bandEntryCount: number;
}
export declare function footprintSampleFromRecall(result: RecallResult): RecallFootprintSample;
export declare function calibrateRecallFootprint(samples: readonly RecallFootprintSample[], fallback?: RecallFootprintProfile): RecallFootprintProfile;
export interface RecallFootprintShape {
    memoryCountInScope: number;
    limit?: number;
    digestBandLimit?: number;
    associationCount?: number;
}
export interface RecallFootprintEstimate {
    chars: number;
    byTier: {
        digest: number;
        index: number;
    };
    returnedMemories: number;
    associationCount: number;
    bandEntries: number;
    memoriesCappedByLimit: boolean;
    bandSaturated: boolean;
    extrapolated: boolean;
    profileOrigin: FootprintProfileOrigin;
}
export declare function estimateRecallFootprint(shape: RecallFootprintShape, profile?: RecallFootprintProfile): RecallFootprintEstimate;
export type FullLogVerdict = "mnemora_smaller" | "full_log_smaller" | "too_close_to_call";
export type FootprintReason = {
    code: "dominant_term";
    term: "memories" | "digest_band" | "fixed_index";
    chars: number;
    shareOfEstimate: number;
} | {
    code: "full_log_below_fixed_cost";
    fixedIndexChars: number;
    fullLogChars: number;
} | {
    code: "band_saturated";
    bandChars: number;
} | {
    code: "memories_capped_by_limit";
    limit: number;
    memoryCountInScope: number;
} | {
    code: "within_tolerance";
    tolerance: number;
    estimatedShare: number;
} | {
    code: "profile_not_calibrated";
} | {
    code: "outside_calibrated_range";
    observed: {
        min: number;
        max: number;
    };
    asked: number;
} | {
    code: "coefficients_borrowed";
    borrowed: readonly FootprintCoefficientName[];
};
export interface FullLogComparisonInput {
    fullLogChars: number;
    shape: RecallFootprintShape;
    profile?: RecallFootprintProfile;
    tolerance?: number;
}
export interface FullLogComparison {
    verdict: FullLogVerdict;
    estimatedShare: number;
    breakEvenFullLogChars: number;
    reasons: readonly FootprintReason[];
    estimate: RecallFootprintEstimate;
}
export declare function compareWithFullLog(input: FullLogComparisonInput): FullLogComparison;

// ===== dist/recall-output-validation.d.ts =====
import type { RecallOutputValidation, RecallOutputValidationIssue } from "./recall.js";
export type RecallOutputValidationMode = "off" | "report" | "throw";
export declare const DEFAULT_RECALL_OUTPUT_VALIDATION: RecallOutputValidationMode;
export declare class RecallOutputValidationError extends Error {
    readonly issues: readonly RecallOutputValidationIssue[];
    readonly recallId: string;
    constructor(issues: readonly RecallOutputValidationIssue[], recallId: string);
}
export declare function validateRecallOutput(draft: unknown, mode: RecallOutputValidationMode, recallId: string): RecallOutputValidation | undefined;

// ===== dist/recall-runtime.d.ts =====
import type { Clock } from "./interfaces/clock.js";
import type { Ctx } from "./ctx.js";
import type { EmbeddingProvider } from "./interfaces/embedding-provider.js";
import type { MemoryStore } from "./interfaces/memory-store.js";
import type { TokenCounter } from "./interfaces/token-counter.js";
import type { VectorStore } from "./interfaces/vector-store.js";
import type { LexicalStore } from "./interfaces/lexical-store.js";
import type { TenantSettingsStore } from "./interfaces/tenant-settings-store.js";
import type { MemoryId } from "./ids.js";
import type { Memory } from "./memory.js";
import type { CountKind, RecallQuery, RecallResult, ScoreBreakdown } from "./recall.js";
import type { RecallOutputValidationMode } from "./recall-output-validation.js";
export interface RecallRuntimeDeps {
    memoryStore: MemoryStore;
    vectorStore: VectorStore;
    tenantSettingsStore?: TenantSettingsStore;
    lexicalStore?: LexicalStore;
    embeddingProvider: EmbeddingProvider;
    clock: Clock;
    tokenCounter: TokenCounter;
    outputValidation?: RecallOutputValidationMode;
}
type ScoredCandidate = {
    memory: Memory;
    retrievedVia: "ann" | "lexical" | "mandatory_companion" | "association";
    companionOf?: MemoryId;
    associationOf?: MemoryId;
    score: ScoreBreakdown;
};
export declare function compareScoredCandidates(a: ScoredCandidate, b: ScoredCandidate): number;
export interface ThresholdPartition {
    passed: ScoredCandidate[];
    belowThreshold: ScoredCandidate[];
    notComparable: ScoredCandidate[];
}
export declare function partitionByThreshold(scored: readonly ScoredCandidate[], threshold: number): ThresholdPartition;
export declare function countKindForPartition(partition: ThresholdPartition, scoredCount: number): CountKind;
export type Unit = {
    members: ScoredCandidate[];
    rankScore: number;
};
export declare function countKindForUnits(units: readonly Unit[], candidateCount: number): CountKind;
export declare function unitAssemblyShortfall(units: readonly Unit[], candidateCount: number): number;
export declare function runRecall(ctx: Ctx, query: RecallQuery, deps: RecallRuntimeDeps): Promise<RecallResult>;
export {};

// ===== dist/recall.d.ts =====
import { z } from "zod";
import type { MemoryId, RecallId } from "./ids.js";
import type { ProvenanceKind } from "./provenance.js";
export type CountKind = "exact" | "lower_bound" | "unknown";
export declare const CountKindSchema: z.ZodEnum<{
    unknown: "unknown";
    exact: "exact";
    lower_bound: "lower_bound";
}>;
export interface StageSkippedOmission {
    kind: "stage_skipped";
    stage: "candidate_generation" | "rescore" | "index_band" | "association";
    reason: "embedding_provider_unavailable" | "empty_query_content" | "vector_store_lacks_get_vectors" | "no_anchor";
}
export type ScopeRelation = "outside_scope" | "within_scope";
export declare const ScopeRelationSchema: z.ZodEnum<{
    outside_scope: "outside_scope";
    within_scope: "within_scope";
}>;
export interface FilteredOmission {
    kind: "filtered";
    condition: "tenant" | "superseded" | "forgotten" | "archived" | "taxonomy" | "period" | "decayed" | "expired" | "not_yet_valid";
    scopeRelation: ScopeRelation;
    count: number;
    countKind: CountKind;
}
export declare const FILTERED_CONDITION_SCOPE_RELATION: Record<FilteredOmission["condition"], ScopeRelation>;
export interface BelowThresholdOmission {
    kind: "below_threshold";
    count: number;
    countKind: CountKind;
    nearMisses?: {
        memoryId: MemoryId;
        score: number;
    }[];
}
export interface OverLimitOmission {
    kind: "over_limit";
    stage: "rescore" | "association";
    count: number;
    countKind: CountKind;
}
export interface BudgetDroppedOmission {
    kind: "budget_dropped";
    count: number;
    countKind: CountKind;
}
export type NotIndexedReason = "pending" | "failed" | "skipped";
export declare const NotIndexedReasonSchema: z.ZodEnum<{
    pending: "pending";
    failed: "failed";
    skipped: "skipped";
}>;
export interface NotIndexedOmission {
    kind: "not_indexed";
    reason: NotIndexedReason;
    count: number;
    countKind: CountKind;
}
export type AnnTruncationCertainty = "loss_possible" | "undecidable";
export interface AnnTruncatedOmission {
    kind: "ann_truncated";
    countKind: "unknown";
    certainty: AnnTruncationCertainty;
    safetyRatio?: number;
    assumptions?: readonly string[];
    undecidableReason?: string;
}
export interface AnnUnreachedOmission {
    kind: "ann_unreached";
    countKind: "unknown";
}
export interface ScoreNotComparableOmission {
    kind: "score_not_comparable";
    count: number;
    countKind: CountKind;
}
export interface UnitAssemblyDroppedOmission {
    kind: "unit_assembly_dropped";
    count: number;
    countKind: CountKind;
}
export interface LexicalTruncatedOmission {
    kind: "lexical_truncated";
    countKind: "unknown";
}
export type Omission = StageSkippedOmission | FilteredOmission | BelowThresholdOmission | OverLimitOmission | BudgetDroppedOmission | NotIndexedOmission | AnnTruncatedOmission | AnnUnreachedOmission | LexicalTruncatedOmission | ScoreNotComparableOmission | UnitAssemblyDroppedOmission;
export declare const OmissionSchema: z.ZodDiscriminatedUnion<[
    z.ZodObject<{
        kind: z.ZodLiteral<"stage_skipped">;
        stage: z.ZodEnum<{
            candidate_generation: "candidate_generation";
            rescore: "rescore";
            index_band: "index_band";
            association: "association";
        }>;
        reason: z.ZodEnum<{
            embedding_provider_unavailable: "embedding_provider_unavailable";
            empty_query_content: "empty_query_content";
            vector_store_lacks_get_vectors: "vector_store_lacks_get_vectors";
            no_anchor: "no_anchor";
        }>;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"filtered">;
        condition: z.ZodEnum<{
            tenant: "tenant";
            superseded: "superseded";
            forgotten: "forgotten";
            archived: "archived";
            taxonomy: "taxonomy";
            period: "period";
            decayed: "decayed";
            expired: "expired";
            not_yet_valid: "not_yet_valid";
        }>;
        scopeRelation: z.ZodEnum<{
            outside_scope: "outside_scope";
            within_scope: "within_scope";
        }>;
        count: z.ZodNumber;
        countKind: z.ZodEnum<{
            unknown: "unknown";
            exact: "exact";
            lower_bound: "lower_bound";
        }>;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"below_threshold">;
        count: z.ZodNumber;
        countKind: z.ZodEnum<{
            unknown: "unknown";
            exact: "exact";
            lower_bound: "lower_bound";
        }>;
        nearMisses: z.ZodOptional<z.ZodArray<z.ZodObject<{
            memoryId: z.ZodString;
            score: z.ZodNumber;
        }, z.core.$strip>>>;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"over_limit">;
        stage: z.ZodEnum<{
            rescore: "rescore";
            association: "association";
        }>;
        count: z.ZodNumber;
        countKind: z.ZodEnum<{
            unknown: "unknown";
            exact: "exact";
            lower_bound: "lower_bound";
        }>;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"budget_dropped">;
        count: z.ZodNumber;
        countKind: z.ZodEnum<{
            unknown: "unknown";
            exact: "exact";
            lower_bound: "lower_bound";
        }>;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"not_indexed">;
        reason: z.ZodEnum<{
            pending: "pending";
            failed: "failed";
            skipped: "skipped";
        }>;
        count: z.ZodNumber;
        countKind: z.ZodEnum<{
            unknown: "unknown";
            exact: "exact";
            lower_bound: "lower_bound";
        }>;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"ann_truncated">;
        countKind: z.ZodLiteral<"unknown">;
        certainty: z.ZodEnum<{
            loss_possible: "loss_possible";
            undecidable: "undecidable";
        }>;
        safetyRatio: z.ZodOptional<z.ZodNumber>;
        assumptions: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString>>>;
        undecidableReason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"ann_unreached">;
        countKind: z.ZodLiteral<"unknown">;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"lexical_truncated">;
        countKind: z.ZodLiteral<"unknown">;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"score_not_comparable">;
        count: z.ZodNumber;
        countKind: z.ZodEnum<{
            unknown: "unknown";
            exact: "exact";
            lower_bound: "lower_bound";
        }>;
    }, z.core.$strip>,
    z.ZodObject<{
        kind: z.ZodLiteral<"unit_assembly_dropped">;
        count: z.ZodNumber;
        countKind: z.ZodEnum<{
            unknown: "unknown";
            exact: "exact";
            lower_bound: "lower_bound";
        }>;
    }, z.core.$strip>
], "kind">;
export interface GroupCount {
    axis: "subject" | "taxonomy";
    key: string | null;
    count: number;
    countKind: CountKind;
}
export declare const GroupCountSchema: z.ZodObject<{
    axis: z.ZodEnum<{
        taxonomy: "taxonomy";
        subject: "subject";
    }>;
    key: z.ZodNullable<z.ZodString>;
    count: z.ZodNumber;
    countKind: z.ZodEnum<{
        unknown: "unknown";
        exact: "exact";
        lower_bound: "lower_bound";
    }>;
}, z.core.$strip>;
export interface DigestEntry {
    memoryId: MemoryId;
    digest: string;
    truncated?: boolean;
}
export declare const DigestEntrySchema: z.ZodObject<{
    memoryId: z.ZodString;
    digest: z.ZodString;
    truncated: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type DigestBandLimitedBy = "entry_limit" | "char_budget" | "both";
export declare const DigestBandLimitedBySchema: z.ZodEnum<{
    entry_limit: "entry_limit";
    char_budget: "char_budget";
    both: "both";
}>;
export interface DigestBandCoverage {
    shown: number;
    eligible: number;
    countKind: CountKind;
    limitedBy?: DigestBandLimitedBy;
}
export declare const DigestBandCoverageSchema: z.ZodObject<{
    shown: z.ZodNumber;
    eligible: z.ZodNumber;
    countKind: z.ZodEnum<{
        unknown: "unknown";
        exact: "exact";
        lower_bound: "lower_bound";
    }>;
    limitedBy: z.ZodOptional<z.ZodEnum<{
        entry_limit: "entry_limit";
        char_budget: "char_budget";
        both: "both";
    }>>;
}, z.core.$strip>;
export interface IndexBand {
    groups: GroupCount[];
    totalInScope: number;
    countKind: CountKind;
    digestBand?: DigestEntry[];
    digestBandCoverage?: DigestBandCoverage;
}
export declare const IndexBandSchema: z.ZodObject<{
    groups: z.ZodArray<z.ZodObject<{
        axis: z.ZodEnum<{
            taxonomy: "taxonomy";
            subject: "subject";
        }>;
        key: z.ZodNullable<z.ZodString>;
        count: z.ZodNumber;
        countKind: z.ZodEnum<{
            unknown: "unknown";
            exact: "exact";
            lower_bound: "lower_bound";
        }>;
    }, z.core.$strip>>;
    totalInScope: z.ZodNumber;
    countKind: z.ZodEnum<{
        unknown: "unknown";
        exact: "exact";
        lower_bound: "lower_bound";
    }>;
    digestBand: z.ZodOptional<z.ZodArray<z.ZodObject<{
        memoryId: z.ZodString;
        digest: z.ZodString;
        truncated: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>>;
    digestBandCoverage: z.ZodOptional<z.ZodObject<{
        shown: z.ZodNumber;
        eligible: z.ZodNumber;
        countKind: z.ZodEnum<{
            unknown: "unknown";
            exact: "exact";
            lower_bound: "lower_bound";
        }>;
        limitedBy: z.ZodOptional<z.ZodEnum<{
            entry_limit: "entry_limit";
            char_budget: "char_budget";
            both: "both";
        }>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const DEFAULT_DIGEST_BAND_LIMIT = 50;
export declare const DIGEST_BAND_MAX_CHARS = 4000;
export declare const DIGEST_BAND_MAX_ENTRY_CHARS = 120;
export interface ScopeAggregate {
    groups: GroupCount[];
    totalInScope: number;
    countKind: CountKind;
    notIndexed: Record<NotIndexedReason, {
        count: number;
        countKind: CountKind;
    }>;
    filteredArchived: {
        count: number;
        countKind: CountKind;
    };
    filteredSuperseded: {
        count: number;
        countKind: CountKind;
    };
    filteredForgotten: {
        count: number;
        countKind: CountKind;
    };
    filteredPeriod: {
        count: number;
        countKind: CountKind;
    };
    filteredExpired: {
        count: number;
        countKind: CountKind;
    };
    filteredNotYetValid: {
        count: number;
        countKind: CountKind;
    };
    filteredDecayed: {
        count: number;
        countKind: CountKind;
    };
    digests: DigestEntry[];
    digestEligible: {
        count: number;
        countKind: CountKind;
    };
}
export interface RecallUsage {
    chars: number;
    estimatedTokens: number;
    counter: "heuristic" | "exact";
    byTier: {
        full: number;
        digest: number;
        index: number;
        association?: number;
    };
    indexChars: number;
    share?: number;
    budgetExceeded?: boolean;
}
export declare const RecallUsageSchema: z.ZodObject<{
    chars: z.ZodNumber;
    estimatedTokens: z.ZodNumber;
    counter: z.ZodEnum<{
        exact: "exact";
        heuristic: "heuristic";
    }>;
    byTier: z.ZodObject<{
        full: z.ZodNumber;
        digest: z.ZodNumber;
        index: z.ZodNumber;
        association: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    indexChars: z.ZodNumber;
    share: z.ZodOptional<z.ZodNumber>;
    budgetExceeded: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export interface RecallBudget {
    maxMemoryChars?: number;
    maxMemoryTokens?: number;
    promptBudgetTokens?: number;
}
export declare const RecallBudgetSchema: z.ZodObject<{
    maxMemoryChars: z.ZodOptional<z.ZodNumber>;
    maxMemoryTokens: z.ZodOptional<z.ZodNumber>;
    promptBudgetTokens: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export interface ScoreBreakdown {
    similarity?: number;
    lexicalMatch?: number;
    decay: number;
    tagMatch: number;
    freshness: number;
    strength: number;
    total: number;
}
export declare const ScoreBreakdownSchema: z.ZodObject<{
    similarity: z.ZodOptional<z.ZodNumber>;
    lexicalMatch: z.ZodOptional<z.ZodNumber>;
    decay: z.ZodNumber;
    tagMatch: z.ZodNumber;
    freshness: z.ZodNumber;
    strength: z.ZodNumber;
    total: z.ZodNumber;
}, z.core.$strip>;
export interface RecalledMemory {
    memoryId: MemoryId;
    digest: string;
    retrievedVia: "ann" | "lexical" | "mandatory_companion" | "association";
    companionOf?: MemoryId;
    associationOf?: MemoryId;
    provenanceKind: ProvenanceKind;
    score: ScoreBreakdown;
}
export declare const RecalledMemorySchema: z.ZodObject<{
    memoryId: z.ZodString;
    digest: z.ZodString;
    retrievedVia: z.ZodEnum<{
        association: "association";
        ann: "ann";
        lexical: "lexical";
        mandatory_companion: "mandatory_companion";
    }>;
    companionOf: z.ZodOptional<z.ZodString>;
    associationOf: z.ZodOptional<z.ZodString>;
    provenanceKind: z.ZodEnum<{
        stated: "stated";
        inferred: "inferred";
        consolidated: "consolidated";
        reflected: "reflected";
        imported: "imported";
    }>;
    score: z.ZodObject<{
        similarity: z.ZodOptional<z.ZodNumber>;
        lexicalMatch: z.ZodOptional<z.ZodNumber>;
        decay: z.ZodNumber;
        tagMatch: z.ZodNumber;
        freshness: z.ZodNumber;
        strength: z.ZodNumber;
        total: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export type RecallStageName = "scope" | "candidate_generation" | "rescore" | "contradiction_resolution" | "budget_truncation" | "index_band" | "record";
export interface StageTrace {
    stage: RecallStageName;
    executed: boolean;
    detail?: Record<string, unknown>;
}
export declare const StageTraceSchema: z.ZodObject<{
    stage: z.ZodEnum<{
        record: "record";
        candidate_generation: "candidate_generation";
        rescore: "rescore";
        index_band: "index_band";
        scope: "scope";
        contradiction_resolution: "contradiction_resolution";
        budget_truncation: "budget_truncation";
    }>;
    executed: z.ZodBoolean;
    detail: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export interface RecallQuery {
    text?: string;
    vector?: number[];
    tags?: string[];
    occurredAfter?: Date;
    occurredBefore?: Date;
    limit?: number;
    overFetchFactor?: number;
    excludeProvenanceKinds?: ProvenanceKind[];
    channels?: RecallChannel[];
    budget?: RecallBudget;
    scoreThreshold?: number;
    digestBandLimit?: number;
    includeFullyDecayed?: boolean;
    validAt?: Date;
    includeOutsideValidity?: boolean;
    association?: RecallAssociationQuery;
}
export declare const RECALL_CHANNELS: readonly [
    "ann",
    "lexical"
];
export type RecallChannel = (typeof RECALL_CHANNELS)[number];
export declare const DEFAULT_RECALL_CHANNELS: readonly RecallChannel[];
export declare const ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE: string;
export declare const LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX = "recall: channels included 'lexical' but no LexicalStore is wired: ";
export declare const DEFAULT_SCORE_THRESHOLD = 0.1;
export interface RecallAssociationQuery {
    maxCount: number;
    anchorCount?: number;
    minSimilarity?: number;
}
export declare const RecallAssociationQuerySchema: z.ZodObject<{
    maxCount: z.ZodNumber;
    anchorCount: z.ZodOptional<z.ZodNumber>;
    minSimilarity: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const DEFAULT_ASSOCIATION_ANCHOR_COUNT = 3;
export declare const DEFAULT_ASSOCIATION_MIN_SIMILARITY = 0.5;
export declare const DEFAULT_RECALL_LIMIT = 10;
export declare const DEFAULT_OVER_FETCH_FACTOR = 4;
export declare const RecallQuerySchema: z.ZodObject<{
    text: z.ZodOptional<z.ZodString>;
    vector: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    occurredAfter: z.ZodOptional<z.ZodDate>;
    occurredBefore: z.ZodOptional<z.ZodDate>;
    limit: z.ZodOptional<z.ZodNumber>;
    overFetchFactor: z.ZodOptional<z.ZodNumber>;
    excludeProvenanceKinds: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        stated: "stated";
        inferred: "inferred";
        consolidated: "consolidated";
        reflected: "reflected";
        imported: "imported";
    }>>>;
    channels: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        ann: "ann";
        lexical: "lexical";
    }>>>;
    budget: z.ZodOptional<z.ZodObject<{
        maxMemoryChars: z.ZodOptional<z.ZodNumber>;
        maxMemoryTokens: z.ZodOptional<z.ZodNumber>;
        promptBudgetTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    scoreThreshold: z.ZodOptional<z.ZodNumber>;
    digestBandLimit: z.ZodOptional<z.ZodNumber>;
    includeFullyDecayed: z.ZodOptional<z.ZodBoolean>;
    validAt: z.ZodOptional<z.ZodDate>;
    includeOutsideValidity: z.ZodOptional<z.ZodBoolean>;
    association: z.ZodOptional<z.ZodObject<{
        maxCount: z.ZodNumber;
        anchorCount: z.ZodOptional<z.ZodNumber>;
        minSimilarity: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export interface RecallScope {
    subjectId?: string;
    occurredAfter?: Date;
    occurredBefore?: Date;
    validAt?: Date;
    decayFloorAtAfter?: Date;
    decayFloorSeqAfter?: number;
    decayFloorAnyAxis?: boolean;
}
export declare const RecallScopeSchema: z.ZodObject<{
    subjectId: z.ZodOptional<z.ZodString>;
    occurredAfter: z.ZodOptional<z.ZodDate>;
    occurredBefore: z.ZodOptional<z.ZodDate>;
    validAt: z.ZodOptional<z.ZodDate>;
    decayFloorAtAfter: z.ZodOptional<z.ZodDate>;
    decayFloorSeqAfter: z.ZodOptional<z.ZodNumber>;
    decayFloorAnyAxis: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export interface RecallOutputValidationIssue {
    path: string;
    code: string;
    message: string;
}
export declare const RecallOutputValidationIssueSchema: z.ZodObject<{
    path: z.ZodString;
    code: z.ZodString;
    message: z.ZodString;
}, z.core.$strip>;
export interface RecallOutputValidation {
    ok: boolean;
    issues: RecallOutputValidationIssue[];
}
export declare const RecallOutputValidationSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    issues: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export interface RecallResult {
    recallId: RecallId;
    memories: RecalledMemory[];
    omitted: Omission[];
    index: IndexBand;
    usage: RecallUsage;
    explain: {
        stages: StageTrace[];
    };
    outputValidation?: RecallOutputValidation;
}
export declare const RecallResultSchema: z.ZodObject<{
    recallId: z.ZodString;
    memories: z.ZodArray<z.ZodObject<{
        memoryId: z.ZodString;
        digest: z.ZodString;
        retrievedVia: z.ZodEnum<{
            association: "association";
            ann: "ann";
            lexical: "lexical";
            mandatory_companion: "mandatory_companion";
        }>;
        companionOf: z.ZodOptional<z.ZodString>;
        associationOf: z.ZodOptional<z.ZodString>;
        provenanceKind: z.ZodEnum<{
            stated: "stated";
            inferred: "inferred";
            consolidated: "consolidated";
            reflected: "reflected";
            imported: "imported";
        }>;
        score: z.ZodObject<{
            similarity: z.ZodOptional<z.ZodNumber>;
            lexicalMatch: z.ZodOptional<z.ZodNumber>;
            decay: z.ZodNumber;
            tagMatch: z.ZodNumber;
            freshness: z.ZodNumber;
            strength: z.ZodNumber;
            total: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    omitted: z.ZodArray<z.ZodDiscriminatedUnion<[
        z.ZodObject<{
            kind: z.ZodLiteral<"stage_skipped">;
            stage: z.ZodEnum<{
                candidate_generation: "candidate_generation";
                rescore: "rescore";
                index_band: "index_band";
                association: "association";
            }>;
            reason: z.ZodEnum<{
                embedding_provider_unavailable: "embedding_provider_unavailable";
                empty_query_content: "empty_query_content";
                vector_store_lacks_get_vectors: "vector_store_lacks_get_vectors";
                no_anchor: "no_anchor";
            }>;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"filtered">;
            condition: z.ZodEnum<{
                tenant: "tenant";
                superseded: "superseded";
                forgotten: "forgotten";
                archived: "archived";
                taxonomy: "taxonomy";
                period: "period";
                decayed: "decayed";
                expired: "expired";
                not_yet_valid: "not_yet_valid";
            }>;
            scopeRelation: z.ZodEnum<{
                outside_scope: "outside_scope";
                within_scope: "within_scope";
            }>;
            count: z.ZodNumber;
            countKind: z.ZodEnum<{
                unknown: "unknown";
                exact: "exact";
                lower_bound: "lower_bound";
            }>;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"below_threshold">;
            count: z.ZodNumber;
            countKind: z.ZodEnum<{
                unknown: "unknown";
                exact: "exact";
                lower_bound: "lower_bound";
            }>;
            nearMisses: z.ZodOptional<z.ZodArray<z.ZodObject<{
                memoryId: z.ZodString;
                score: z.ZodNumber;
            }, z.core.$strip>>>;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"over_limit">;
            stage: z.ZodEnum<{
                rescore: "rescore";
                association: "association";
            }>;
            count: z.ZodNumber;
            countKind: z.ZodEnum<{
                unknown: "unknown";
                exact: "exact";
                lower_bound: "lower_bound";
            }>;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"budget_dropped">;
            count: z.ZodNumber;
            countKind: z.ZodEnum<{
                unknown: "unknown";
                exact: "exact";
                lower_bound: "lower_bound";
            }>;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"not_indexed">;
            reason: z.ZodEnum<{
                pending: "pending";
                failed: "failed";
                skipped: "skipped";
            }>;
            count: z.ZodNumber;
            countKind: z.ZodEnum<{
                unknown: "unknown";
                exact: "exact";
                lower_bound: "lower_bound";
            }>;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"ann_truncated">;
            countKind: z.ZodLiteral<"unknown">;
            certainty: z.ZodEnum<{
                loss_possible: "loss_possible";
                undecidable: "undecidable";
            }>;
            safetyRatio: z.ZodOptional<z.ZodNumber>;
            assumptions: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString>>>;
            undecidableReason: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"ann_unreached">;
            countKind: z.ZodLiteral<"unknown">;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"lexical_truncated">;
            countKind: z.ZodLiteral<"unknown">;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"score_not_comparable">;
            count: z.ZodNumber;
            countKind: z.ZodEnum<{
                unknown: "unknown";
                exact: "exact";
                lower_bound: "lower_bound";
            }>;
        }, z.core.$strip>,
        z.ZodObject<{
            kind: z.ZodLiteral<"unit_assembly_dropped">;
            count: z.ZodNumber;
            countKind: z.ZodEnum<{
                unknown: "unknown";
                exact: "exact";
                lower_bound: "lower_bound";
            }>;
        }, z.core.$strip>
    ], "kind">>;
    index: z.ZodObject<{
        groups: z.ZodArray<z.ZodObject<{
            axis: z.ZodEnum<{
                taxonomy: "taxonomy";
                subject: "subject";
            }>;
            key: z.ZodNullable<z.ZodString>;
            count: z.ZodNumber;
            countKind: z.ZodEnum<{
                unknown: "unknown";
                exact: "exact";
                lower_bound: "lower_bound";
            }>;
        }, z.core.$strip>>;
        totalInScope: z.ZodNumber;
        countKind: z.ZodEnum<{
            unknown: "unknown";
            exact: "exact";
            lower_bound: "lower_bound";
        }>;
        digestBand: z.ZodOptional<z.ZodArray<z.ZodObject<{
            memoryId: z.ZodString;
            digest: z.ZodString;
            truncated: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>>;
        digestBandCoverage: z.ZodOptional<z.ZodObject<{
            shown: z.ZodNumber;
            eligible: z.ZodNumber;
            countKind: z.ZodEnum<{
                unknown: "unknown";
                exact: "exact";
                lower_bound: "lower_bound";
            }>;
            limitedBy: z.ZodOptional<z.ZodEnum<{
                entry_limit: "entry_limit";
                char_budget: "char_budget";
                both: "both";
            }>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    usage: z.ZodObject<{
        chars: z.ZodNumber;
        estimatedTokens: z.ZodNumber;
        counter: z.ZodEnum<{
            exact: "exact";
            heuristic: "heuristic";
        }>;
        byTier: z.ZodObject<{
            full: z.ZodNumber;
            digest: z.ZodNumber;
            index: z.ZodNumber;
            association: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        indexChars: z.ZodNumber;
        share: z.ZodOptional<z.ZodNumber>;
        budgetExceeded: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
    explain: z.ZodObject<{
        stages: z.ZodArray<z.ZodObject<{
            stage: z.ZodEnum<{
                record: "record";
                candidate_generation: "candidate_generation";
                rescore: "rescore";
                index_band: "index_band";
                scope: "scope";
                contradiction_resolution: "contradiction_resolution";
                budget_truncation: "budget_truncation";
            }>;
            executed: z.ZodBoolean;
            detail: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    outputValidation: z.ZodOptional<z.ZodObject<{
        ok: z.ZodBoolean;
        issues: z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            code: z.ZodString;
            message: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export interface RecallRecordMemory {
    memoryId: MemoryId;
    score: ScoreBreakdown;
    retrievedVia: RecalledMemory["retrievedVia"];
    companionOf?: MemoryId;
    associationOf?: MemoryId;
}
export type RecallRecordReturnedMemories = {
    breakdownCaptured: true;
    memories: RecallRecordMemory[];
} | {
    breakdownCaptured: false;
    memories: Array<{
        memoryId: MemoryId;
    }>;
};
export interface NewRecallRecord {
    tenantId: string;
    subjectId?: string | null;
    query: unknown;
    budget?: RecallBudget | null;
    omitted: Omission[];
    usage: RecallUsage;
    indexBand: IndexBand;
    explain: {
        stages: StageTrace[];
    };
    returnedMemories: RecallRecordMemory[];
    advanceActivityClock?: boolean;
}
export interface RecallRecord {
    recallId: RecallId;
    tenantId: string;
    subjectId: string | null;
    query: unknown;
    budget: RecallBudget | null;
    omitted: Omission[];
    usage: RecallUsage;
    indexBand: IndexBand;
    explain: {
        stages: StageTrace[];
    };
    returnedMemories: RecallRecordReturnedMemories;
    createdAt: Date;
}
export declare const NOT_INDEXED_REASONS: readonly NotIndexedReason[];

// ===== dist/runtime.d.ts =====
import type { Clock } from "./interfaces/clock.js";
import type { Ctx } from "./ctx.js";
import type { EventActor } from "./event.js";
import type { ExtractionFailure, ExtractionOutcome } from "./extraction.js";
import type { EmbeddingProvider } from "./interfaces/embedding-provider.js";
import type { EventStore } from "./interfaces/event-store.js";
import type { LLMProvider } from "./interfaces/llm-provider.js";
import type { ArchiveDecayedOptions, MemoryStore, RequeueEmbedJobsOptions, RequeueEmbedJobsResult } from "./interfaces/memory-store.js";
import type { OutboxStore } from "./interfaces/outbox-store.js";
import type { OutboxJobKind } from "./interfaces/scheduler.js";
import type { TenantSettingsStore } from "./interfaces/tenant-settings-store.js";
import type { TokenCounter } from "./interfaces/token-counter.js";
import type { VectorStore } from "./interfaces/vector-store.js";
import type { LexicalStore } from "./interfaces/lexical-store.js";
import type { MemoryId, ObservationId, RecallId } from "./ids.js";
import type { Memory, MemoryStatus } from "./memory.js";
import type { ObserveInput } from "./observation.js";
import type { RecallQuery, RecallRecord, RecallResult } from "./recall.js";
import type { RecallOutputValidationMode } from "./recall-output-validation.js";
import type { ReextractSkip } from "./strategies/reextract.js";
export interface RuntimeConfig {
    extractorVersion?: string;
    llmModelId?: string;
    promptVersion?: string;
    digestFallbackLength?: number;
    defaultClaimedBy?: string;
    autoQueueConsolidateReflectOnExtract?: boolean;
}
export declare const TICK_SUPPORTED_JOB_KINDS: readonly [
    "extract",
    "embed",
    "consolidate",
    "reflect"
];
export type TickSupportedJobKind = (typeof TICK_SUPPORTED_JOB_KINDS)[number];
export declare const UNSUPPORTED_KIND_ERROR_PREFIX = "runtime.tick: unsupported outbox job kind: ";
export interface RuntimeDeps {
    memoryStore: MemoryStore;
    outboxStore: OutboxStore;
    vectorStore: VectorStore;
    lexicalStore?: LexicalStore;
    eventStore: EventStore;
    tenantSettingsStore: TenantSettingsStore;
    llmProvider: LLMProvider;
    embeddingProvider: EmbeddingProvider;
    clock?: Clock;
    hashContent: (content: string) => string;
    config?: RuntimeConfig;
    tokenCounter?: TokenCounter;
    outputValidation?: RecallOutputValidationMode;
}
export interface ObserveResult {
    observationId: ObservationId;
    memoryIds: MemoryId[];
    extraction: ExtractionOutcome;
    extractionFailure: ExtractionFailure | null;
}
export type WriteAtomicity = "store_supported" | "store_unsupported" | "not_attempted";
export interface ReextractResult {
    observationId: ObservationId;
    atomicity: WriteAtomicity;
    memoryIds: MemoryId[];
    supersededMemoryIds: MemoryId[];
    skipped: ReextractSkip[];
    extraction: ExtractionOutcome;
    extractionFailure: ExtractionFailure | null;
}
export type ForgetTarget = {
    memoryId: MemoryId;
} | {
    memoryIds: MemoryId[];
};
export type ForgetOutcome = {
    memoryId: MemoryId;
    kind: "forgotten";
    previousStatus: MemoryStatus;
} | {
    memoryId: MemoryId;
    kind: "already_forgotten";
} | {
    memoryId: MemoryId;
    kind: "not_found";
} | {
    memoryId: MemoryId;
    kind: "conflicted";
    observedStatus: MemoryStatus | null;
} | {
    memoryId: MemoryId;
    kind: "failed";
    error: string;
} | {
    memoryId: MemoryId;
    kind: "not_attempted";
};
export interface ForgetOptions {
    reason?: string;
    actor?: EventActor;
}
export interface ForgetResult {
    outcomes: ForgetOutcome[];
}
export type ConsolidateTarget = {
    memoryIds: MemoryId[];
} | {
    query: RecallQuery;
    maxCandidates?: number;
} | {
    seedMemoryId: MemoryId;
    maxCandidates?: number;
    minAffinity?: number;
};
export declare const DEFAULT_CONSOLIDATE_MIN_AFFINITY = 0.8;
export interface ConsolidateOptions {
    target: ConsolidateTarget;
    dryRun?: boolean;
    actor?: EventActor;
    reason?: string;
}
export type ConsolidateOutcome = "consolidated" | "nothing_to_consolidate" | "not_examined" | "llm_failed" | "dry_run";
export type ConsolidateNothingReason = "no_eligible_sources" | "single_eligible_source";
export type ConsolidateSourceOutcome = {
    memoryId: MemoryId;
    kind: "superseded";
    previousStatus: "active";
} | {
    memoryId: MemoryId;
    kind: "not_found";
} | {
    memoryId: MemoryId;
    kind: "status_not_active";
    status: Exclude<MemoryStatus, "active">;
} | {
    memoryId: MemoryId;
    kind: "status_changed_concurrently";
    observedStatus: MemoryStatus | null;
} | {
    memoryId: MemoryId;
    kind: "failed";
    error: string;
} | {
    memoryId: MemoryId;
    kind: "not_attempted";
} | {
    memoryId: MemoryId;
    kind: "eligible";
};
export interface ConsolidationResult {
    outcome: ConsolidateOutcome;
    atomicity: WriteAtomicity;
    nothingReason: ConsolidateNothingReason | null;
    consolidatedMemoryId: MemoryId | null;
    sources: ConsolidateSourceOutcome[];
    llmCalls: number;
    llmFailure: ExtractionFailure | null;
}
export type ReflectTarget = {
    memoryIds: MemoryId[];
} | {
    query: RecallQuery;
    maxCandidates?: number;
} | {
    seedMemoryId: MemoryId;
    maxCandidates?: number;
    minAffinity?: number;
};
export declare const DEFAULT_REFLECT_MIN_AFFINITY = 0.4;
export interface ReflectOptions {
    target: ReflectTarget;
    dryRun?: boolean;
    actor?: EventActor;
    reason?: string;
}
export type ReflectOutcome = "reflected" | "nothing_to_reflect" | "not_examined" | "llm_failed" | "dry_run";
export type ReflectNothingReason = "no_eligible_basis" | "llm_declined";
export type ReflectBasisOutcome = {
    memoryId: MemoryId;
    kind: "used";
} | {
    memoryId: MemoryId;
    kind: "not_found";
} | {
    memoryId: MemoryId;
    kind: "status_not_active";
    status: Exclude<MemoryStatus, "active">;
} | {
    memoryId: MemoryId;
    kind: "basis_is_reflected";
} | {
    memoryId: MemoryId;
    kind: "eligible";
};
export interface ReflectionResult {
    outcome: ReflectOutcome;
    nothingReason: ReflectNothingReason | null;
    reflectedMemoryId: MemoryId | null;
    basis: ReflectBasisOutcome[];
    llmCalls: number;
    llmFailure: ExtractionFailure | null;
}
export interface TickOptions {
    leaseMs: number;
    limit?: number;
    kinds?: OutboxJobKind[];
    claimedBy?: string;
}
export interface UnsupportedOutboxJob {
    jobId: string;
    kind: OutboxJobKind;
}
export interface OutboxLeaseConflict {
    jobId: string;
    kind: OutboxJobKind;
    attemptedOutcome: "complete" | "fail";
}
export interface TickResult {
    processed: number;
    failed: number;
    unsupported: UnsupportedOutboxJob[];
    leaseConflicts: OutboxLeaseConflict[];
}
export interface SweepArchiveResult {
    supported: boolean;
    archived: Array<{
        memoryId: MemoryId;
        decayFloorAt: Date;
    }>;
    reachedLimit: boolean;
}
export type RestoreArchivedTarget = {
    memoryId: MemoryId;
} | {
    memoryIds: MemoryId[];
};
export interface RestoreArchivedOptions {
    reason?: string;
    actor?: EventActor;
}
export type RestoreArchivedOutcome = {
    memoryId: MemoryId;
    kind: "restored";
    previousStatus: "archived";
    reinforceError?: string;
} | {
    memoryId: MemoryId;
    kind: "status_not_archived";
    status: Exclude<MemoryStatus, "archived">;
} | {
    memoryId: MemoryId;
    kind: "not_found";
} | {
    memoryId: MemoryId;
    kind: "conflicted";
    observedStatus: MemoryStatus | null;
} | {
    memoryId: MemoryId;
    kind: "failed";
    error: string;
} | {
    memoryId: MemoryId;
    kind: "not_attempted";
};
export interface RestoreArchivedResult {
    outcomes: RestoreArchivedOutcome[];
}
export type PurgeTarget = {
    memoryId: MemoryId;
} | {
    memoryIds: MemoryId[];
};
export interface PurgeOptions {
    reason?: string;
    actor?: EventActor;
    dryRun?: boolean;
}
export type PurgeOutcome = {
    memoryId: MemoryId;
    kind: "purged";
    previousStatus: "forgotten";
} | {
    memoryId: MemoryId;
    kind: "would_purge";
    previousStatus: "forgotten";
} | {
    memoryId: MemoryId;
    kind: "already_purged";
} | {
    memoryId: MemoryId;
    kind: "status_not_forgotten";
    status: Exclude<MemoryStatus, "forgotten">;
} | {
    memoryId: MemoryId;
    kind: "not_found";
} | {
    memoryId: MemoryId;
    kind: "conflicted";
    observedStatus: MemoryStatus | null;
} | {
    memoryId: MemoryId;
    kind: "failed";
    error: string;
} | {
    memoryId: MemoryId;
    kind: "not_attempted";
};
export interface PurgeResult {
    supported: boolean;
    outcomes: PurgeOutcome[];
}
export type MarkContestedSideOutcome = {
    memoryId: MemoryId;
    kind: "eligible";
} | {
    memoryId: MemoryId;
    kind: "not_found";
} | {
    memoryId: MemoryId;
    kind: "status_not_active";
    status: Exclude<MemoryStatus, "active">;
};
export type MarkContestedOutcome = {
    kind: "contested";
    first: Memory;
    second: Memory;
} | {
    kind: "ineligible";
    sides: [
        MarkContestedSideOutcome,
        MarkContestedSideOutcome
    ];
} | {
    kind: "conflict";
    conflicts: ReadonlyArray<{
        id: MemoryId;
        observedStatus: MemoryStatus | null;
    }>;
} | {
    kind: "not_attempted";
};
export interface MarkContestedOptions {
    actor?: EventActor;
    reason?: string;
}
export interface MarkContestedResult {
    supported: boolean;
    outcome: MarkContestedOutcome;
}
export type ResolveContestedSideOutcome = {
    memoryId: MemoryId;
    kind: "eligible";
} | {
    memoryId: MemoryId;
    kind: "not_found";
} | {
    memoryId: MemoryId;
    kind: "status_not_contested";
    status: Exclude<MemoryStatus, "contested">;
} | {
    memoryId: MemoryId;
    kind: "pair_broken";
    contestedWithId: MemoryId | null;
};
export type ContestedResolution = {
    kind: "supersede";
    winnerId: MemoryId;
} | {
    kind: "both_active";
};
export type ResolveContestedOutcome = {
    kind: "resolved";
    first: Memory;
    second: Memory;
} | {
    kind: "ineligible";
    sides: [
        ResolveContestedSideOutcome,
        ResolveContestedSideOutcome
    ];
} | {
    kind: "conflict";
    conflicts: ReadonlyArray<{
        id: MemoryId;
        observedStatus: MemoryStatus | null;
    }>;
} | {
    kind: "not_attempted";
};
export interface ResolveContestedOptions {
    actor?: EventActor;
    reason?: string;
}
export interface ResolveContestedResult {
    supported: boolean;
    outcome: ResolveContestedOutcome;
}
export interface Runtime {
    observe(ctx: Ctx, input: ObserveInput): Promise<ObserveResult>;
    tick(ctx: Ctx, opts: TickOptions): Promise<TickResult>;
    recall(ctx: Ctx, query: RecallQuery): Promise<RecallResult>;
    getRecall(ctx: Ctx, recallId: RecallId): Promise<RecallRecord | null>;
    reextract(ctx: Ctx, observationId: ObservationId): Promise<ReextractResult>;
    reembed(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult>;
    sweepArchive(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<SweepArchiveResult>;
    restoreArchived(ctx: Ctx, target: RestoreArchivedTarget, opts?: RestoreArchivedOptions): Promise<RestoreArchivedResult>;
    forget(ctx: Ctx, target: ForgetTarget, opts?: ForgetOptions): Promise<ForgetResult>;
    purge(ctx: Ctx, target: PurgeTarget, opts?: PurgeOptions): Promise<PurgeResult>;
    markContested(ctx: Ctx, firstId: MemoryId, secondId: MemoryId, opts?: MarkContestedOptions): Promise<MarkContestedResult>;
    resolveContested(ctx: Ctx, firstId: MemoryId, secondId: MemoryId, resolution: ContestedResolution, opts?: ResolveContestedOptions): Promise<ResolveContestedResult>;
    consolidate(ctx: Ctx, opts: ConsolidateOptions): Promise<ConsolidationResult>;
    reflect(ctx: Ctx, opts: ReflectOptions): Promise<ReflectionResult>;
}
export declare function createRuntime(deps: RuntimeDeps): Runtime;

// ===== dist/strategies/consolidate.d.ts =====
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import type { PromptSpec } from "../interfaces/llm-provider.js";
import type { Memory, NewMemory } from "../memory.js";
import type { ScoreBreakdown } from "../recall.js";
export declare const ConsolidationLLMResultSchema: z.ZodObject<{
    content: z.ZodString;
    digest: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type ConsolidationLLMResult = z.infer<typeof ConsolidationLLMResultSchema>;
export declare function buildConsolidationPrompt(eligible: Memory[]): PromptSpec;
export interface BuildConsolidatedMemoryParams {
    ctx: Ctx;
    eligible: Memory[];
    llmResult: ConsolidationLLMResult;
    hashContent: (content: string) => string;
    digestFallbackLength: number;
    halfLifeHours: number;
    now: Date;
    activitySeq?: number;
    halfLifeRecalls?: number;
}
export declare function buildConsolidatedMemory(params: BuildConsolidatedMemoryParams): NewMemory;
export declare function computeAffinity(score: ScoreBreakdown): number;

// ===== dist/strategies/decay.d.ts =====
export interface DecayParams {
    recordedAt: Date;
    lastReinforcedAt?: Date | null;
    strength: number;
    halfLifeHours: number;
}
export interface DecayStrategy {
    strengthAt(now: Date, params: DecayParams): number;
    floorAt(params: DecayParams, threshold?: number): Date;
}
export declare const DEFAULT_DECAY_THRESHOLD = 0.05;
export declare function decayFactor(elapsed: number, halfLife: number): number;
export declare function decayFloorOffset(strength: number, halfLife: number, threshold: number): number;
export declare const defaultDecayStrategy: DecayStrategy;
export interface ActivityDecayParams {
    baseSeq: number;
    strength: number;
    halfLifeRecalls: number;
}
export interface ActivityDecayStrategy {
    strengthAt(nowSeq: number, params: ActivityDecayParams): number;
    floorAt(params: ActivityDecayParams, threshold?: number): number;
}
export declare const defaultActivityDecayStrategy: ActivityDecayStrategy;

// ===== dist/strategies/reextract.d.ts =====
import type { MemoryId } from "../ids.js";
import type { Memory, MemoryStatus } from "../memory.js";
export type ReextractSkip = {
    kind: "status_not_active";
    memoryId: MemoryId;
    status: Exclude<MemoryStatus, "active">;
} | {
    kind: "unchanged";
    memoryId: MemoryId;
} | {
    kind: "not_examined";
    reason: "llm_failed_whole_observation" | "no_candidates";
} | {
    kind: "status_changed_concurrently";
    memoryId: MemoryId;
    observedStatus: MemoryStatus | null;
};
export declare function classifySupersedeFailure(memoryId: MemoryId, error: unknown): ReextractSkip | null;
export declare function classifyReextractTargets(existing: Memory[], contentHashes: ReadonlySet<string>): {
    toSupersede: Memory[];
    skipped: ReextractSkip[];
};

// ===== dist/strategies/reflect.d.ts =====
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import type { PromptSpec } from "../interfaces/llm-provider.js";
import type { Memory, NewMemory } from "../memory.js";
export declare const ReflectionLLMResultSchema: z.ZodDiscriminatedUnion<[
    z.ZodObject<{
        outcome: z.ZodLiteral<"reflected">;
        content: z.ZodString;
        digest: z.ZodOptional<z.ZodString>;
        tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>,
    z.ZodObject<{
        outcome: z.ZodLiteral<"nothing">;
    }, z.core.$strip>
], "outcome">;
export type ReflectionLLMResult = z.infer<typeof ReflectionLLMResultSchema>;
export type ReflectedLLMResult = Extract<ReflectionLLMResult, {
    outcome: "reflected";
}>;
export declare function buildReflectionPrompt(basis: Memory[]): PromptSpec;
export interface BuildReflectedMemoryParams {
    ctx: Ctx;
    eligible: Memory[];
    llmResult: ReflectedLLMResult;
    hashContent: (content: string) => string;
    digestFallbackLength: number;
    halfLifeHours: number;
    now: Date;
    activitySeq?: number;
    halfLifeRecalls?: number;
}
export declare function buildReflectedMemory(params: BuildReflectedMemoryParams): NewMemory;

// ===== dist/strategies/scoring.d.ts =====
import type { ScoreBreakdown } from "../recall.js";
import type { DecayClock } from "../interfaces/tenant-settings-store.js";
export interface ScoringInput {
    now: Date;
    similarity?: number;
    lexicalMatch?: number;
    tags: string[];
    queryTags: string[];
    occurredAt?: Date | null;
    recordedAt: Date;
    lastReinforcedAt?: Date | null;
    strength: number;
    halfLifeHours: number;
    decayClock?: DecayClock;
    nowSeq?: number;
    decayBaseSeq?: number | null;
    halfLifeRecalls?: number | null;
}
export type ScoringStrategy = (input: ScoringInput) => ScoreBreakdown;
export declare const MAX_FRESHNESS = 1;
export interface NonSimilarityBoundInput {
    queryTags: readonly string[];
}
export type NonSimilarityUpperBound = {
    kind: "declared";
    value: number;
    assumptions: readonly string[];
} | {
    kind: "undeclared";
    reason: string;
};
export interface BoundedScoringStrategy extends ScoringStrategy {
    nonSimilarityUpperBound(input: NonSimilarityBoundInput): NonSimilarityUpperBound;
}
export declare function isBoundedScoringStrategy(s: ScoringStrategy): s is BoundedScoringStrategy;
export declare const DEFAULT_STRATEGY_BOUND_ASSUMPTIONS: readonly string[];
export declare const defaultScoringStrategy: BoundedScoringStrategy;
