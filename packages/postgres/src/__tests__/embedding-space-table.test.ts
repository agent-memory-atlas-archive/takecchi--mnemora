import { describe, expect, it } from "vitest";
import type { EmbeddingSpaceId } from "@mnemora/core";
import {
  assertSafeIdentifier,
  embeddingSpaceIndexName,
  embeddingSpaceTableName,
} from "../embedding-space-table.js";

/**
 * `embeddingSpaceTableName` / `embeddingSpaceIndexName` の切り詰め（PostgreSQL の
 * 識別子は63バイトまで）を記録する歯。**DB を要さない純関数の検査**であり、
 * `./test-db.js` を import しない（`hnsw-ef-search-window-ceiling.test.ts` /
 * `embedding-statistics.test.ts` と同じ形）。
 *
 * ⛔ このファイルは `embedding-space-table.ts` の実装を変えるための歯ではない。
 * **いまの挙動を記録するための歯**である（ADR 0202「引き受けた負債」2番を、
 * `packages/postgres/README.md` の実測とあわせて埋める）。
 *
 * ## 背景（【実測】、接頭辞の長さの違いで索引のほうが先に頭打ちになる）
 *
 * - テーブルの接頭辞 `memory_embeddings_` = 18バイト ⟹ スラグの余地は45バイト。
 * - 索引の接頭辞 `idx_memory_embeddings_hnsw_` = 27バイト ⟹ スラグの余地は36バイト。
 * - ⟹ 索引のほうが9バイト早く上限に達する。**テーブルは切り詰められないのに
 *   索引だけ切り詰められる**組み合わせが実在する（下の「テーブルは切り詰めず
 *   索引だけ切り詰める」を見ること）。
 */

describe("embeddingSpaceTableName / embeddingSpaceIndexName", () => {
  it("切り詰めが起きない代表例: openai/text-embedding-3-small/1536（いま使われている中で最長。上限まで2バイト）", () => {
    const space: EmbeddingSpaceId = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    };

    const table = embeddingSpaceTableName(space);
    const index = embeddingSpaceIndexName(space);

    expect(table).toBe("memory_embeddings_openai_text_embedding_3_small_1536");
    expect(index).toBe("idx_memory_embeddings_hnsw_openai_text_embedding_3_small_1536");
    expect(Buffer.byteLength(table, "utf8")).toBe(52);
    expect(Buffer.byteLength(index, "utf8")).toBe(61);
  });

  it("🔴 テーブルは切り詰めず索引だけ切り詰める実例: azure-openai/text-embedding-3-large/3072", () => {
    const space: EmbeddingSpaceId = {
      provider: "azure-openai",
      model: "text-embedding-3-large",
      dimensions: 3072,
    };

    const table = embeddingSpaceTableName(space);
    const index = embeddingSpaceIndexName(space);

    // テーブルは58バイトで63バイト以内に収まり、切り詰められない
    // （末尾がハッシュ片ではなく、そのままの `<space>` で終わっている）。
    expect(table).toBe("memory_embeddings_azure_openai_text_embedding_3_large_3072");
    expect(Buffer.byteLength(table, "utf8")).toBe(58);

    // 索引は63バイトを超えるため、末尾を切り詰めて8桁のハッシュ片を足している。
    // ⟹ 索引名の末尾は、テーブル名の `<space>` 部分（"..._3_large_3072"）とは
    // 一致しない別の文字列になる——README が書く「テーブルと同じ <space> が
    // 索引名にも付く」という規則は、この場合には成立しない。
    expect(index).toBe("idx_memory_embeddings_hnsw_azure_openai_text_embedding_eb32c67b");
    expect(Buffer.byteLength(index, "utf8")).toBe(63);
    expect(index.endsWith("_eb32c67b")).toBe(true);
    expect(index.includes("3_large_3072")).toBe(false);
  });

  it("極端に長い provider/model では、テーブルも索引も切り詰められ、かつ別々のハッシュが付く", () => {
    const space: EmbeddingSpaceId = {
      provider: "a".repeat(60),
      model: "b".repeat(60),
      dimensions: 999_999,
    };

    const table = embeddingSpaceTableName(space);
    const index = embeddingSpaceIndexName(space);

    expect(Buffer.byteLength(table, "utf8")).toBeLessThanOrEqual(63);
    expect(Buffer.byteLength(index, "utf8")).toBeLessThanOrEqual(63);
    // テーブルと索引は、それぞれ別の入力（テーブルは rawSlug、索引はテーブルの
    // 切り詰め済みサフィックス）からハッシュを導くため、末尾のハッシュ片は一致しない。
    expect(table.slice(-8)).not.toBe(index.slice(-8));
  });

  it("生成される名前は常に63バイト以内である（境界を含む複数の入力で確認）", () => {
    const spaces: EmbeddingSpaceId[] = [
      { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
      { provider: "openai", model: "text-embedding-3-large", dimensions: 3072 },
      { provider: "azure-openai", model: "text-embedding-3-large", dimensions: 3072 },
      { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      { provider: "a".repeat(1), model: "b".repeat(1), dimensions: 1 },
      { provider: "a".repeat(200), model: "b".repeat(200), dimensions: 123_456_789 },
    ];

    for (const space of spaces) {
      const table = embeddingSpaceTableName(space);
      const index = embeddingSpaceIndexName(space);
      expect(
        Buffer.byteLength(table, "utf8"),
        `table "${table}" が63バイトを超えた（space=${JSON.stringify(space)}）`,
      ).toBeLessThanOrEqual(63);
      expect(
        Buffer.byteLength(index, "utf8"),
        `index "${index}" が63バイトを超えた（space=${JSON.stringify(space)}）`,
      ).toBeLessThanOrEqual(63);
    }
  });

  it("生成される名前は常に assertSafeIdentifier を通る（切り詰め・ハッシュ付与の有無に関わらず）", () => {
    const spaces: EmbeddingSpaceId[] = [
      { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
      { provider: "azure-openai", model: "text-embedding-3-large", dimensions: 3072 },
      { provider: "a".repeat(80), model: "B".repeat(80), dimensions: 42 },
      { provider: "Provider With Spaces!", model: "Model/Name.v2", dimensions: 4 },
    ];

    for (const space of spaces) {
      const table = embeddingSpaceTableName(space);
      const index = embeddingSpaceIndexName(space);
      expect(() => assertSafeIdentifier(table)).not.toThrow();
      expect(() => assertSafeIdentifier(index)).not.toThrow();
    }
  });

  it("同じ入力に対して決定的である（複数回呼んでも同じ名前を返す）", () => {
    const space: EmbeddingSpaceId = {
      provider: "azure-openai",
      model: "text-embedding-3-large",
      dimensions: 3072,
    };

    expect(embeddingSpaceTableName(space)).toBe(embeddingSpaceTableName({ ...space }));
    expect(embeddingSpaceIndexName(space)).toBe(embeddingSpaceIndexName({ ...space }));
  });
});
