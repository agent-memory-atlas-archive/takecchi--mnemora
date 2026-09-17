# 適合テストが何を検証し、何を検証していないか

**この文書は、`@mnemora/testkit` の適合テスト（conformance suite）の
「保証の範囲」と「範囲の外」を1箇所に集める。**

**⭐ 何のために在るか。**適合テストは緑になる。**しかし「何が緑になったのか」は、
suite ごと・呼び出し元ごとに違う。**この文書が無いと、採用する側も次の担い手も、
**緑を実際より広く読む。**

**⚠ この文書は provider の4層（`deterministic` / `recorded` / `openai` / `local`）を
説明しない。**それは [AGENTS.md](../AGENTS.md)「いまの状態」の表が正文である。
**複製した瞬間から、正文と要約はずれ始める**——ここでは**指すだけ**にする。

**根拠の種別**: **【現物】** = `main` = `18a8a09`（2026-09-17）のコードを読んで数えた。
**【実測】** = 書き手がこの器で実際に走らせた、または取得した。

---

## 1. 何が在るか — 7 suite・合計 288 it【現物】

`packages/testkit/src/*-conformance.ts` の `it` / `maybeIt` を数えた。

| suite | it | 住所 |
|---|---|---|
| `EmbeddingProvider` | **9** | `packages/testkit/src/embedding-provider-conformance.ts` |
| `EventStore` | 16 | `packages/testkit/src/event-store-conformance.ts` |
| `LexicalStore` | 21 | `packages/testkit/src/lexical-store-conformance.ts` |
| `MemoryStore` | **177** | `packages/testkit/src/memory-store-conformance.ts` |
| `OutboxStore` | 15 | `packages/testkit/src/outbox-store-conformance.ts` |
| `TenantSettingsStore` | 17 | `packages/testkit/src/tenant-settings-store-conformance.ts` |
| `VectorStore` | 33 | `packages/testkit/src/vector-store-conformance.ts` |
| **合計** | **288** | |

### 🔴 `LLMProvider` の適合 suite は、存在しない

`describeLLMProviderConformance` は**0件**である【現物】。
`packages/testkit/src/` に `llm-provider-conformance.ts` は無い。

⟹ **`@mnemora/openai` の `OpenAILLMProvider` も `@mnemora/anthropic` の
`AnthropicLLMProvider` も、適合テストに一度も当たっていない。**
両実装が同じ契約に従うことは `packages/anthropic/src/__tests__/provider-parity.test.ts`
が見ているが、**それは2実装を突き合わせる歯であって、契約そのものの歯ではない。**

**これは [ADR 0099](./decisions/0099-conformance-against-real-embedding-providers.md) が
「確かめていないこと」に自分で書き残している**（逐語）:

> **`LLMProvider` の適合テストは今も無い**（ADR 0072 負債1の埋め込み側だけを
> 返済した状態が続く）。

---

## 2. どの実装に、実際に当たっているか【現物】

### 2.1 store 系6 suite

**当たっている先は2つだけである。**

| 呼び出し元 | 当たる実装 | CI で走るか |
|---|---|---|
| `packages/testkit/src/__tests__/in-memory-fixtures.conformance.test.ts` の6つの `describe*Conformance({` 呼び出し（`describeMemoryStoreConformance` / `describeVectorStoreConformance` / `describeLexicalStoreConformance` / `describeEventStoreConformance` / `describeOutboxStoreConformance` / `describeTenantSettingsStoreConformance`） | in-memory の擬似物（`__fixtures__/in-memory-*.ts`） | **走る**（常時） |
| `packages/postgres/src/__tests__/conformance.postgres.test.ts` の6つの `describe*Conformance({` 呼び出し（`describeMemoryStoreConformance` / `describeEventStoreConformance` / `describeVectorStoreConformance` / `describeLexicalStoreConformance` / `describeOutboxStoreConformance` / `describeTenantSettingsStoreConformance`） | **本物の Postgres + pgvector** | **走る**（`DATABASE_URL` 必須。無いと fail する——擬似物へ黙って倒れない） |

### 2.2 `EmbeddingProvider` suite — 呼び出し元は6箇所

