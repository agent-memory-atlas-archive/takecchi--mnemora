import type {
  Ctx,
  EmbeddingProvider,
  EmbeddingSpaceId,
  LLMProvider,
  LLMResponse,
  PromptMessage,
  PromptSpec,
  Runtime,
  StructuredRequest,
} from "@mnemora/core";
import { createRuntime, heuristicTokenCounter } from "@mnemora/core";
import type { PostgresClient } from "@mnemora/postgres";
import {
  PostgresEventStore,
  PostgresLexicalStore,
  PostgresMemoryStore,
  PostgresOutboxStore,
  PostgresTenantSettingsStore,
  PostgresVectorStore,
  closePostgresClient,
  createPostgresClient,
  registerEmbeddingSpace,
  runMigrations,
  sha256Hex,
} from "@mnemora/postgres";
import type { AnswerCase, AnswerVerdict } from "./answer-case.js";
import { gradeAnswer } from "./answer-case.js";
import { buildMnemoraPrompt, ingestConversation, queryRecall } from "./mnemora-path.js";
import { naivePrompt } from "./naive-path.js";
import type { CreateProvidersOptions, EnvLike, ProviderMode } from "./providers.js";
import { createProviders } from "./providers.js";
import type { Conversation, ConversationTurn } from "./scenario.js";

/**
 * `answer` サブコマンドの本体（Issue #506 / 親 #498）。
 *
 * 🔴 **この器は配線の検査であって、回答品質の測定ではない**（`answer-case.ts` 冒頭・
 * Issue #506 を参照）。1ケースにつき、naive（全文経路）と mnemora（記憶経路）を
 * **同じ会話・同じ質問・同じ回答モデル・同じ採点基準**で両方回し、最終回答と
 * 入力量を対で出す。
 */

// ---------------------------------------------------------------------------
// system 文・質問文（両経路で完全に同一にする。§2.2 決定2）
// ---------------------------------------------------------------------------

export const ANSWER_SYSTEM_PROMPT =
  "以下の会話ログだけを根拠に、簡潔に答えてください。根拠が無ければ『分かりません』と答えてください。";

/** `question` を両経路で同じ形に組み立てる（`"\n\n質問: " + question`）。 */
function buildQuestionSuffix(question: string): string {
  return `\n\n質問: ${question}`;
}

/**
 * `complete()` へ渡した `PromptSpec` を、system + messages をまとめた1つの文字列へ
 * 直列化する。**両経路がこの同じ関数で入力量を測る**（§2.2 決定2「同じ採点基準」の
 * 入力量版）。
 *
 * ⚠ `recall().usage.chars` を入力量として報告しない理由はここにある——`usage.chars`
 * は `recall()` が返した量であって、`complete()` へ実際に渡した量ではない
 * （`buildMnemoraPrompt` は目次帯の1行を足すため、両者は一致しない）。
 */
