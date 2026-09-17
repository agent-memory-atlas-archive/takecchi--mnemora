# ADR 0001: ORM は Drizzle

- **状態**: 採用 (2026-09)

> **⚠ 2026-09-17 追記（名乗りの復元。本文は書き換えていない）。**
> 本文には次の3つの断定が在るが、**この repo に裏づける実測は無い。**
> - 「**Prisma Studio は vector 列を扱えない。**」（外部ツールの機能についての断定）
> - 「**Prisma 7 GA (2025-11-19) は Rust エンジンを廃し TypeScript/WASM 化した**」（外部ベンダーのリリース日・中身の断定）
> - 「**…が公式ガイドに載っている**」（Drizzle 公式ドキュメントの内容の断定。URL 無し）
>
> **【受・未検証】** この3つには出典が無い。
> ⚠ **同じ段落の他の主張は issue 番号を持つのに、この3つだけ出典が無い**——直前・直後の文は
> `prisma/prisma#26546` と `prisma/prisma#28867` を伴っている。
> ⛔ **これは「主張が誤っている」ではない。**いずれも広く知られている可能性が高い内容である。
> ⭐ **測っていない、と書くだけである。**（ADR 0219 の掃きで残ったもの）

- **文脈**:
  `packages/postgres` は `MemoryStore` / `VectorStore` / `RelationStore` / `EventStore` を1接続で実装する。
  recall は二段検索（索引が効くフィルタ段 + over-fetch した候補の再スコア段）を要求し、目次帯のカウントは
  window 関数を同一クエリで要求する（`docs/decisions/0004-decay-at-query-time.md`、`0008-absence-taxonomy.md`）。
  つまり ORM に求めるのは CRUD の生産性ではなく、**pgvector を含む動的 SQL に型を付けたまま組み立てられるか**である。
  検討の出発点には「pgvector を使う raw SQL が多い環境では Drizzle の先行事例が薄い」という観測が渡されていた。
  **この観測は調査した結果、誤りだった。事実はむしろ逆である。**この訂正自体を記録に残す。

- **検討した選択肢**:
  - **Prisma**: pgvector は今も `Unsupported("vector")` として型システムの外に置かれ、実際の読み書きは
    `$queryRaw` / `$executeRaw` の回避策止まりである。一次要望 Issue は 2023年3月からあり、
    "First class Vector support" (prisma/prisma#26546, 2025-03) は 2026-09 時点で open・マイルストーン未定。
    Prisma Studio は vector 列を扱えない。さらに Prisma 7.1.0 では `Unsupported("vector")` を原因とする
    偽のスキーマドリフト検出の回帰 (prisma/prisma#28867) が報告されている。
    **注意**: Prisma 7 GA (2025-11-19) は Rust エンジンを廃し TypeScript/WASM 化した刷新だが、これは実行エンジンの
    話であって pgvector の型サポートとは別軸である。「Prisma 7 になったから pgvector も改善した」と誤読しないこと。
    却下した理由は下記「決定理由」参照。
  - **Drizzle**: 採用（下記）。
  - **ORM を使わず raw SQL + 手書き型**: 検討したが、`MemoryStore` と `VectorStore` の interface 契約
    （冪等性・テナント分離・window 関数を使うカウント）を testkit の適合テストで機械的に検査する設計
    （`docs/architecture.md` §4「振る舞いの契約」）と相性が悪い。クエリごとに型を手で合わせる運用は、
    adapter が増えたときに崩れやすい。却下。

- **決定**:
  ORM は **Drizzle** を採用する。`packages/postgres` はこれで `MemoryStore` / `VectorStore` /
  `RelationStore` / `EventStore` を実装する。

- **理由**（優先順位順）:
  1. **pgvector が Drizzle では一級市民である。** `vector('embedding', { dimensions: 1536 })` 型、
     `cosineDistance` / `l2Distance` / `innerProduct` 等の距離関数、
     `.using('hnsw', table.embedding.op('vector_cosine_ops'))` による索引宣言が公式ガイドに載っている。
     Prisma は同じことを raw SQL に落ちて書く。
  2. **`0004-decay-at-query-time.md` の二段検索が、型の付いた動的 SQL 組み立てを要求する。**
     段1（索引が効くフィルタ + ANN）は tenant / status / decay_floor_at の組み合わせで動的に変わり、
     Prisma だとこの段がまるごと型外の raw SQL になる。
  3. **`0008-absence-taxonomy.md` の omitted 件数が `count(*) OVER ()` 等の window 関数を同一クエリで
     要求する。** Drizzle は CTE・window 関数・動的 WHERE・subquery が SQL とほぼ1:1で型が付く。
  4. 参考程度の副次的理由として、alteroid (github.com/takecchi/alteroid) が既に Drizzle を採っており
     オーナーの環境になじむ。**ただしこれは決定を左右しない。alteroid は pgvector を使っていないため、
     「pgvector × ORM」の判断材料としては使えない**（詳細は [docs/alteroid-findings.md](../alteroid-findings.md)）。

- **結果（この決定が招くもの）**:
  良い面: pgvector 関連のクエリを型システムの中に留められる。二段検索・window 関数によるカウントを
  ORM の外に逃がさずに書ける。マイグレーションが SQL に近い形で読める。

  引き受ける負債と対処:
  - **Drizzle 公式ガイドの例は `1 - cosineDistance(...)` を desc で並べる形で書かれており、この式化により
    HNSW 索引が効かない可能性が指摘されている**(drizzle-orm-docs#436)。
    ⟹ 規約: **`ORDER BY` には距離演算子の結果をそのまま昇順で書く。`1 - x` のような式にしない。**
    この規約を `testkit` の検査（`EXPLAIN` で索引が実際に使われることの確認）に含める。
  - **`drizzle-kit push` が生成する HNSW の DDL に operator class が欠落する不具合報告がある**
    (drizzle-orm#5792)。
    ⟹ 規約: **ベクトル索引の DDL は手書きのマイグレーションで管理し、`push` には任せない。**
  - **monorepo でマイグレーションを生成元パッケージの外から走らせにくいという報告がある。**
    ⟹ `packages/postgres` にマイグレーション実行の口（CLI）を1つ持たせ、他パッケージやルートから
    直接 drizzle-kit を叩かせない。

- **これが覆るとしたら**:
  - Prisma が pgvector を一級の型として扱うようになり（#26546 がクローズされ、動的 WHERE + window 関数を
    含む複雑なクエリでも型が保たれることを確認できたら）、かつ Drizzle 側の HNSW DDL・索引ヒントの不具合が
    未解消のまま残っているなら、再検討の価値がある。
  - 逆に、上記の Drizzle 側の既知不具合（#436 / #5792）が実運用で規約による回避では防ぎきれないと分かったら、
    生 SQL への部分的な後退も含めて見直す。

- **確かめていないこと**:
  - drizzle-orm-docs#436・drizzle-orm#5792 が実際にいつ解消されるかは追っていない。本 ADR の対処（規約）は
    現状で有効な回避策であり、恒久的な修正ではない。
  - monorepo でのマイグレーション運用の困難さは複数の報告から得た伝聞であり、mnemora 自身の
    monorepo 構成で実際に踏むかどうかは Phase 1 の実装時に検証する。
