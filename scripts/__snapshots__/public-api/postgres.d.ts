// ===== dist/advisory-lock.d.ts =====
import type { Pool, PoolClient } from "pg";
export declare const DEFAULT_LOCK_TIMEOUT_MS = 30000;
export declare class AdvisoryLockTimeoutError extends Error {
    constructor(message: string, cause: unknown);
}
export declare class AdvisoryLockUnavailableError extends Error {
    constructor(message: string, cause: unknown);
}
export interface AdvisoryLockErrorFactories {
    timeout: (waitedMs: number, cause: unknown) => Error;
    unavailable: (cause: unknown) => Error;
}
export declare function acquireAdvisoryLock(pool: Pool, lockKey: bigint, lockTimeoutMs: number, errors: AdvisoryLockErrorFactories): Promise<{
    client: PoolClient;
    waitedMs: number;
}>;
export declare function deriveAdvisoryLockKey(seed: string): bigint;
export declare function releaseAdvisoryLock(client: PoolClient, lockKey: bigint): Promise<void>;

// ===== dist/client.d.ts =====
import { Pool, type PoolConfig } from "pg";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
import { type SchemaNamespaceOptions } from "./schema-namespace.js";
export type Db = NodePgDatabase<typeof schema>;
export interface PostgresClient {
    pool: Pool;
    db: Db;
}
export declare function createPostgresClient(connectionString: string, config?: PoolConfig & SchemaNamespaceOptions): PostgresClient;
export declare function closePostgresClient(client: PostgresClient): Promise<void>;

// ===== dist/content-hash.d.ts =====
export declare function sha256Hex(content: string): string;

// ===== dist/embedding-space-table.d.ts =====
import type { EmbeddingSpaceId } from "@mnemora/core";
export declare function embeddingSpaceTableName(space: EmbeddingSpaceId): string;
export declare function embeddingSpaceIndexName(space: EmbeddingSpaceId): string;
export declare function assertSafeIdentifier(identifier: string): void;

// ===== dist/event-store.d.ts =====
import type { Ctx, EventFilter, EventId, EventStore, MemoryEvent, NewMemoryEvent } from "@mnemora/core";
import type { Db } from "./client.js";
export declare class PostgresEventStore implements EventStore {
    private readonly db;
    constructor(db: Db);
    append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent>;
    get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null>;
    list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]>;
}

// ===== dist/index.d.ts =====
export * from "./client.js";
export * from "./advisory-lock.js";
export * from "./memory-store.js";
export * from "./vector-store.js";
export * from "./lexical-store.js";
export * from "./event-store.js";
export * from "./outbox-store.js";
export * from "./tenant-settings-store.js";
export * from "./migrate.js";
export * from "./vector-space.js";
export * from "./embedding-space-table.js";
export * from "./content-hash.js";
export * from "./schema-namespace.js";

// ===== dist/lexical-store.d.ts =====
import type { SQL } from "drizzle-orm";
import type { Ctx, LexicalFilter, LexicalHit, LexicalStore } from "@mnemora/core";
import type { Db } from "./client.js";
export declare function buildLexicalSearchSelect(query: string, opts: {
    limit: number;
    filter: LexicalFilter;
}): SQL;
export declare class PostgresLexicalStore implements LexicalStore {
    private readonly db;
    constructor(db: Db);
    search(ctx: Ctx, query: string, opts: {
        limit: number;
        filter: LexicalFilter;
    }): Promise<LexicalHit[]>;
}

// ===== dist/memory-store.d.ts =====
import type { SQL } from "drizzle-orm";
import type { AggregateScopeOptions, ArchiveDecayedOptions, ArchiveDecayedResult, Ctx, EmbeddingStatus, Memory, MemoryEvent, MemoryId, MemoryStatus, MemoryStore, NewMemory, NewMemoryEvent, NewObservation, NewRecallRecord, Observation, ObservationId, OutboxJobKind, OutboxJobRecord, PurgeExpiredEventsOptions, PurgeExpiredEventsResult, RecallId, RecallRecord, RecallScope, ReinforceOptions, RequeueEmbedJobsOptions, RequeueEmbedJobsResult, ScopeAggregate } from "@mnemora/core";
import type { Db } from "./client.js";
export declare class PostgresMemoryStore implements MemoryStore {
    private readonly db;
    constructor(db: Db);
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
}
export declare function buildArchiveDecayedTargetSelect(ctx: Ctx, opts: ArchiveDecayedOptions): SQL;
export declare function buildRequeueEmbedTargetSelect(ctx: Ctx, opts: RequeueEmbedJobsOptions): SQL | null;
export declare function buildPurgeExpiredEventsTargetSelect(ctx: Ctx, opts: PurgeExpiredEventsOptions): SQL;