| # | 呼び出し元 | 当たる実装 | CI で走るか |
|---|---|---|---|
| 1 | `packages/testkit/src/__tests__/embedding-provider-fixtures.conformance.test.ts:17` | `DeterministicEmbeddingProvider` | **走る** |
| 2 | 同上 `:58` | `RecordedEmbeddingProvider`（**テスト内で合成したカセット**。実 API の記録ではない） | **走る** |
| 3 | `packages/local-embedding/src/__tests__/local-embedding-provider.conformance.test.ts` の `describeEmbeddingProviderConformance({` | `LocalEmbeddingProvider` ＋ 注入した replay pipeline（`fixtures/real-ruri-embeddings.json` = **本物の推論を1回録ったもの**。重みは落とさない） | **走る** |
| 4 | `packages/local-embedding/src/__tests__/live.local-embedding.test.ts:379` | **本物の `LocalEmbeddingProvider`**（実際に ONNX の重みを落としてプロセス内推論） | 🔴 **走らない** |
| 5 | `packages/openai/src/__tests__/embedding-provider.conformance.test.ts:143` | `OpenAIEmbeddingProvider` ＋ 注入 client（`fixtures/recorded-openai-embeddings.json` の再生） | **走る** |
| 6 | `packages/openai/src/__tests__/live.openai.test.ts:106` | **実 API** | 🔴 **走らない** |

⟹ **6箇所のうち「本物に当たる」のは #4 と #6 の2つだけで、その2つが走っていない。**

---

## 3. 🔴 構造的に一度も走らない歯 — 4ファイル・28 it【現物】

**数え方**: 「CI のいまの構成では、どんな入力でも通過しない `it`」を **it 単位**で数えた。

| ファイル | 必要な env | it |
|---|---|---|
| `packages/anthropic/src/__tests__/live.anthropic.test.ts` | `ANTHROPIC_API_KEY` **かつ** `MNEMORA_LIVE_ANTHROPIC` | 2 |
| `packages/openai/src/__tests__/live.openai.test.ts` | `OPENAI_API_KEY` **かつ** `MNEMORA_LIVE_OPENAI` | **11**（直下2 ＋ 適合テスト9） |
| `packages/local-embedding/src/__tests__/live.local-embedding.test.ts` | `MNEMORA_LIVE_LOCAL_EMBEDDING` | **14**（直下5 ＋ 適合テスト9） |
| `packages/local-embedding/src/__tests__/live.cache-warm-network-behaviour.test.ts` | `MNEMORA_LIVE_LOCAL_EMBEDDING` | 1 |
| **合計** | | **28** |

**`.github/workflows/ci.yml` に、この4つの env は設定値として1つも無い**【現物】
（`grep` で出るのはコメント中の言及だけである）。

**⚠ これは「意図された設計」である。**鍵が在る環境で全体の門を走らせると黙って課金される
（[ADR 0019](./decisions/0019-real-openai-measurement-cost.md) §5c は、**その事故が
実際に踏まれた**ことを記録している）。二重 opt-in は、その再発を防ぐためにある。
**⟹ 直すべき欠陥ではない。読み違えるべきでない事実である。**

### ⚠ 読み違えやすいところ — 「無条件7本」は無条件ではない

