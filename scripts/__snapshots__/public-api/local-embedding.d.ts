// ===== dist/errors.d.ts =====
export type LocalEmbeddingProviderErrorKind = "input_too_long" | "unknown_input_limit";
export interface LocalEmbeddingInputTooLongDetail {
    readonly index: number;
    readonly tokens: number;
    readonly maxInputTokens: number;
    readonly characters: number;
}
export declare class LocalEmbeddingProviderError extends Error {
    readonly name = "LocalEmbeddingProviderError";
    readonly kind: LocalEmbeddingProviderErrorKind;
    readonly detail: LocalEmbeddingInputTooLongDetail | null;
    constructor(kind: LocalEmbeddingProviderErrorKind, message: string, detail?: LocalEmbeddingInputTooLongDetail | null, options?: ErrorOptions);
}
export declare function isLocalEmbeddingProviderError(value: unknown): value is LocalEmbeddingProviderError;

// ===== dist/index.d.ts =====
export * from "./errors.js";
export * from "./local-embedding-provider.js";
export * from "./pipeline.js";

// ===== dist/local-embedding-provider.d.ts =====
import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
import type { CreateLocalEmbeddingPipeline, LocalEmbeddingDtype } from "./pipeline.js";
export declare const LOCAL_EMBEDDING_PROVIDER_ID = "local";
export declare const DEFAULT_LOCAL_EMBEDDING_REPO = "sirasagi62/ruri-v3-30m-ONNX";
export declare const DEFAULT_LOCAL_EMBEDDING_DTYPE: LocalEmbeddingDtype;
export declare const DEFAULT_LOCAL_EMBEDDING_DIMENSIONS = 256;
export declare const DEFAULT_LOCAL_EMBEDDING_MODEL_ID = "ruri-v3-30m/sym";
export declare const DEFAULT_LOCAL_EMBEDDING_PREFIX = "";
export declare const DEFAULT_LOCAL_EMBEDDING_NUM_THREADS = 4;
export declare const DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS = 3;
export declare function defaultLocalEmbeddingRetryDelayMs(attempt: number): number;
export interface LocalEmbeddingRetryOptions {
    attempts?: number;
    delayMs?: (attempt: number) => number;
}
export interface LocalEmbeddingProviderOptions {
    repo?: string;
    dtype?: LocalEmbeddingDtype;
    dimensions?: number;
    modelId?: string;
    prefix?: string;
    cacheDir?: string;
    numThreads?: number;
    createPipeline?: CreateLocalEmbeddingPipeline;
    retry?: LocalEmbeddingRetryOptions;
    sleep?: (ms: number) => Promise<void>;
}
export declare class LocalEmbeddingProvider implements EmbeddingProvider {
    #private;
    readonly space: EmbeddingSpaceId;
    constructor(options?: LocalEmbeddingProviderOptions);
    warmup(): Promise<void>;
    embed(_ctx: Ctx, texts: string[]): Promise<number[][]>;
}

// ===== dist/pipeline.d.ts =====
export type LocalEmbeddingDtype = "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "q4f16";
export interface LocalEmbeddingModelSpec {
    readonly repo: string;
    readonly dtype: LocalEmbeddingDtype;
    readonly cacheDir: string | undefined;
    readonly numThreads: number;
}
export type LocalEmbeddingPipeline = (texts: string[]) => Promise<number[][]>;
export type CreateLocalEmbeddingPipeline = (spec: LocalEmbeddingModelSpec) => Promise<LocalEmbeddingPipeline>;
export interface LocalEmbeddingTokenizer {
    readonly model_max_length: number;
    encode(text: string): number[];
}
export interface LocalEmbeddingExtractor {
    (texts: string[], options: {
        pooling: "mean";
        normalize: boolean;
    }): Promise<unknown>;
    readonly tokenizer: LocalEmbeddingTokenizer;
}
export declare function buildLocalEmbeddingPipeline(extractor: LocalEmbeddingExtractor): LocalEmbeddingPipeline;
export declare function toVectors(output: unknown): number[][];
export declare const createLocalEmbeddingPipeline: CreateLocalEmbeddingPipeline;