// ===== dist/migrate.d.ts =====
import type { Pool } from "pg";
import { DEFAULT_MIGRATIONS_DIR } from "./migrations-dir.cjs";
import { AdvisoryLockTimeoutError, AdvisoryLockUnavailableError } from "./advisory-lock.js";
import { type SchemaNamespaceOptions } from "./schema-namespace.js";
export { DEFAULT_MIGRATIONS_DIR };
export declare const MIGRATION_LOCK_KEY = 7190158676462701299n;
export declare const REQUIRED_EXTENSIONS: readonly [
    "vector",
    "btree_gin",
    "pgcrypto"
];
export declare function matchCreateExtensionLines(sql: string): Array<{
    readonly line: string;
    readonly name: string;
}>;
export declare function stripCreateExtensionStatements(sql: string): {
    readonly sql: string;
    readonly removed: readonly string[];
};
export type ExtensionMode = "create" | "verify";
export declare class MissingExtensionsError extends Error {
    readonly missing: readonly string[];
    constructor(missing: readonly string[], extensionSchema: string | undefined);
}
export interface RunMigrationsOptions extends SchemaNamespaceOptions {
    lockTimeoutMs?: number;
    lockKey?: bigint;
    extensionMode?: ExtensionMode;
}
export declare function migrationLockKeyFor(schema?: string): bigint;
export interface RunMigrationsResult {
    applied: string[];
    lock: {
        waitedMs: number;
    };
    extensionCheck?: {
        verified: readonly string[];
    };
}
export declare class MigrationLockTimeoutError extends AdvisoryLockTimeoutError {
    constructor(waitedMs: number, cause: unknown);
}
export declare class MigrationLockUnavailableError extends AdvisoryLockUnavailableError {
    constructor(cause: unknown);
}
export declare function listMigrationFiles(migrationsDir: string): string[];
export declare function runMigrations(pool: Pool, migrationsDir?: string, options?: RunMigrationsOptions): Promise<RunMigrationsResult>;
export interface AnalyzeMemoriesOptions {
    schema?: string;
}
export interface AnalyzeMemoriesResult {
    table: string;
}
export declare function runAnalyzeMemories(pool: Pool, options?: AnalyzeMemoriesOptions): Promise<AnalyzeMemoriesResult>;

// ===== dist/migrations-dir.d.cts =====
export declare const DEFAULT_MIGRATIONS_DIR: string;

// ===== dist/outbox-store.d.ts =====
import { type ClaimOutboxJobsOptions, type Ctx, type OutboxJobRecord, type OutboxStore } from "@mnemora/core";
import type { Db } from "./client.js";
export declare class PostgresOutboxStore implements OutboxStore {
    private readonly db;
    constructor(db: Db);
    claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]>;
    complete(ctx: Ctx, jobId: string, expectedAttempts: number): Promise<void>;
    fail(ctx: Ctx, jobId: string, error: string, expectedAttempts: number): Promise<void>;
    private raiseIfLeaseConflict;
}

// ===== dist/schema-namespace.d.ts =====
export declare const DEFAULT_EXTENSION_SCHEMA = "public";
export interface SchemaNamespaceOptions {
    schema?: string;
    extensionSchema?: string;
}
export declare function assertSafeSchemaName(schema: string): void;
export declare function qualify(schema: string | undefined, name: string): string;
export declare function qualifiedLiteral(schema: string | undefined, name: string): string;
export declare function searchPathFor(schema: string, extensionSchema: string): string;