[Issue #142](https://github.com/takecchi/mnemora/issues/142) は
「**無条件7本**が緑かを見る」と書いている。**これは「env が無くても走る7本」ではない。**

`packages/openai/src/__tests__/live.openai.test.ts` の **11本はすべて `live` gate の下に在る**
【現物: `:43` / `:53` の `it.skipIf(!live)`、`:103` の `describe.skipIf(!live)`。
`live` の定義は `:40`】。

**「無条件7本」の正しい意味**: *gate が開いた後*、適合テスト9本のうち
**決定性に依存する2本**（`maybeIt`。`deterministic: false` のとき自動で `it.skip` になる）を
除いた7本、という意味である。⟹ **gate 自体は一度も開いていない。**

---

## 4. 🔴 `deterministic: false` は「測って非決定的だった」ではない

| 呼び出し口 | `deterministic` | 根拠 |
|---|---|---|
| `LocalEmbeddingProvider`（本物のモデル、live） | `true` | ⭐ **実測**（768成分を要素ごとに比較して不一致0件・最大絶対差0） |
| `OpenAIEmbeddingProvider`（**実 API**、live） | `false` | ❌ **実測ではない。**「実 API の再現性の保証を持っていない」という*理由*で `false` にしただけで、**実際に非決定的かどうかは測っていない。** |

⟹ **この2つの `false` を同じものとして読まないこと。**
ADR 0095 §7 が逐語でこう書いている:

> **実 API の埋め込みが決定的かを測っていない**（3.1 の根拠は「保証を持っていない」であり、
> 「非決定的だと実測した」ではない）。

---

## 5. ⭐ 適合テストは「実際にどのモデルを読み込んでいるか」を見ていない

**`space` は `(provider, model, dimensions)` という宣言であって、読み込んだ重みの素性ではない。**
`LocalEmbeddingProvider` のコンストラクタは
`model: options.modelId ?? DEFAULT_LOCAL_EMBEDDING_MODEL_ID` を `space` に入れるだけで、
**実際に読み込んだモデルから導出していない**【現物:
`packages/local-embedding/src/local-embedding-provider.ts`。`DEFAULT_LOCAL_EMBEDDING_REPO` は `:23`、
`DEFAULT_LOCAL_EMBEDDING_MODEL_ID` は `:50`】。

**ADR 0099 の変異試験の陰性対照がこれを名指しした**（逐語）:

> 🔴 **適合テストは「どのモデルを実際に読み込んでいるか」を見ていない。**変異試験の
> 陰性対照でこれを確認した——`DEFAULT_LOCAL_EMBEDDING_REPO` をまったく別の repo 文字列に
> 変えても、適合テスト11本は**全部緑のまま**だった。（中略）**この穴は塞いでいない。**

### なぜ効くか

`EmbeddingSpaceId` は**テーブル名スラグの導出元**である（`docs/memory-model.md`）。
`space.model` が同じまま実際のモデルだけが入れ替わると、
**別のモデルのベクトルが同じ space のテーブルへ混ざる。**
混ざったことは検索結果が少し悪くなる形でしか現れず、**後から分けられない。**

### 🔴 ⭐ config のメタデータを照合する「弱い版」では塞げない【実測】2026-09-17

**「読み込んだモデルの `config.json` を見て素性を assert すればよい」は、効かない。**

`sirasagi62/ruri-v3-30m-ONNX` の `config.json` を実際に取得して確かめた:

```json
{
  "_name_or_path": "cl-nagoya/ruri-v3-30m",
  "architectures": ["ModernBertModel"],
  "model_type": "modernbert",
  "hidden_size": 256
}
```

⟹ 🔴 **`_name_or_path` は ONNX の変換「元」（`cl-nagoya/ruri-v3-30m`）を指しており、
実際に読み込んだ repo id（`sirasagi62/ruri-v3-30m-ONNX`）ではない。**
⟹ **同じ変換元から作られた別の ONNX repo に差し替えられても、この値では区別できない。**

⚠ **これは Issue #142 の本文にも、コード内のコメントにも書かれていなかった。**
**この文書が初出である。**⟹ **次に「config を見れば済むのでは」と考えた人が、
同じ調査を繰り返さずに済むように、ここに残す。**

**補足**【現物】: `@huggingface/transformers` の実装は `config.json` の全フィールドを
実行時にそのまま載せるが（`src/configs.js`）、**「実際に渡した repo 引数」を
明示的に設定してはいない。**そして `packages/local-embedding/src/pipeline.ts` の
`LocalEmbeddingExtractor` interface は `.model` を**意図的に含めていない**
（`@huggingface/transformers` の型を公開の型に出さないため。同ファイルの `LocalEmbeddingTokenizer` の doc コメント、逐語「**`@huggingface/transformers` の型をそのまま公開の型に出さない**」）。
⟹ **ライブラリ層には手段が在るが、このパッケージの抽象境界がそれを捨てている。**

### ⭐ 「強い版」の材料は、既に揃っている

`packages/local-embedding/src/__tests__/fixtures/real-ruri-embeddings.json` に
**本物の推論値が既に在る**（`provenance.determinismCheck` 付き）。
**しかしこれを使っているのは replay の適合テスト（上の #3、重みを落とさない）だけで、
本物の onnxruntime を通す唯一のテスト（`live.local-embedding.test.ts`）は、
次元数と類似度の大小しか見ておらず、値そのものを照合していない**【現物】。

⟹ **「同じ入力 → 同じ成分」の突合を足せば、repo / 量子化 / 変換の違いをほぼ確実に検出できる。
材料の追加は要らない。**

**⛔ ただし、いまは足していない。**Issue #142 自身がこう書いている（逐語）:

> ⛔ **どれを採るかは、まず「この穴が実際に踏まれうるか」を測ってから決めるべきである**
> （`repo` を差し替える運用が実在するのか）。⛔ 測る前に歯を足さないこと。

**⟹ この文書は穴を記録するところまでで止める**（Issue #142 の案(う)）。

---

## 6. ⭐ 後から決められるように — `local` の live 14本は、CI で走らせる形が可能である

**判断材料をここに置く。⛔ いまは採っていない。**

**走らせられる根拠**【現物】:

- `packages/local-embedding` の live 14本と cache-warm 1本は、**鍵を必要としない。**
  `MNEMORA_LIVE_LOCAL_EMBEDDING` を立てるだけで走る。**課金は発生しない。**
- 要るのは**モデル一式4ファイル計42MB（うち重み本体36MB）のダウンロード**だけである。
- **CI は既に、その重みを落としている**——`identifier-probes` / `consolidation-cost` /
  `archive-sweep-cost` の3ジョブが `MNEMORA_EMBEDDING=local` を固定で使う
  （[AGENTS.md](../AGENTS.md) の4層の表）。

⟹ **28本のうち15本は、「鍵が無いから走らない」のではない。**

**いま採らなかった理由**:

- **CI のジョブが1本増える**（13 → 14）。1周は壁時計 **4〜9分**である
  （[ADR 0183](./decisions/0183-local-postgres-makes-postgres-mutation-testing-possible.md) の実測）。
- [Issue #267](https://github.com/takecchi/mnemora/issues/267) が、**CI の1周の費用を
  既に問題として挙げている**（ADR を持つ PR は索引再生成でもう1周する）。
- **多数の担い手が並行して CI の緑を待っている。**増分は全員に掛かる。

⟹ **費用の理由で退けたのであって、成立しないから退けたのではない。**
**この費用の釣り合いが変わったら、ここへ戻ること。**

---

## 7. 実 API に当てる手順（鍵を持つ人向け）

**⛔ CI で実 API を叩く形は採らない。**鍵の管理と課金の判断が要るためである。

### ⚠ 先に読むこと

**鍵が在る環境でルートの `pnpm run test` を走らせると、黙って課金される。**
[ADR 0019](./decisions/0019-real-openai-measurement-cost.md) §5c が、**その事故が
実際に踏まれた**ことを逐語で記録している:

> `OPENAI_API_KEY` を持つ環境で `pnpm run test` を走らせると、黙って課金される（中略）
> 本作業中に実際にこれを踏んだ（門を繰り返し走らせる過程で、意図せず本物の API を複数回叩いた）。

⟹ **パッケージを絞って走らせること。**

### 打つコマンド

```bash
# OpenAI（live 11本。1回あたり embeddings.create が5回増える。ADR 0019 §5c）
OPENAI_API_KEY=sk-... MNEMORA_LIVE_OPENAI=1 pnpm --filter @mnemora/openai test

# Anthropic（live 2本）
ANTHROPIC_API_KEY=sk-... MNEMORA_LIVE_ANTHROPIC=1 pnpm --filter @mnemora/anthropic test

# local-embedding（live 14本＋1本。鍵は要らない。4ファイル計42MB（うち重み36MB）を落とす）
MNEMORA_LIVE_LOCAL_EMBEDDING=1 pnpm --filter @mnemora/local-embedding test
```

### 測ったら、どこに記録するか

**ADR に記録する**（`docs/decisions/`）。少なくとも次の3つを書くこと:

1. **無条件7本が緑だったか。**落ちたら、「実装が間違っている」のか
   「契約が測れないものを要求している」のかを**分けて**判断すること。
   ⛔ **赤を消すために契約を書き換えないこと**（Issue #142 の逐語）。
2. **決定性を実測したか**（同じ入力を2回、要素ごとに厳密一致するか）。
   一致するなら `deterministic: true` へ**測定の記録と一緒に**変えること。
   ⛔ 「たぶん決定的だから」で変えないこと。
3. **測った器・日付・モデルの版。**上の §4 の表を、実測で置き換えること。

---

## 8. 確かめていないこと

- **実 API（OpenAI / Anthropic）には、いまも一度も当てていない。**この文書は手順を
  書いただけで、**測っていない。**
- **`LLMProvider` の適合 suite を新設していない。**§1 の欠落は記録しただけである。
- **`_name_or_path` 以外の経路で repo id を同定できるかを、網羅的に調べていない。**
  実測したのは `config.json` の中身だけである。
- **「`repo` を差し替える運用が実在するか」を測っていない。**⟹ §5 の穴が実際に
  踏まれうるかは、分かっていない。
- **`packages/testkit` 以外の場所に在る歯（各パッケージ固有の unit テスト）は、
  この文書の対象外である。**数えていない。

---

## 出所について

- **§1・§2・§3・§5 の住所と本数**は `main` = `18a8a09` を読んで数えた【現物】。
- **§5 の `config.json` の中身**は 2026-09-17 に実際に取得した【実測】。
- **§4 の表**は [Issue #142](https://github.com/takecchi/mnemora/issues/142) 本文からの引用である。
- **判断（何を採り、何を採らなかったか）**は
  [ADR 0184](./decisions/0184-conformance-scope-documented-not-closed.md) に在る。