export function serializePromptSpec(spec: PromptSpec): string {
  const parts: string[] = [];
  if (spec.system !== undefined) {
    parts.push(`system: ${spec.system}`);
  }
  for (const message of spec.messages) {
    parts.push(`${message.role}: ${message.content}`);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// 追加費用を数える decorator（実 OpenAI 専用の usage-meter.ts は使えない。ADR 無し・
// 本 PR で新設する自前の薄い decorator）
// ---------------------------------------------------------------------------

export interface AnswerBenchCallCounts {
  /** `completeStructured()` 呼び出し回数——`Runtime` が抽出に使う経路（取り込み）。 */
  extractionCalls: number;
  /** `complete()` 呼び出し回数——この bench が回答生成に使う経路。 */
  answerCalls: number;
}

/**
 * `LLMProvider` を呼び出し回数を数える decorator で包む。
 *
 * `packages/core` の `Runtime` は抽出に `completeStructured()` しか使わない
 * （`runtime.ts` を実測済み——`llmProvider.complete(...)` を呼ぶ行は無い）。
 * ⟹ **`complete()` と `completeStructured()` を別のカウンタにするだけで、
 * 「取り込み（抽出）」と「回答生成」の呼び出し回数が自然に分かれる**——
 * 同じ decorator インスタンスを `Runtime` にも、この bench 自身の回答生成にも渡せる。
 *
 * ⛔ **削減率から差し引かない。** `answer-json.ts`/`answer-format.ts` は
 * この値を常に別ブロックとして出す。
 */
export class CountingLLMProvider implements LLMProvider {
  private counts: AnswerBenchCallCounts = { extractionCalls: 0, answerCalls: 0 };

  constructor(private readonly inner: LLMProvider) {}

  async complete(ctx: Ctx, req: PromptSpec): Promise<LLMResponse> {
    this.counts.answerCalls += 1;
    return this.inner.complete(ctx, req);
  }

  async completeStructured<T>(ctx: Ctx, req: StructuredRequest<T>): Promise<T> {
    this.counts.extractionCalls += 1;
    return this.inner.completeStructured(ctx, req);
  }

  /** 呼び出し側が差分を取れるよう、複製したスナップショットを返す。 */
  snapshot(): AnswerBenchCallCounts {
    return { ...this.counts };
  }
}

/** `EmbeddingProvider` を呼び出し回数（`embed()` の回数）を数える decorator で包む。 */
export class CountingEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId;
  private calls = 0;

  constructor(private readonly inner: EmbeddingProvider) {
    this.space = inner.space;
  }

  async embed(ctx: Ctx, texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return this.inner.embed(ctx, texts);
  }

  snapshot(): number {
    return this.calls;
  }
}

function diffCounts(
  before: AnswerBenchCallCounts,
  after: AnswerBenchCallCounts,
): AnswerBenchCallCounts {
  return {
    extractionCalls: after.extractionCalls - before.extractionCalls,
    answerCalls: after.answerCalls - before.answerCalls,
  };
}

// ---------------------------------------------------------------------------
// Runtime の組み立て
//
// ⚠ **`runtime-factory.ts` の `createExampleRuntime` を再利用していない。**
// 理由: 呼び出し回数を数える decorator（上記）は `createRuntime()` へ渡す**前**の
// `LLMProvider`/`EmbeddingProvider` インスタンスを包む必要があるが、
// `createExampleRuntime` は `createProviders()` の結果を内部で直接 `createRuntime()`
// へ渡してしまい、呼び出し側が provider インスタンスを差し込む口が無い
// （`ExampleRuntimeHandle` も `llmProvider` を公開していない）。既存ファイルの改変は
// `cli.ts`/`package.json`/README に限る（Issue #506 の範囲）ため、`runtime-factory.ts`
// 自体は変更せず、ここで同じ組み立て手順を独立に行う。
// ---------------------------------------------------------------------------

export interface AnswerBenchRuntimeHandle {
  runtime: Runtime;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  llmProvider: CountingLLMProvider;
  embeddingProvider: CountingEmbeddingProvider;
  close(): Promise<void>;
}

export async function createAnswerBenchRuntime(
  databaseUrl: string,
  env: EnvLike = process.env,
  providerOptions: CreateProvidersOptions = {},
): Promise<AnswerBenchRuntimeHandle> {
  const client: PostgresClient = createPostgresClient(databaseUrl);
  await runMigrations(client.pool);

  const created = createProviders(env, providerOptions);
  const llmProvider = new CountingLLMProvider(created.llmProvider);
  const embeddingProvider = new CountingEmbeddingProvider(created.embeddingProvider);
  await registerEmbeddingSpace(client.pool, embeddingProvider.space);

  const runtime = createRuntime({
    memoryStore: new PostgresMemoryStore(client.db),
    outboxStore: new PostgresOutboxStore(client.db),
    vectorStore: new PostgresVectorStore(client.db),
    lexicalStore: new PostgresLexicalStore(client.db),
    eventStore: new PostgresEventStore(client.db),
    tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
    llmProvider,
    embeddingProvider,
    hashContent: sha256Hex,
  });

  return {
    runtime,
    llmMode: created.llmMode,
    embeddingMode: created.embeddingMode,
    llmProvider,
    embeddingProvider,
    close: () => closePostgresClient(client),
  };
}

// ---------------------------------------------------------------------------
// 1ケースを両経路に通す
// ---------------------------------------------------------------------------

/** `AnswerCase.conversation` + `question` を、`ingestConversation`/`queryRecall` が
 * 要求する `Conversation`（`scenario.ts`）へ写す。**会話を生成しない**——
 * 手書きのケースの中身をそのまま並べ直すだけ。 */
function toConversation(answerCase: AnswerCase): Conversation {
  const turns: ConversationTurn[] = answerCase.conversation.map((turn, index) => ({
    index,
    role: turn.role,
    text: turn.text,
  }));
  return {
    turns,
    userUtterances: turns.filter((t) => t.role === "user"),
    query: answerCase.question,
  };
}

export interface AnswerPathMeasurement {
  promptSpec: PromptSpec;
  /** `serializePromptSpec(promptSpec)` の文字数。 */
  inputChars: number;
  /** 同じ直列化文字列に対する `heuristicTokenCounter` の概算。 */
  inputEstimatedTokens: number;
  answer: string;
  /** `gradeAnswer` の一次判定。**`answerQualityClaimable(llmMode) === false` でも計算はする**
   * （純関数なので害は無い）——表示・集計を止めるのは呼び出し側（`answer-format.ts`/
   * `answer-json.ts`）の役目である。 */
  verdict: AnswerVerdict;
}

export interface AnswerCaseCost {
  /** この1ケースの ingest（`ingestConversation`）で発生した抽出 LLM 呼び出し回数。 */
  extractionLLMCalls: number;
  /** この1ケースの ingest + recall で発生した埋め込み呼び出し回数。 */
  embeddingCalls: number;
  /** この1ケースの回答生成（naive 1回 + mnemora 1回）の LLM 呼び出し回数。常に2。 */
  answerLLMCalls: number;
}

export interface AnswerCaseRunResult {
  case: AnswerCase;
  naive: AnswerPathMeasurement;
  mnemora: AnswerPathMeasurement;
  cost: AnswerCaseCost;
}

function buildPromptMessage(content: string): PromptMessage {
  return { role: "user", content };
}

/**
 * 1ケースを両経路に通す。
 *
 * - **取り込み**: `ingestConversation`（`mnemora-path.ts`）を再利用する。ケースごとに
 *   新しいテナントを使う（`compare.ts` の `runComparison` と同じやり方——
 *   `recall()` のスコープはテナント単位であり、使い回すと前のケースの記憶を引きずる）。
 * - **記憶の列**: `buildMnemoraPrompt`（`mnemora-path.ts`）を再利用する（新しく書かない）。
 * - **system 文・質問文・`complete()` の呼び方**は両経路で完全に同一。
 */
export async function runAnswerCase(
  runtime: Runtime,
  llmProvider: CountingLLMProvider,
  embeddingProvider: CountingEmbeddingProvider,
  answerCase: AnswerCase,
  tenantPrefix: string,
): Promise<AnswerCaseRunResult> {
  const ctx: Ctx = { tenantId: `${tenantPrefix}-${answerCase.id}` };
  const conversation = toConversation(answerCase);
  const questionSuffix = buildQuestionSuffix(answerCase.question);

  const beforeIngestLLM = llmProvider.snapshot();
  const beforeIngestEmb = embeddingProvider.snapshot();
  await ingestConversation(runtime, ctx, conversation);
  const afterIngestLLM = llmProvider.snapshot();

  // 連想枠（`DEFAULT_MNEMORA_PATH_ASSOCIATION`）は既定のまま渡す——`queryRecall` の
  // 既定と同じ規律をこの bench でも保つ（明示的に外していない）。
  const recall = await queryRecall(runtime, ctx, conversation);
  const afterRecallEmb = embeddingProvider.snapshot();

  const naivePromptSpec: PromptSpec = {
    system: ANSWER_SYSTEM_PROMPT,
    messages: [buildPromptMessage(`${naivePrompt(conversation)}${questionSuffix}`)],
  };
  const mnemoraPromptSpec: PromptSpec = {
    system: ANSWER_SYSTEM_PROMPT,
    messages: [buildPromptMessage(`${buildMnemoraPrompt(recall)}${questionSuffix}`)],
  };

  const beforeAnswerLLM = llmProvider.snapshot();
  const naiveResponse = await llmProvider.complete(ctx, naivePromptSpec);
  const mnemoraResponse = await llmProvider.complete(ctx, mnemoraPromptSpec);
  const afterAnswerLLM = llmProvider.snapshot();

  const naiveSerialized = serializePromptSpec(naivePromptSpec);
  const mnemoraSerialized = serializePromptSpec(mnemoraPromptSpec);

  const extractionDiff = diffCounts(beforeIngestLLM, afterIngestLLM);
  const answerDiff = diffCounts(beforeAnswerLLM, afterAnswerLLM);

  return {
    case: answerCase,
    naive: {
      promptSpec: naivePromptSpec,
      inputChars: naiveSerialized.length,
      inputEstimatedTokens: heuristicTokenCounter.count(naiveSerialized).tokens,
      answer: naiveResponse.content,
      verdict: gradeAnswer(naiveResponse.content, answerCase.expected),
    },
    mnemora: {
      promptSpec: mnemoraPromptSpec,
      inputChars: mnemoraSerialized.length,
      inputEstimatedTokens: heuristicTokenCounter.count(mnemoraSerialized).tokens,
      answer: mnemoraResponse.content,
      verdict: gradeAnswer(mnemoraResponse.content, answerCase.expected),
    },
    cost: {
      extractionLLMCalls: extractionDiff.extractionCalls,
      embeddingCalls: afterRecallEmb - beforeIngestEmb,
      answerLLMCalls: answerDiff.answerCalls,
    },
  };
}

export async function runAnswerBench(
  runtime: Runtime,
  llmProvider: CountingLLMProvider,
  embeddingProvider: CountingEmbeddingProvider,
  cases: readonly AnswerCase[],
  tenantPrefix: string,
): Promise<AnswerCaseRunResult[]> {
  const results: AnswerCaseRunResult[] = [];
  for (const answerCase of cases) {
    results.push(
      await runAnswerCase(runtime, llmProvider, embeddingProvider, answerCase, tenantPrefix),
    );
  }
  return results;
}
