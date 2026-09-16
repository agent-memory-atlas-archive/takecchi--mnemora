// ===== dist/embedding-provider.d.ts =====
import OpenAI from "openai";
import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
export interface OpenAIEmbeddingProviderOptions {
    apiKey?: string;
    model: string;
    dimensions: number;
    client?: Pick<OpenAI, "embeddings">;
}
export declare class OpenAIEmbeddingProvider implements EmbeddingProvider {
    readonly space: EmbeddingSpaceId;
    private readonly client;
    private readonly model;
    constructor(options: OpenAIEmbeddingProviderOptions);
    embed(_ctx: Ctx, texts: string[]): Promise<number[][]>;
}

// ===== dist/errors.d.ts =====
export type OpenAILLMFailureKind = "refusal" | "truncated" | "no_content";
export interface OpenAILLMProviderErrorOptions {
    kind: OpenAILLMFailureKind;
    finishReason?: string | null;
    refusalMessage?: string | null;
    message?: string;
}
export declare class OpenAILLMProviderError extends Error {
    readonly kind: OpenAILLMFailureKind;
    readonly finishReason: string | null;
    readonly refusalMessage: string | null;
    constructor(options: OpenAILLMProviderErrorOptions);
}

// ===== dist/index.d.ts =====
export * from "./embedding-provider.js";
export * from "./errors.js";
export * from "./llm-provider.js";
export * from "./json-schema.js";

// ===== dist/json-schema.d.ts =====
import { z } from "zod";
export interface OpenAIJsonSchemaFormat {
    name: string;
    schema: Record<string, unknown>;
    strict: true;
}
export declare function translateForOpenAIStructuredOutput<T>(name: string, schema: z.ZodType<T>): OpenAIJsonSchemaFormat;

// ===== dist/llm-provider.d.ts =====
import OpenAI from "openai";
import type { Ctx, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";
export interface OpenAILLMProviderOptions {
    apiKey?: string;
    model: string;
    client?: Pick<OpenAI, "chat">;
}
export declare class OpenAILLMProvider implements LLMProvider {
    private readonly client;
    private readonly model;
    constructor(options: OpenAILLMProviderOptions);
    complete(_ctx: Ctx, req: PromptSpec): Promise<LLMResponse>;
    completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T>;
}
