// ===== dist/__fixtures__/cassette-recorder.d.ts =====
import type { Ctx, EmbeddingProvider, EmbeddingSpaceId, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";
import type { Cassette } from "./cassette.js";
export declare class CassetteRecorder {
    private readonly embeddingEntries;
    private readonly llmEntries;
    private embeddingSpace;
    private llmModel;
    recordEmbedding(space: EmbeddingSpaceId, text: string, vector: number[]): void;
    recordLLM(model: string, prompt: PromptSpec, value: unknown): void;
    get embeddingCount(): number;
    get llmCount(): number;
    toCassette(now?: Date): Cassette;
}
export declare class RecordingEmbeddingProvider implements EmbeddingProvider {
    private readonly delegate;
    private readonly recorder;
    readonly space: EmbeddingSpaceId;
    constructor(delegate: EmbeddingProvider, recorder: CassetteRecorder);
    embed(ctx: Ctx, texts: string[]): Promise<number[][]>;
}
export declare class RecordingLLMProvider implements LLMProvider {
    private readonly delegate;
    private readonly recorder;
    private readonly model;
    constructor(delegate: LLMProvider, recorder: CassetteRecorder, model: string);
    complete(ctx: Ctx, req: PromptSpec): Promise<LLMResponse>;
    completeStructured<T>(ctx: Ctx, req: StructuredRequest<T>): Promise<T>;
}

// ===== dist/__fixtures__/cassette.d.ts =====
import type { EmbeddingSpaceId, PromptSpec } from "@mnemora/core";
export declare const CASSETTE_FORMAT_VERSION = 1;
export interface EmbeddingCassetteEntry {
    text: string;
    vector: number[];
}
export interface LLMCassetteEntry {
    prompt: PromptSpec;
    value: unknown;
}
export interface EmbeddingCassetteSection {
    space: EmbeddingSpaceId;
    entries: Record<string, EmbeddingCassetteEntry>;
}
export interface LLMCassetteSection {
    model: string;
    entries: Record<string, LLMCassetteEntry>;
}
export interface Cassette {
    version: number;
    recordedAt: string;
    embedding: EmbeddingCassetteSection;
    llm: LLMCassetteSection;
}
export declare function embeddingCassetteKey(text: string): string;
export declare function llmCassetteKey(prompt: PromptSpec): string;
export declare function assertCassette(value: unknown, source: string): asserts value is Cassette;

// ===== dist/__fixtures__/deterministic-embedding-provider.d.ts =====
import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
export declare class DeterministicEmbeddingProvider implements EmbeddingProvider {
    readonly space: EmbeddingSpaceId;
    constructor(space?: EmbeddingSpaceId);
    embed(_ctx: Ctx, texts: string[]): Promise<number[][]>;
    private vectorFor;
}

// ===== dist/__fixtures__/deterministic-llm-provider.d.ts =====
import type { Ctx, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";
export declare class DeterministicLLMProvider implements LLMProvider {
    complete(_ctx: Ctx, req: PromptSpec): Promise<LLMResponse>;
    completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T>;
}

// ===== dist/__fixtures__/in-memory-event-store.d.ts =====
import type { Ctx, EventFilter, EventId, EventStore, MemoryEvent, NewMemoryEvent } from "@mnemora/core";
import type { InMemoryMemoryStore } from "./in-memory-memory-store.js";
export declare function buildStoredMemoryEvent(ctx: Ctx, event: NewMemoryEvent): MemoryEvent;
export declare class InMemoryEventStore implements EventStore {
    private readonly memoryStore;
    private readonly events;
    constructor(memoryStore: InMemoryMemoryStore, events?: MemoryEvent[]);
    append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent>;
    get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null>;
    list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]>;
}

// ===== dist/__fixtures__/in-memory-lexical-store.d.ts =====
import type { Ctx, LexicalFilter, LexicalHit, LexicalStore } from "@mnemora/core";
import type { InMemoryMemoryStore } from "./in-memory-memory-store.js";
export declare class InMemoryLexicalStore implements LexicalStore {
    private readonly memoryStore;
    constructor(memoryStore: InMemoryMemoryStore);
    search(ctx: Ctx, query: string, opts: {
        limit: number;
        filter: LexicalFilter;
    }): Promise<LexicalHit[]>;
}

// ===== dist/__fixtures__/in-memory-memory-store.d.ts =====
import type { AggregateScopeOptions, ArchiveDecayedOptions, ArchiveDecayedResult, Ctx, EmbeddingStatus, Memory, MemoryEvent, MemoryId, MemoryStatus, MemoryStore, NewMemory, NewMemoryEvent, NewObservation, NewRecallRecord, Observation, ObservationId, OutboxJobKind, OutboxJobRecord, PurgeExpiredEventsOptions, PurgeExpiredEventsResult, RecallId, RecallRecord, RecallScope, ReinforceOptions, RequeueEmbedJobsOptions, RequeueEmbedJobsResult, ScopeAggregate } from "@mnemora/core";
export declare class InMemoryMemoryStore implements MemoryStore {
    private readonly observations;
    private readonly memories;
    private readonly extractionIndex;
    private readonly usages;
    readonly recalls: Map<string, NewRecallRecord & {
        tenantId: string;
        createdAt: Date;
    }>;
    readonly events: MemoryEvent[];
    readonly outboxJobs: OutboxJobRecord[];
    readonly activitySeq: Map<string, number>;
    private createObservationIdempotent;
    createObservation(ctx: Ctx, input: NewObservation): Promise<Observation>;
    getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null>;
    private enqueueOutboxJob;
    createObservationWithOutbox(ctx: Ctx, input: NewObservation, jobKinds: OutboxJobKind[]): Promise<{
        observation: Observation;
        created: boolean;
        jobs: OutboxJobRecord[];
    }>;
    private createMemoryIdempotent;
    createMemory(ctx: Ctx, input: NewMemory): Promise<Memory>;
    createMemoryWithOutbox(ctx: Ctx, input: NewMemory, jobKinds: OutboxJobKind[]): Promise<{
        memory: Memory;
        created: boolean;
        jobs: OutboxJobRecord[];
    }>;
    get(ctx: Ctx, id: MemoryId): Promise<Memory | null>;
    getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]>;
    listByTenant(ctx: Ctx): Memory[];
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
    supersedeWithNewMemories(ctx: Ctx, news: ReadonlyArray<{
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
    purgeExpiredEvents(ctx: Ctx, opts: PurgeExpiredEventsOptions): Promise<PurgeExpiredEventsResult>;
    setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory>;
    reinforce(ctx: Ctx, id: MemoryId, at: Date, opts?: ReinforceOptions): Promise<Memory>;
    recordUsage(ctx: Ctx, recallId: RecallId, memoryIds: MemoryId[]): Promise<{
        insertedMemoryIds: MemoryId[];
    }>;
    aggregateScope(ctx: Ctx, scope: RecallScope, opts?: AggregateScopeOptions): Promise<ScopeAggregate>;
    createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId>;
    getRecall(ctx: Ctx, id: RecallId): Promise<RecallRecord | null>;
    requeueEmbedJobs(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult>;
    archiveDecayed(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<ArchiveDecayedResult>;
    purgeMemory(ctx: Ctx, id: MemoryId, tombstone: {
        content: string;
        digest: string;
    }, event: NewMemoryEvent): Promise<{
        memory: Memory;
        event: MemoryEvent;
    }>;
    markContestedPair(ctx: Ctx, first: {
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
    resolveContestedPair(ctx: Ctx, first: {
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
    private extractionKey;
}

// ===== dist/__fixtures__/in-memory-outbox-store.d.ts =====
import { type ClaimOutboxJobsOptions, type Ctx, type OutboxJobRecord, type OutboxStore } from "@mnemora/core";
export declare class InMemoryOutboxStore implements OutboxStore {
    private readonly jobs;
    constructor(jobs: OutboxJobRecord[]);
    claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]>;
    complete(ctx: Ctx, jobId: string, expectedAttempts: number): Promise<void>;
    fail(ctx: Ctx, jobId: string, error: string, expectedAttempts: number): Promise<void>;
}

// ===== dist/__fixtures__/in-memory-tenant-settings-store.d.ts =====
import type { Ctx, DecayClock, EventRetention, EventRetentionSetting, TenantSettingsStore } from "@mnemora/core";
export declare class InMemoryTenantSettingsStore implements TenantSettingsStore {
    private readonly activitySeqBacking?;
    private readonly rows;
    constructor(activitySeqBacking?: Map<string, number> | undefined);
    private ensureRow;
    setDefaultHalfLifeHours(tenantId: string, hours: number): void;
    getDefaultHalfLifeHours(ctx: Ctx): Promise<number>;
    getEventRetention(ctx: Ctx): Promise<EventRetention>;
    setEventRetention(ctx: Ctx, retention: EventRetentionSetting): Promise<void>;
    getDecayClock(ctx: Ctx): Promise<DecayClock>;
    setDecayClock(ctx: Ctx, clock: DecayClock): Promise<void>;
    getDefaultHalfLifeRecalls(ctx: Ctx): Promise<number>;
    setDefaultHalfLifeRecalls(tenantId: string, recalls: number): void;
    getActivitySeq(ctx: Ctx): Promise<number>;
}

// ===== dist/__fixtures__/in-memory-vector-store.d.ts =====
import type { Ctx, EmbeddingSpaceId, MemoryId, VectorEntry, VectorFilter, VectorHit, VectorStore } from "@mnemora/core";
import type { InMemoryMemoryStore } from "./in-memory-memory-store.js";
export declare class InMemoryVectorStore implements VectorStore {
    private readonly memoryStore;
    private readonly entries;
    constructor(memoryStore: InMemoryMemoryStore);
    private key;
    upsert(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId, vector: number[]): Promise<void>;
    search(_ctx: Ctx, space: EmbeddingSpaceId, query: number[], opts: {
        limit: number;
        filter: VectorFilter;
    }): Promise<VectorHit[]>;
    delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void>;
    getVectors(ctx: Ctx, space: EmbeddingSpaceId, memoryIds: MemoryId[]): Promise<VectorEntry[]>;
}

// ===== dist/__fixtures__/recorded-embedding-provider.d.ts =====
import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
import type { EmbeddingCassetteSection } from "./cassette.js";
export interface RecordedEmbeddingProviderOptions {
    section: EmbeddingCassetteSection;
    expectedSpace?: EmbeddingSpaceId;
}
export declare class RecordedEmbeddingProvider implements EmbeddingProvider {
    readonly space: EmbeddingSpaceId;
    private readonly entries;
    constructor(options: RecordedEmbeddingProviderOptions);
    embed(_ctx: Ctx, texts: string[]): Promise<number[][]>;
}

// ===== dist/__fixtures__/recorded-llm-provider.d.ts =====
import type { Ctx, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";
import type { LLMCassetteSection } from "./cassette.js";
export interface RecordedLLMProviderOptions {
    section: LLMCassetteSection;
    expectedModel?: string;
}
export declare class RecordedLLMProvider implements LLMProvider {
    private readonly entries;
    constructor(options: RecordedLLMProviderOptions);
    private lookup;
    complete(_ctx: Ctx, req: PromptSpec): Promise<LLMResponse>;
    completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T>;
}

// ===== dist/embedding-provider-conformance.d.ts =====
import type { Ctx, EmbeddingProvider } from "@mnemora/core";
export interface EmbeddingProviderConformanceTexts {
    readonly a: string;
    readonly b: string;
    readonly c: string;
}
export interface EmbeddingProviderConformanceOptions {
    name: string;
    createProvider: () => EmbeddingProvider | Promise<EmbeddingProvider>;
    deterministic: boolean;
    texts: EmbeddingProviderConformanceTexts;
    ctx?: Ctx;
    timeout?: number;
}
export declare function describeEmbeddingProviderConformance(options: EmbeddingProviderConformanceOptions): void;

// ===== dist/event-store-conformance.d.ts =====
import type { Ctx, EventStore, MemoryId } from "@mnemora/core";
export interface EventStoreConformanceOptions {
    name: string;
    createStore: () => EventStore | Promise<EventStore>;
    prepareMemoryId: (ctx: Ctx) => Promise<MemoryId> | MemoryId;
}
export declare function describeEventStoreConformance(options: EventStoreConformanceOptions): void;

// ===== dist/fixtures.d.ts =====
export { InMemoryMemoryStore } from "./__fixtures__/in-memory-memory-store.js";
export { InMemoryVectorStore } from "./__fixtures__/in-memory-vector-store.js";
export { InMemoryLexicalStore } from "./__fixtures__/in-memory-lexical-store.js";
export { InMemoryEventStore } from "./__fixtures__/in-memory-event-store.js";
export { InMemoryOutboxStore } from "./__fixtures__/in-memory-outbox-store.js";
export { InMemoryTenantSettingsStore } from "./__fixtures__/in-memory-tenant-settings-store.js";

// ===== dist/index.d.ts =====
export * from "./memory-store-conformance.js";
export * from "./vector-store-conformance.js";
export * from "./embedding-provider-conformance.js";
export * from "./lexical-store-conformance.js";
export * from "./event-store-conformance.js";
export * from "./outbox-store-conformance.js";
export * from "./tenant-settings-store-conformance.js";
export * from "./test-data.js";
export * from "./__fixtures__/deterministic-llm-provider.js";
export * from "./__fixtures__/deterministic-embedding-provider.js";
export * from "./__fixtures__/cassette.js";
export * from "./__fixtures__/recorded-llm-provider.js";
export * from "./__fixtures__/recorded-embedding-provider.js";
export * from "./__fixtures__/cassette-recorder.js";

// ===== dist/lexical-store-conformance.d.ts =====
import type { Ctx, LexicalStore, MemoryId, MemoryStatus, ProvenanceKind } from "@mnemora/core";
export interface PrepareLexicalMemoryAttrs {
    content: string;
    status?: MemoryStatus;
    subjectId?: string;
    provenanceKind?: ProvenanceKind;
    occurredAt?: Date | null;
    recordedAt?: Date;
    validFrom?: Date | null;
    validUntil?: Date | null;
}
export interface LexicalStoreConformanceOptions {
    name: string;
    createStore: () => LexicalStore | Promise<LexicalStore>;
    prepareMemory: (ctx: Ctx, attrs: PrepareLexicalMemoryAttrs) => Promise<MemoryId> | MemoryId;
}
export declare function describeLexicalStoreConformance(options: LexicalStoreConformanceOptions): void;

// ===== dist/memory-store-conformance.d.ts =====
import type { Ctx, MemoryEvent, MemoryId, MemoryStore, OutboxJobRecord, RecallId } from "@mnemora/core";
export interface MemoryStoreConformanceOptions {
    name: string;
    createStore: () => MemoryStore | Promise<MemoryStore>;
    prepareRecallId: (ctx: Ctx) => Promise<RecallId> | RecallId;
    listEventsForMemory: (ctx: Ctx, memoryId: MemoryId) => Promise<MemoryEvent[]> | MemoryEvent[];
    claimEmbedJobs: (ctx: Ctx, now: Date) => Promise<OutboxJobRecord[]> | OutboxJobRecord[];
    supportsSupersedeWithNewMemories: boolean;
    supportsPurgeExpiredEvents: boolean;
    listPurgedEvents: (ctx: Ctx) => Promise<MemoryEvent[]> | MemoryEvent[];
    supportsArchiveDecayed: boolean;
    supportsPurgeMemory: boolean;
    supportsMarkContestedPair: boolean;
    supportsResolveContestedPair: boolean;
}
export declare function describeMemoryStoreConformance(options: MemoryStoreConformanceOptions): void;

// ===== dist/outbox-store-conformance.d.ts =====
import { type Ctx, type OutboxJobKind, type OutboxJobRecord, type OutboxStore } from "@mnemora/core";
export interface SeedOutboxJobInput {
    kind: OutboxJobKind;
    payload?: Record<string, unknown>;
    availableAt?: Date;
}
export interface OutboxStoreConformanceOptions {
    name: string;
    createStore: () => OutboxStore | Promise<OutboxStore>;
    seedJob: (ctx: Ctx, input: SeedOutboxJobInput) => Promise<OutboxJobRecord>;
}
export declare function describeOutboxStoreConformance(options: OutboxStoreConformanceOptions): void;

// ===== dist/tenant-settings-store-conformance.d.ts =====
import type { Ctx, TenantSettingsStore } from "@mnemora/core";
export interface TenantSettingsStoreConformanceOptions {
    name: string;
    createStore: () => TenantSettingsStore | Promise<TenantSettingsStore>;
    setDefaultHalfLifeHours?: (ctx: Ctx, hours: number) => Promise<void> | void;
    supportsDecayClock: boolean;
    setDefaultHalfLifeRecalls?: (ctx: Ctx, recalls: number) => Promise<void> | void;
    advanceActivitySeq?: (ctx: Ctx) => Promise<void> | void;
}
export declare function describeTenantSettingsStoreConformance(options: TenantSettingsStoreConformanceOptions): void;

// ===== dist/test-data.d.ts =====
import type { NewMemory, NewMemoryEvent, NewObservation, Provenance, ProvenanceKind } from "@mnemora/core";
export declare function buildNewMemoryFixture(overrides?: Partial<NewMemory>): NewMemory;
export declare function buildProvenanceFixture(kind: ProvenanceKind): Provenance;
export declare function buildNewObservationFixture(overrides?: Partial<NewObservation>): NewObservation;
export declare function buildNewMemoryEventFixture(overrides?: Partial<NewMemoryEvent>): NewMemoryEvent;

// ===== dist/vector-store-conformance.d.ts =====
import type { Ctx, EmbeddingSpaceId, MemoryId, MemoryStatus, ProvenanceKind, VectorStore } from "@mnemora/core";
export interface PrepareMemoryIdAttrs {
    status?: MemoryStatus;
    subjectId?: string;
    decayFloorAt?: Date;
    decayFloorSeq?: number | null;
    provenanceKind?: ProvenanceKind;
    occurredAt?: Date | null;
    recordedAt?: Date;
    validFrom?: Date | null;
    validUntil?: Date | null;
}
export interface VectorStoreConformanceOptions {
    name: string;
    createStore: () => VectorStore | Promise<VectorStore>;
    prepareMemoryId: (ctx: Ctx, attrs?: PrepareMemoryIdAttrs) => Promise<MemoryId> | MemoryId;
    prepareEmbeddingSpace: (space: EmbeddingSpaceId) => Promise<void> | void;
    supportsGetVectors: boolean;
}
export declare function describeVectorStoreConformance(options: VectorStoreConformanceOptions): void;
