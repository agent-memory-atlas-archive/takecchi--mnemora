-- 0013_recall_returned_memories_jsonb.sql
--
-- Issue #298 / ADR 0155: `recalls.returned_memory_ids`（uuid[]、memoryId だけ）を、
-- `recalls.returned_memories`（jsonb、内訳つき）へ置き換える。
--
-- ## なぜ列を「足す」のではなく「置き換える」か
--
-- 列を足すと、「この recall が何を返したか」を言う道が2つ在ることになり、
-- 独立にずれうる——このリポジトリが繰り返し踏んできた欠陥（`TICK_SUPPORTED_JOB_KINDS`
-- の JSDoc・`ForgetResult` の JSDoc が名指ししている族）。`returned_memory_ids` を
-- 削除し、`returned_memories` の1列だけを出所にする。**破壊的変更だが、0.x では
-- オーナーが許容している**（docs/autonomy.md §3）。検討した代替（正規化テーブル
-- `recall_results` 等）は ADR 0155 を参照。
--
-- ## 何を運ぶか
--
-- 各要素は `{ memoryId, score, retrievedVia, companionOf?, associationOf? }`
-- （`@mnemora/core` の `RecallRecordMemory`）。`digest`/`provenanceKind` は
-- `memories` から引けるため運ばない（ADR 0155 決定1）。
--
-- 列全体の形は `{ breakdownCaptured: boolean, memories: [...] }`。
-- **`breakdownCaptured` で「無い」と「空」を区別する**（ADR 0008 の族、Issue #298
-- 受け入れ条件5）。このマイグレーションが移行する既存行は、`returned_memory_ids` に
-- memoryId しか持っていなかった（内訳を一度も記録していない）ため
-- `breakdownCaptured: false` を書く——`memories` はその移行元の memoryId だけを持つ
-- `{memoryId}` の配列になる。マイグレーション後に書かれる新しい行は
-- `PostgresMemoryStore.createRecall` が常に `breakdownCaptured: true` を書く
-- （`packages/core/src/recall-runtime.ts` は `finalMemories` から内訳を毎回計算しており、
-- 「内訳を持たない新規行」は存在しない）。**⟹ 既存行の `returned_memory_ids` が
-- 空配列だった場合（その recall が0件を返した）でも、移行後は
-- `{breakdownCaptured: false, memories: []}` になり、新しい「0件だった」行
-- （`{breakdownCaptured: true, memories: []}`）とは `breakdownCaptured` の値で
-- 区別できる——どちらも `memories: []` という同じ顔にはしない。**
--
-- ## 手順
--
-- 1. 新しい列を NULL 許可で足す（既存行を触らずに列を追加するため）。
-- 2. 既存の `returned_memory_ids` から `breakdownCaptured: false` の値を組み立てて埋める。
--    `unnest` が0件（空配列）を返す行は `jsonb_agg` が `NULL` を返すため、
--    `COALESCE` で空配列 `[]` に倒す——さもないと「0件だった」行の `memories` が
--    `NULL` になり、`{memoryId}` の配列という契約が崩れる。
-- 3. `NOT NULL` を付ける（すべての既存行を2で埋め終えた後）。
-- 4. 旧列 `returned_memory_ids` を削除する。
--
-- ⚠ この SQL はマネージャーが手元の PostgreSQL 無しで書き、本 PR の作業者が構文・意味を
-- 確認したものだが、**本物の PostgreSQL に対しては CI（と、用意できていれば手元の
-- docker-compose の Postgres）でしか実行を確認していない**。特に `jsonb_agg` +
-- `COALESCE` が空配列側で意図どおり `'[]'::jsonb` になることは、実行結果で検算すること。

ALTER TABLE recalls ADD COLUMN returned_memories jsonb;

UPDATE recalls
SET returned_memories = jsonb_build_object(
  'breakdownCaptured', false,
  'memories', COALESCE(
    (
      SELECT jsonb_agg(jsonb_build_object('memoryId', mid))
      FROM unnest(returned_memory_ids) AS mid
    ),
    '[]'::jsonb
  )
);

ALTER TABLE recalls ALTER COLUMN returned_memories SET NOT NULL;

ALTER TABLE recalls DROP COLUMN returned_memory_ids;
