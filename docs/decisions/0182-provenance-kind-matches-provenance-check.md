# ADR 0182: `memories.provenance_kind` と `provenance->>'kind'` の一致を CHECK 制約で強制する — 生成列のほうが筋が良いが、いまは採らない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ」と「人から受け取った前提」を
混ぜない（[AGENTS.md](../../AGENTS.md)）。この ADR の実測は、すべて **この作業を担った本人が
`/tmp` に自前で立てた PostgreSQL 17（Docker が使えない作業環境のため、`initdb`/`pg_ctl` で
直接起動）に対して実行した**もの。300,000 行規模での実測であり、それ以上の規模は測っていない
（節「測ったこと」参照）。

---

## 文脈

[Issue #273](https://github.com/takecchi/mnemora/issues/273) が指摘した穴はこうである:

> `memories.provenance_kind`（列）は `provenance->>'kind'`（jsonb）の非正規化された複製だが、
> **両者が一致することを強制するものが無い。** 今日ずれないのは、書き込み経路
> （`packages/postgres/src/memory-store.ts` の `createMemory`/`createMemoryWithOutbox`/
> `supersedeWithNewMemories`）が3本とも同じ変数 `input.provenance.kind` から両方を書いている
> ためであり、**設計がそう強制しているからではない。** 4本目の書き込み経路が片方だけを書けば、
> 静かにずれる。ずれても実行時エラーは出ず、`excludeProvenanceKinds`（段1の ANN/lexical フィルタ、
> `packages/core/src/recall.ts`/`recall-runtime.ts` まで貫通する）が実データと違う集合を返すだけ
> である。

**非正規化そのものの理由は [ADR 0006](./0006-memory-schema.md) と
[docs/memory-model.md](../memory-model.md) §2 に書かれている**（フィルタと索引のため、
jsonb を都度展開せず `idx_memories_provenance_kind` に載せるため）。**しかし「一致をどう保証するか」
を扱った ADR は、この ADR を書くまで存在しなかった。**（Issue #273 の調査で `docs/decisions/`
全文検索を行い、確認済み。）

Issue #273 が並べた4つの方向のうち、**オーナーの判断は方向1（DB 側の CHECK 制約）である**（逐語、
コーディネータ経由）:

> Issue #273 が言っているのは「複製が在ること」ではなく「**一致を強制するものが無い**」である。
> CHECK はこの欠陥にちょうど対応する。経路が何本に増えても DB がずれを拒否するなら、
> 「注意力に依存する形」は消える。複製が残ることは別の問題であって、#273 が指摘した穴ではない。
>
> 方向2（生成列）を否定はしない。筋が良いのはそのとおりである。だが `DROP COLUMN` が索引を
> 無警告で消し、`INSERT` 3箇所の書き換えを伴い、`ACCESS EXCLUSIVE` を取る——v1.0.0 の直前に
> 入れる形ではない。

---

## 決定

`memories` に CHECK 制約 `memories_provenance_kind_matches_provenance
CHECK (provenance_kind = provenance->>'kind')` を足す。既存行の走査コストとロック時間を最小化する
ため、**`ADD CONSTRAINT ... NOT VALID` と `VALIDATE CONSTRAINT` を別々のマイグレーションファイル
（別トランザクション）に分ける**:

- `migrations/0016_provenance_kind_matches_provenance.sql`: `NOT VALID` で足す。既存行を
  走査しない（速い）が、**この時点から先のすべての INSERT/UPDATE には即座に効く**
  （`NOT VALID` が免除するのは「今日までの既存行の検査」だけで、「新しい書き込みの検査」は
  免除しない——実測、節「測ったこと」）。
- `migrations/0017_provenance_kind_matches_provenance_validate.sql`: `VALIDATE CONSTRAINT` で
  既存行を検証する。

**別ファイルに分けた理由は、単一トランザクションに同居させると2つの意味で目的を損なうと実測で
分かったため**（コーディネータからの初期の想定は「同じ1本のマイグレーションに2文」だったが、
実測の結果この ADR の決定として分離した。節「測ったこと」に実測の詳細）:

1. **ロック**: `migrate.ts` は1ファイルを1トランザクション（`BEGIN`...`COMMIT`）で包む
   （`runMigrations` の実装）。同一トランザクション内では、`ADD CONSTRAINT` が取る
   `ACCESS EXCLUSIVE` ロックは `COMMIT` まで保持され続ける——`VALIDATE CONSTRAINT` 単体が
   本来持つ「読み書きをブロックしない」性質（`SHARE UPDATE EXCLUSIVE`）が、同居させると
   失われる。
2. **失敗時の巻き戻り**: 同じトランザクションで `VALIDATE` が失敗すると、`ADD CONSTRAINT` ごと
   ロールバックされる。**「新しい書き込みだけは即座に守る」という 0016 の効果まで消える。**
   分けておけば、`0017`（既存データの検証）が失敗しても、`0016` で入れた「新規の不一致行を
   即座に拒否する」保護は commit 済みのまま残る——既存データの調査中も、新しい書き込みは
   守られ続ける。

制約名の命名は既存の値域制約と揃えた（`memories_strength_range`[0006]・
`memories_half_life_range`[0012]、`<table>_<説明>`の形）。

---

## なぜ生成列（方向2）を、いまは採らないか — 時期と費用

**方向2（`provenance_kind` を `GENERATED ALWAYS AS (provenance->>'kind') STORED` にする）は、
複製そのものを消す点で方向1より筋が良い判断だと考えている。** CHECK 制約は複製の**一致**を
強制するだけで、複製**そのもの**は残る——`schema.ts` の「読み戻す側が増えると危険」という
警告コメントは、CHECK を足したあとも成立したままである。生成列であれば、この警告コメントごと
不要になる。

**それでもいま採らなかったのは、費用がタイミングに見合わないため。** 実測（節「測ったこと」）:

- 生成列への作り替えは、PostgreSQL に「既存の通常列を生成列へ変換する」構文が無いため
  **`DROP COLUMN` → `ADD COLUMN ... GENERATED ... STORED` の組でしか実現できない**
  （`ALTER TABLE ... ALTER COLUMN x SET GENERATED ALWAYS AS (...)` は構文エラー、実測）。
- `DROP COLUMN` は依存する索引（`idx_memories_provenance_kind`）を**警告もエラーも無く暗黙に
  削除する**（実測）。索引の貼り直しが確実に要る。
- `ADD COLUMN ... GENERATED ... STORED` は既存行全部の値を再計算する**テーブル書き換え**を伴い、
  その間 `ACCESS EXCLUSIVE` を取る。300k 行で実測 約317ms（+ 索引再作成 約207ms、
  計 約525ms）。方向1の `NOT VALID`+`VALIDATE` 実測 約45ms の10倍以上で、かつ全区間ブロッキング。
- 生成列は **INSERT 文で明示的に値を渡すとエラーになる**（実測: `cannot insert a non-DEFAULT
  value into column "provenance_kind"`）。`packages/postgres/src/memory-store.ts` の3つの
  INSERT（`createMemory`/`createMemoryWithOutbox`/`supersedeWithNewMemories`）すべての書き換えが
  必須になる。

**v1.0.0 を切る直前という時期に、`ACCESS EXCLUSIVE` を伴うテーブル書き換え・索引の貼り直し・
アプリ側3箇所の書き換えを同時に持ち込む理由が無い。** Issue #273 が指摘した穴（一致を強制する
ものが無いこと）は方向1だけで塞がる。複製が残ることは #273 が指摘した穴ではない
（オーナーの判断、上記「決定」の引用）。

## 将来、生成列へ寄せるとしたら、どういう条件が揃ったときか

- **`memory-store.ts` の書き込み経路に手を入れる別の理由がすでにあるとき。** 3箇所の
  INSERT 文を書き換える費用を、別の変更（例えばバルク投入経路の見直し）と合算できるなら、
  生成列化の追加費用は小さくなる。
- **`ACCESS EXCLUSIVE` を伴うマイグレーションを許容できるメンテナンスウィンドウが取れるとき。**
  v1.0.0 のような「切る直前」ではなく、破壊的変更をまとめて出せる次のメジャーの節目
  （`docs/migration-v1.md` に前例がある、0013 の列削除のような扱い）。
- **本番相当の行数（本 ADR は300k行までしか測っていない）で、生成列化のロック時間・
  書き換え時間を再実測し、許容範囲であることを確認できたとき。**
- 上記が揃わない限り、方向1（CHECK）のまま運用してよい——CHECK は生成列化の障害にならない
  （生成列にする際、同じ `CHECK (provenance_kind IN (...))` 等はそのまま生成列にも張れることを
  実測済み。節「測ったこと」）。

---

## 測ったこと（**すべて私が実行した。PostgreSQL 17.11、`/tmp` に自前 `initdb`**）

### CHECK 制約（方向1）

| 検査 | 結果 |
|---|---|
| `CHECK (provenance_kind = provenance->>'kind')` は作成できるか（`->>` の IMMUTABLE 性） | **できた。** エラー無く `CREATE TABLE`/`ALTER TABLE ADD CONSTRAINT` が通った |
| 不一致行の INSERT | **reject された**（`violates check constraint`） |
| `ADD CONSTRAINT ... NOT VALID`（300k 行） | **1.9ms**（メタデータのみ、既存行を走査しない） |
| `NOT VALID` 直後、既存の不一致行はそのまま残るか | **残る**（走査していないため） |
| `NOT VALID` 直後、新しい不一致行の INSERT は防がれるか | **防がれた**（`NOT VALID` は新規の書き込みを免除しない） |
| `VALIDATE CONSTRAINT`（同じ300k行）単体 | **43ms** |
| `NOT VALID` を使わず直接 `ADD CONSTRAINT`（検証つき、300k行） | 41ms（参考値。方向1はどちらの経路でも生成列より一桁以上速い） |
| `ADD CONSTRAINT NOT VALID` と `VALIDATE CONSTRAINT` を**同一トランザクション**で実行したとき、他セッションの `SELECT` は | **ブロックされた**（実測: 別セッションの `SELECT count(*)` が、先行トランザクションの `COMMIT` まで約2秒ブロック——`pg_sleep(3)` を挟んで確認） |
| 同一トランザクションで `VALIDATE` が失敗した場合 | `ADD CONSTRAINT` を含め**ロールバックされる**（新規行の保護も消える） |
| **別トランザクション**（= 別マイグレーションファイル）に分けた場合、`0016` 適用後・`0017` 失敗後でも新規の不一致行は防がれるか | **防がれた**（下記「変異試験」参照。既存の1行が不一致でも `0016` は commit 済みのまま） |

### 生成列（方向2、比較のため実測）

| 検査 | 結果 |
|---|---|
| `GENERATED ALWAYS AS (provenance->>'kind') STORED` の作成 | できた。既存の2本の CHECK（値集合・`source_observation_id` 条件）・`NOT NULL`・索引との同居も確認 |
| 既存の通常列を生成列へ変換する `ALTER COLUMN` | **構文エラー**（`syntax error at or near "AS"`）。道が無い |
| 既存列の作り替え手順 | `DROP COLUMN` → `ADD COLUMN ... GENERATED ... STORED` の組のみ |
| `DROP COLUMN` が依存索引に与える影響 | **警告もエラーも無く暗黙に削除**（実測: 索引が消えていることを `pg_indexes` で確認） |
| `DROP COLUMN`（300k行） | 2.6ms（メタデータのみ） |
| `ADD COLUMN ... GENERATED ... STORED`（300k行、全行再計算） | **317.6ms**、`ACCESS EXCLUSIVE` |
| 索引の再作成（300k行） | 207.2ms |
| 生成列への明示値 INSERT | **エラー**（`cannot insert a non-DEFAULT value into column "provenance_kind" — Column "provenance_kind" is a generated column.`）——`memory-store.ts` の3箇所の書き換えが必須と確認 |

### 変異試験（既存データが実際にずれていた場合の振る舞い、これが実質的な「妥当性の裏付け」）

1. `0001`〜`0015` だけを新規データベースへ適用（v0.1.9〜v0.2.0 相当の既存 DB を模擬）。
2. **実際のコード経路**（`PostgresMemoryStore.createMemory`/`createMemoryWithOutbox`/
   `supersedeWithNewMemories`、`buildNewMemoryFixture`/`buildProvenanceFixture` で
   `stated`/`inferred`/`consolidated`/`imported`/`reflected` の5種を作成）で行を投入。
3. `0016`/`0017` を追加適用 → **両方とも成功**（`VALIDATE CONSTRAINT` が通った）。
   ⟹ **「今日ずれていない」が、コードの読解ではなく実データで裏付けられた。**
4. 別の新規データベースで `0001`〜`0015` のみ適用後、**生 SQL で意図的に不一致行を1件仕込み**
   （`provenance_kind='consolidated'`、`provenance->>'kind'='imported'`）、その後 `0016`/`0017`
   を適用: **`0016` は成功**（ledger に記録される）、**`0017` は 🔴 失敗した**
   （`check constraint "memories_provenance_kind_matches_provenance" ... is violated by some row`）。
   その後、**同じ不一致な種類の新しい行を INSERT しても reject された**
   （`0016` が commit 済みのまま新規書き込みを守り続けていることを確認）。

---

## 検討して採らなかった案（Issue #273 の方向3・4）

- **方向3（書き込み側の集約）**: 複製自体は消えず、「ヘルパを通さない4本目」を防げない
  （Issue #273 自身が指摘）。方向1と排他ではないが、方向1だけで Issue #273 の穴は塞がるため、
  追加では採らない。
- **方向4（適合テストで固定）**: `provenanceKind` は `MemoryStore` インターフェース
  （core の `Memory` 型）に出てこない——`mapping.ts` の `rowToMemory` が読み戻していないため、
  adapter 非依存の conformance suite（`packages/testkit`）からはこの列自体が見えない。
  実際に `packages/testkit/src/__fixtures__/in-memory-memory-store.ts` を確認したが、
  `provenance` のみ保持し `provenance_kind` 相当のフィールドを持たない（core の型に
  そもそも存在しないため複製しようがない）。**⟹ この複製は `packages/postgres` 固有の問題**
  であり、適合テストには乗らない。代わりに `packages/postgres/src/__tests__/
  provenance-kind-matches-provenance.postgres.test.ts` を Postgres 固有の歯として足した
  （実際の書き込み経路が一致した行しか作らないこと・生 SQL での不一致 INSERT/UPDATE が
  reject されることを検査する）。

---

## 引き受ける負債・覆えていない範囲

- **複製そのものは残る。** `provenance_kind` と `provenance` の2列に同じ情報が存在し続ける。
  `schema.ts` の「読み戻す側を増やすと、書き込みでの不一致が静かに result へ混入する経路が
  生まれる——増やさない」という警告は、CHECK を足したあとも文字どおり成立している
  （CHECK が守るのは「書き込み時に2つの値が一致すること」であって、「読み戻す側を増やしても
  安全であること」ではない）。
- **既存の実運用 DB（npm 0.2.0 利用者）に、実際にずれた行が既に存在するかどうかは分からない。**
  この作業では自前の使い捨て DB でしか検証していない。`0017` が実際の利用者の DB で失敗すれば、
  それは「発見」であり、その時点で個別に調査が必要になる（オーナーの明示の指示: その場でデータを
  直さない）。
- **300k 行を超える規模（数百万行オーダー）でのロック時間・走査時間の線形性は未検証。**
  実測は300k行のみ。
- **専用スキーマ構成**（[ADR 0057](./0057-dedicated-schema-namespace.md)、`schema` オプション）
  との組み合わせは、`migrate.ts` の `SET LOCAL search_path` の仕組みにそのまま乗る
  設計にしてある（`0006`/`0012` と同じくスキーマ名を SQL 本文にハードコードしない）が、
  専用スキーマを指定した経路での実適用は行っていない（既定スキーマでのみ実測）。

## これが覆るとしたら

- 「将来、生成列へ寄せるとしたら」節に挙げた条件が揃ったとき。
- あるいは、方向1の CHECK 制約自体が既存データで頻繁に失敗し（＝実際にずれた行が量産される
  経路が見つかり）、「一致を強制する」だけでは足りず「複製そのものを無くす」必要があると
  判明したとき。