// ===== dist/schema.d.ts =====
export declare const observations: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "observations";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "observations";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        tenantId: import("drizzle-orm/pg-core").PgColumn<{
            name: "tenant_id";
            tableName: "observations";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        subjectId: import("drizzle-orm/pg-core").PgColumn<{
            name: "subject_id";
            tableName: "observations";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        externalId: import("drizzle-orm/pg-core").PgColumn<{
            name: "external_id";
            tableName: "observations";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        kind: import("drizzle-orm/pg-core").PgColumn<{
            name: "kind";
            tableName: "observations";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        payload: import("drizzle-orm/pg-core").PgColumn<{
            name: "payload";
            tableName: "observations";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        occurredAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "occurred_at";
            tableName: "observations";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        recordedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "recorded_at";
            tableName: "observations";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        validFrom: import("drizzle-orm/pg-core").PgColumn<{
            name: "valid_from";
            tableName: "observations";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        validUntil: import("drizzle-orm/pg-core").PgColumn<{
            name: "valid_until";
            tableName: "observations";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export declare const memories: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "memories";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "memories";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        tenantId: import("drizzle-orm/pg-core").PgColumn<{
            name: "tenant_id";
            tableName: "memories";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        subjectId: import("drizzle-orm/pg-core").PgColumn<{
            name: "subject_id";
            tableName: "memories";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        sourceObservationId: import("drizzle-orm/pg-core").PgColumn<{
            name: "source_observation_id";
            tableName: "memories";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        extractorVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "extractor_version";
            tableName: "memories";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        content: import("drizzle-orm/pg-core").PgColumn<{
            name: "content";
            tableName: "memories";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        contentHash: import("drizzle-orm/pg-core").PgColumn<{
            name: "content_hash";
            tableName: "memories";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        digest: import("drizzle-orm/pg-core").PgColumn<{
            name: "digest";
            tableName: "memories";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        digestSource: import("drizzle-orm/pg-core").PgColumn<{
            name: "digest_source";
            tableName: "memories";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        provenanceKind: import("drizzle-orm/pg-core").PgColumn<{
            name: "provenance_kind";
            tableName: "memories";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        provenance: import("drizzle-orm/pg-core").PgColumn<{
            name: "provenance";
            tableName: "memories";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        status: import("drizzle-orm/pg-core").PgColumn<{
            name: "status";
            tableName: "memories";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        supersededById: import("drizzle-orm/pg-core").PgColumn<{
            name: "superseded_by_id";
            tableName: "memories";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        contestedWithId: import("drizzle-orm/pg-core").PgColumn<{
            name: "contested_with_id";
            tableName: "memories";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        tags: import("drizzle-orm/pg-core").PgColumn<{
            name: "tags";
            tableName: "memories";
            dataType: "array";
            columnType: "PgArray";
            data: string[];
            driverParam: string | string[];
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: import("drizzle-orm").Column<{
                name: "tags";
                tableName: "memories";
                dataType: "string";
                columnType: "PgText";
                data: string;
                driverParam: string;
                notNull: false;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [
                    string,
                    ...string[]
                ];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {}>;
            identity: undefined;
            generated: undefined;
        }, {}, {
            baseBuilder: import("drizzle-orm/pg-core").PgColumnBuilder<{
                name: "tags";
                dataType: "string";
                columnType: "PgText";
                data: string;
                enumValues: [
                    string,
                    ...string[]
                ];
                driverParam: string;
            }, {}, {}, import("drizzle-orm").ColumnBuilderExtraConfig>;
            size: undefined;
        }>;
        occurredAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "occurred_at";
            tableName: "memories";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        recordedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "recorded_at";
            tableName: "memories";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lastReinforcedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "last_reinforced_at";
            tableName: "memories";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        validFrom: import("drizzle-orm/pg-core").PgColumn<{
            name: "valid_from";
            tableName: "memories";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        validUntil: import("drizzle-orm/pg-core").PgColumn<{
            name: "valid_until";
            tableName: "memories";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        strength: import("drizzle-orm/pg-core").PgColumn<{
            name: "strength";
            tableName: "memories";
            dataType: "number";
            columnType: "PgReal";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        halfLifeHours: import("drizzle-orm/pg-core").PgColumn<{
            name: "half_life_hours";
            tableName: "memories";
            dataType: "number";
            columnType: "PgReal";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        decayFloorAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "decay_floor_at";
            tableName: "memories";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        decayBaseSeq: import("drizzle-orm/pg-core").PgColumn<{
            name: "decay_base_seq";
            tableName: "memories";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        decayFloorSeq: import("drizzle-orm/pg-core").PgColumn<{
            name: "decay_floor_seq";
            tableName: "memories";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        halfLifeRecalls: import("drizzle-orm/pg-core").PgColumn<{
            name: "half_life_recalls";
            tableName: "memories";
            dataType: "number";
            columnType: "PgReal";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        embeddingStatus: import("drizzle-orm/pg-core").PgColumn<{
            name: "embedding_status";
            tableName: "memories";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        purgedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "purged_at";
            tableName: "memories";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "memories";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "memories";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export declare const memoryEvents: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "memory_events";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "memory_events";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        tenantId: import("drizzle-orm/pg-core").PgColumn<{
            name: "tenant_id";
            tableName: "memory_events";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        memoryId: import("drizzle-orm/pg-core").PgColumn<{
            name: "memory_id";
            tableName: "memory_events";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        kind: import("drizzle-orm/pg-core").PgColumn<{
            name: "kind";
            tableName: "memory_events";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        at: import("drizzle-orm/pg-core").PgColumn<{
            name: "at";
            tableName: "memory_events";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        actor: import("drizzle-orm/pg-core").PgColumn<{
            name: "actor";
            tableName: "memory_events";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        digestSnapshot: import("drizzle-orm/pg-core").PgColumn<{
            name: "digest_snapshot";
            tableName: "memory_events";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        sizeBeforeBytes: import("drizzle-orm/pg-core").PgColumn<{
            name: "size_before_bytes";
            tableName: "memory_events";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        meta: import("drizzle-orm/pg-core").PgColumn<{
            name: "meta";
            tableName: "memory_events";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export declare const recalls: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "recalls";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "recalls";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        tenantId: import("drizzle-orm/pg-core").PgColumn<{
            name: "tenant_id";
            tableName: "recalls";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        subjectId: import("drizzle-orm/pg-core").PgColumn<{
            name: "subject_id";
            tableName: "recalls";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        query: import("drizzle-orm/pg-core").PgColumn<{
            name: "query";
            tableName: "recalls";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        budget: import("drizzle-orm/pg-core").PgColumn<{
            name: "budget";
            tableName: "recalls";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        omitted: import("drizzle-orm/pg-core").PgColumn<{
            name: "omitted";
            tableName: "recalls";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        usage: import("drizzle-orm/pg-core").PgColumn<{
            name: "usage";
            tableName: "recalls";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        indexBand: import("drizzle-orm/pg-core").PgColumn<{
            name: "index_band";
            tableName: "recalls";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        explain: import("drizzle-orm/pg-core").PgColumn<{
            name: "explain";
            tableName: "recalls";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        returnedMemories: import("drizzle-orm/pg-core").PgColumn<{
            name: "returned_memories";
            tableName: "recalls";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "recalls";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export declare const recallUsages: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "recall_usages";
    schema: undefined;
    columns: {
        tenantId: import("drizzle-orm/pg-core").PgColumn<{
            name: "tenant_id";
            tableName: "recall_usages";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        recallId: import("drizzle-orm/pg-core").PgColumn<{
            name: "recall_id";
            tableName: "recall_usages";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        memoryId: import("drizzle-orm/pg-core").PgColumn<{
            name: "memory_id";
            tableName: "recall_usages";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        usedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "used_at";
            tableName: "recall_usages";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export declare const outbox: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "outbox";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "outbox";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        tenantId: import("drizzle-orm/pg-core").PgColumn<{
            name: "tenant_id";
            tableName: "outbox";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        kind: import("drizzle-orm/pg-core").PgColumn<{
            name: "kind";
            tableName: "outbox";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        payload: import("drizzle-orm/pg-core").PgColumn<{
            name: "payload";
            tableName: "outbox";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        availableAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "available_at";
            tableName: "outbox";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        claimedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "claimed_at";
            tableName: "outbox";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        claimedBy: import("drizzle-orm/pg-core").PgColumn<{
            name: "claimed_by";
            tableName: "outbox";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        attempts: import("drizzle-orm/pg-core").PgColumn<{
            name: "attempts";
            tableName: "outbox";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        completedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "completed_at";
            tableName: "outbox";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        failedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "failed_at";
            tableName: "outbox";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lastError: import("drizzle-orm/pg-core").PgColumn<{
            name: "last_error";
            tableName: "outbox";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "outbox";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export declare const tenantSettings: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "tenant_settings";
    schema: undefined;
    columns: {
        tenantId: import("drizzle-orm/pg-core").PgColumn<{
            name: "tenant_id";
            tableName: "tenant_settings";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        defaultHalfLifeHours: import("drizzle-orm/pg-core").PgColumn<{
            name: "default_half_life_hours";
            tableName: "tenant_settings";
            dataType: "number";
            columnType: "PgReal";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        eventRetentionDays: import("drizzle-orm/pg-core").PgColumn<{
            name: "event_retention_days";
            tableName: "tenant_settings";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        taxonomyMode: import("drizzle-orm/pg-core").PgColumn<{
            name: "taxonomy_mode";
            tableName: "tenant_settings";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        decayClock: import("drizzle-orm/pg-core").PgColumn<{
            name: "decay_clock";
            tableName: "tenant_settings";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        defaultHalfLifeRecalls: import("drizzle-orm/pg-core").PgColumn<{
            name: "default_half_life_recalls";
            tableName: "tenant_settings";
            dataType: "number";
            columnType: "PgReal";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "tenant_settings";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "tenant_settings";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export declare const tenantActivity: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "tenant_activity";
    schema: undefined;
    columns: {
        tenantId: import("drizzle-orm/pg-core").PgColumn<{
            name: "tenant_id";
            tableName: "tenant_activity";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [
                string,
                ...string[]
            ];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        activitySeq: import("drizzle-orm/pg-core").PgColumn<{
            name: "activity_seq";
            tableName: "tenant_activity";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "tenant_activity";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;

// ===== dist/tenant-settings-store.d.ts =====
import type { Ctx, DecayClock, EventRetention, EventRetentionSetting, TenantSettingsStore } from "@mnemora/core";
import type { Db } from "./client.js";
export declare class PostgresTenantSettingsStore implements TenantSettingsStore {
    private readonly db;
    constructor(db: Db);
    getDefaultHalfLifeHours(ctx: Ctx): Promise<number>;
    getEventRetention(ctx: Ctx): Promise<EventRetention>;
    setEventRetention(ctx: Ctx, retention: EventRetentionSetting): Promise<void>;
    getDecayClock(ctx: Ctx): Promise<DecayClock>;
    setDecayClock(ctx: Ctx, clock: DecayClock): Promise<void>;
    getDefaultHalfLifeRecalls(ctx: Ctx): Promise<number>;
    getActivitySeq(ctx: Ctx): Promise<number>;
}

// ===== dist/vector-space.d.ts =====
import type { Pool } from "pg";
import type { EmbeddingSpaceId } from "@mnemora/core";
import { AdvisoryLockTimeoutError, AdvisoryLockUnavailableError } from "./advisory-lock.js";
import { type SchemaNamespaceOptions } from "./schema-namespace.js";
export declare const REGISTER_EMBEDDING_SPACE_LOCK_KEY = -4359922960011245935n;
export interface RegisterEmbeddingSpaceOptions extends SchemaNamespaceOptions {
    lockTimeoutMs?: number;
    lockKey?: bigint;
}
export declare function registerEmbeddingSpaceLockKeyFor(schema?: string): bigint;
export interface RegisterEmbeddingSpaceResult {
    lock: {
        waitedMs: number;
    };
}
export declare class RegisterEmbeddingSpaceLockTimeoutError extends AdvisoryLockTimeoutError {
    constructor(waitedMs: number, cause: unknown);
}
export declare class RegisterEmbeddingSpaceLockUnavailableError extends AdvisoryLockUnavailableError {
    constructor(cause: unknown);
}
export declare function registerEmbeddingSpace(pool: Pool, space: EmbeddingSpaceId, options?: RegisterEmbeddingSpaceOptions): Promise<RegisterEmbeddingSpaceResult>;

// ===== dist/vector-store.d.ts =====
import type { Ctx, EmbeddingSpaceId, MemoryId, VectorEntry, VectorFilter, VectorHit, VectorStore } from "@mnemora/core";
import type { Db } from "./client.js";
export declare class PostgresVectorStore implements VectorStore {
    private readonly db;
    constructor(db: Db);
    upsert(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId, vector: number[]): Promise<void>;
    search(ctx: Ctx, space: EmbeddingSpaceId, query: number[], opts: {
        limit: number;
        filter: VectorFilter;
    }): Promise<VectorHit[]>;
    delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void>;
    getVectors(ctx: Ctx, space: EmbeddingSpaceId, memoryIds: MemoryId[]): Promise<VectorEntry[]>;
}
