# ADR 0174: `FilteredOmission` に `scopeRelation` を足し、`decayed` の非対称を契約として確定させる

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

- **文脈**:

  [Issue #352](https://github.com/takecchi/mnemora/issues/352) は、`aggregateScope` が返す
  `filtered` 系の件数のうち、**`decayed` だけ `totalInScope` との関係が他の6つ
  （`archived`/`superseded`/`forgotten`/`period`/`expired`/`not_yet_valid`）と逆であること**
  を指摘した。

  | `condition` | `totalInScope` との関係 |
  |---|---|
  | `archived`/`superseded`/`forgotten`/`period`/`expired`/`not_yet_valid` | **外側**（`totalInScope` から引かれる） |
  | `decayed`（[ADR 0173](./0173-decayed-omission-counted-by-aggregate-scope.md)） | 🔴 **内側**（`totalInScope` の部分集合） |

  この非対称自体は ADR 0173 が意図して選んだものであり、記録も残っている
  （ADR 0173「決めたこと」8番・「採らなかった案」4番）。**問題は非対称の存在ではなく、
  型でそれを読み分けられないことである**——`FilteredOmission.condition` の値はどれも
  同じ形 `{ count, countKind }` を持ち、`decayed` だけが `totalInScope` の内側を数えている
  ことをコードから読み取る手段が無かった（ADR 0173「引き受けた負債」4番が自認している
  逐語: 「型としては区別できない（どちらも `{ count, countKind }` である）」）。

  Issue #352 は3つの案を挙げ、どれが正しいかを判断せずに残していた:

  1. `decayed` も `totalInScope` から引く（`expired` に揃える）
  2. `expired`/`not_yet_valid` を `totalInScope` から引かない（`decayed` に揃える）
  3. いまのまま契約として確定させ、型かフィールド名で2群を見分けられるようにする

  **本 ADR はマネージャー決定として案(3)を採る。**理由は下記「決めたこと」および
  「採らなかった案」に書く。

- **なぜ非対称が正しいのか（本 ADR の核心）**:

  `expired`/`not_yet_valid` は「**その事実はいま真ではない**」ことを言う——`period`
  （いつ起きたか）・tenant/subject（誰について）と同じく、**問うている切り口そのものを
  定義する次元**である。だから `totalInScope` から引かれるのが正しい。

  `decayed` は「その記憶は**まだ真**で、**まだ切り口の中に在る**が、遠ざかった」ことを
  言う——**到達しにくさ**のゲートであって、切り口のゲートではない。だから `totalInScope`
  の内側に残るのが正しい。

  **決め手は `docs/north-star.md`「目指す姿」の逐語である**:

  > 使われない記憶が、静かに遠ざかる。——消えるのではなく、遠ざかる。

  案(1)（`decayed` も引く）を採ると、減衰した記憶は `totalInScope` からも目次帯からも
  消える（目次帯 `digestEligible`/`digests` は同じ述語に乗っている）。**呼び手から見て、
  減衰は削除と区別が付かなくなる。**正典が名指しで否定した振る舞いになるので、案(1) は
  北極星で落ちる。

  案(2)（`expired` を引かない側へ揃える）は ADR 0164 の判断を買い直す話であり、
  **支持する記述が `docs/` にも ADR にも1つも無い**（調査で確認済み。下記「確かめていない
  こと」参照——網羅的な grep はしていない）。

  ⟹ **非対称は偶然ではない。** `omitted` の `filtered` 条件は**2群**である:

  - **(甲) スコープを定義するゲートで落ちた ＝ `totalInScope` の外**
    （`archived`/`superseded`/`forgotten`/`period`/`expired`/`not_yet_valid`。`tenant`/
    `taxonomy` は型に在るが本番コードは生成しない）
  - **(乙) スコープ内に居るまま到達しなかった ＝ `totalInScope` の内**
    （`decayed`。`below_threshold`/`over_limit`/`budget_dropped`/`ann_truncated`/
    `not_indexed` と同じ側）

  ADR 0173 自身が「決めたこと」8番で `decayed` を「`below_threshold` の側に属する」と
  書いている。**塞ぐべき穴は「どちらが正しいか」ではなく、この2群が型で見分けられない
  ことである。** 北極星 項目6（「知らないことを、知らないと言える。——『見つからなかった』
  と『探していない』を、同じ顔で返さない」）は、`omitted` を読んで説明を組み立てる
  採用側のための項目であり、分母の内外が読めないとその説明が壊れる。

- **北極星の5つの問いに実際に当てた結果**（`docs/north-star.md`「迷ったときの問い」）:

  | 問い | この判断にどう当たったか | 落ちた案 |
  |---|---|---|
  | **1**（毎回渡す量を減らす方向に働くか） | `FilteredOmission` に `scopeRelation` という1欄（文字列）が増えるだけで、`memories` の量は1バイトも変わらない。呼び出し側は `omitted` を読んで「分母に何が入っているか」を判定できるようになり、`totalInScope` を誤読して過剰に「念のため広く取り直す」判断を防げる。 | — |
  | **2**（無効にしても Memory Framework として成立するか） | `scopeRelation` を無視しても、既存の呼び出し側は今日と全く同じ `omitted`/`index`/`memories` を得る（型は広くなるが値は変わらない）。 | — |
  | **3**（選ばれた理由を後から説明できるか） | **これが本題である。** 「なぜ `totalInScope` がこの数なのか」を、呼び出し側が `scopeRelation` を見るだけで説明できるようになる。 | **案(1)**（`decayed` も引く）。`totalInScope` は動くが、「使われない記憶が静かに遠ざかる」という**別の説明**を潰す取引になっており、問い3の土台（何を数えているかの一貫した説明）が別の場所で壊れる。 |
  | **4**（推論と事実を区別しているか） | 該当しない（件数の分類の話であり、provenance に触れない）。 | — |
  | **5**（LLM を呼ばずに済ませられないか） | 型に欄を1つ足し、`Record<condition, ScopeRelation>` という定数から読むだけ。列と定数で解いている。 | — |

- **決めたこと**:

  1. **案(3) を採る。`omitted` の件数の数え方は1件も変えない。`totalInScope` も動かさない。**
     `packages/postgres/src/memory-store.ts`（`aggregateScope`・`isDecayed` を含む）、
     `packages/postgres/src/vector-store.ts` の `ORDER BY`、
     `packages/core/src/recall-runtime.ts` の段1 ANN 経路（`kPrime` 周辺の窓計算）は
     **1バイトも変えていない。**

  2. **`packages/core/src/recall.ts` に `ScopeRelation` 型を足す。**
     値は `"outside_scope"` | `"within_scope"` の2つ。**真偽値にしない**——このリポジトリは
     `superseded`/`forgotten` を分けたときと同じく、名前のある値を好む
     （[ADR 0027](./0027-split-superseded-forgotten-omission.md)）。

  3. **`FilteredOmission` に `scopeRelation: ScopeRelation` を足す。** 破壊的変更である
     （`@mnemora/core` の公開型に必須フィールドを追加した）。ADR 0156 により、破壊的変更は
     ADR を書けば実装してよい。

  4. **`FILTERED_CONDITION_SCOPE_RELATION`（`Record<FilteredOmission["condition"],
     ScopeRelation>`）を1つだけ置く。** どの `condition` がどちらの群かを決める**唯一の
     場所**であり、`omitted` を組み立てる側（`recall-runtime.ts`）はここから読むだけにする。
     式を2箇所に書くと必ずずれる——[ADR 0038](./0038-vector-hit-distance-is-cosine.md) が
     「実装が2つあると食い違う」ことを実測した穴と同じ形。

  5. **`recall-runtime.ts` の7箇所の `omitted.push({ kind: "filtered", ... })`
     （archived/superseded/forgotten/period/expired/not_yet_valid/decayed）すべてに
     `scopeRelation: FILTERED_CONDITION_SCOPE_RELATION[condition]` を足す。** 段1 ANN の
     窓計算（`kPrime` 周辺）には触れていない——`omitted` を組み立てる末尾の1箇所だけを
     変えた。

  6. **`docs/recall.md` §2 段0「スコープの外延」の列挙に `validAt` を足す。** これは
     新しい判断ではなく、[ADR 0164](./0164-valid-from-until-recall.md) が既に決めて
     実装したことの記録漏れの補完である——コードは `expired`/`not_yet_valid` を
     `totalInScope` から引く実装を ADR 0164 の時点で既に持っていたが、この節の決定文
     （「スコープ = tenant + subject + period + taxonomy + status ゲート」）は
     一度も更新されていなかった。**振る舞いは1バイトも変えていない。**

  7. **同節に `filtered` の2群の表を足す。** (甲) outside_scope / (乙) within_scope の
     区別と、それぞれに属する `condition` を明記した。ADR 0173 が足した既存の追記
     （忘却ゲートは外延に入らない）は残し、それを一般化した形で本節に接続した。

  8. **`packages/core/src/recall.ts` の古い一文を訂正した。** `expired`/`not_yet_valid`
     の doc コメントに残っていた「`"decayed"` は ANN にしか押し下げていないので
     `lower_bound` になるのと対照的」という一文は、ADR 0173（`decayed` の `countKind` を
     `exact` へ上げた）で古くなっていた。今日どちらも `countKind: "exact"` であり対照は
     無い——両者が実際に違うのは `countKind` ではなく `scopeRelation` である、と書き直した。
     これは #352 の射程そのもの（`decayed` と `expired` の関係の記述）であり、「ついでに
     直す」には当たらない。

- **採らなかった案**:

  1. **案(1): `decayed` も `totalInScope` から引く（`expired` に揃える）。**
     落とした理由は上記「なぜ非対称が正しいのか」に書いた——`docs/north-star.md`
     「目指す姿」項目4（「使われない記憶が、静かに遠ざかる。——消えるのではなく、
     遠ざかる。」）に正面から抵触する。⚠ **この案が全面的に間違っているとまでは
     言っていない**——ADR 0173「これが覆るとしたら」3番はこの案を「決め直したとき」の
     条件として残しており、本 ADR もそれを覆していない（下記「これが覆るとしたら」参照）。
     本 ADR が確定させたのは「北極星に照らして、**今日は**採らない」という判断である。

  2. **案(2): `expired`/`not_yet_valid` を `totalInScope` から引かない側へ揃える。**
     落とした理由は2つ。(a) [ADR 0164](./0164-valid-from-until-recall.md) が既に決めて
     実装した判断を買い直すことになり、それを支持する新しい根拠が今回の調査では
     見つからなかった（`docs/` 全文・既存 ADR を読んだ範囲では、`expired`/`not_yet_valid`
     を `totalInScope` の内側に置くべきだと書いている記述は1つも無い）。(b) 買い直すなら
     ⭐門（`examples/chat` の `compare`）の基準値が動く可能性があり、それは本 Issue
     （型で2群を見分けられないこと）とは独立した論点である——1つの PR は1つの ADR
     とその実装（`docs/autonomy.md` §2）に従い、混ぜない。

  3. **`scopeRelation` を真偽値（例: `isWithinTotalInScope: boolean`）にする。**
     落とした理由: このリポジトリは `superseded`/`forgotten` を分けたときと同じく、
     名前のある値を好む（ADR 0027）。`true`/`false` は読み手が「どちらが `true` か」を
     毎回コードへ戻って確認する必要が生まれる——`scopeRelation: "within_scope"` は
     それ自体で意味が読める。

  4. **`FILTERED_CONDITION_SCOPE_RELATION` を作らず、7箇所の `omitted.push` に
     `scopeRelation` の値を直接書く。** 落とした理由: 式を2箇所（実際には7箇所）に
     書くと、`condition` の union に新しい値が増えたときに一部の箇所だけ更新を忘れる
     余地が生まれる——ADR 0038 が実測した「実装が2つあると食い違う」穴と同じ形。
     単一の定数から読むだけにすることで、更新漏れが型エラーとして即座に現れる形にした。

- **引き受けた負債**:

  1. **`scopeRelation` は `condition` から機械的に導出できる値であり、情報としては
     `FILTERED_CONDITION_SCOPE_RELATION` の逆引きと等価である。** それでも
     `FilteredOmission` に欄として持たせたのは、呼び出し側が `condition` ごとの
     マッピングを自前で持たずに済むようにするためである——`@mnemora/core` を消費する
     側（`examples/chat` 等）が独自に `archived → outside_scope` のような表を複製すると、
     mnemora 側でマッピングを変えたときに消費側が追随しないというズレを新しく作る。
     ⚠ **この負債（同じ情報を2箇所に持つ）は解消していない**——`FilteredOmission` の値
     そのものと `FILTERED_CONDITION_SCOPE_RELATION` の対応表は、`recall-runtime.ts` が
     必ず後者から前者を埋めることでのみ一致が保たれる。これは適合テストの歯
     （下記「歯」参照）で検算している。

  2. **`decayed` が `totalInScope` の内側にあるという性質そのものは変えていない**
     ——ADR 0173 が引き受けた負債（`FilteredOmission.condition` の全件を単純合算すると
     `decayed` の分だけ過大になる）は、本 ADR でも解消していない。`scopeRelation` は
     この過大合算を**防ぐ**ための欄ではなく、**気づけるようにする**ための欄である。
     呼び出し側が `omitted.filter(o => o.scopeRelation === "outside_scope")` を経由せず
     `omitted` 全件を合算すれば、今日と同じ間違いを踏める。

  3. **taxonomy 次元がこの話にどう絡むかは、依然として見ていない。** `taxonomy` は
     Phase 1 に実体が無く（`condition: "taxonomy"` は型に在るが生成されない）、
     `FILTERED_CONDITION_SCOPE_RELATION` では `"outside_scope"` としているが、taxonomy
     が実装されたときに本当に (甲) 側でよいかは、Phase 2 で taxonomy を実装する側が
     改めて検討する必要がある（Issue #352「確かめていないこと」がそのまま持ち越しに
     なっている）。

- **これが覆るとしたら**:

  1. **「減衰しきった記憶はスコープ外である」と決め直したとき**（採らなかった案1番、
     ADR 0173「これが覆るとしたら」3番がまだ生きている条件そのもの）。本 ADR は
     この条件を**否定していない**——北極星に照らして「今日は採らない」と判断しただけ
     であり、`docs/north-star.md`「目指す姿」項目4 の書き方そのものが変わるか、
     オーナーが目次帯の設計方針を変えたときは、この判断ごと覆ってよい。そのときは
     `totalInScope`・群カウント・目次帯・⭐門の基準値がすべて動き、`docs/recall.md`
     §2 段0 の書き換えを伴う、別の ADR の仕事である。

  2. **taxonomy（Phase 2）が実装されたとき。** `condition: "taxonomy"` が実際に生成
     されるようになったら、`FILTERED_CONDITION_SCOPE_RELATION.taxonomy` が
     `"outside_scope"` のままでよいかを、taxonomy 実装 PR 側で検討する必要がある。

  3. **`expired`/`not_yet_valid` を `within_scope` 側へ揃える具体的な根拠が見つかったとき**
     （採らなかった案2番）。今日はそのような根拠は無い。

- **確かめていないこと**:

  - **案(2)（`expired`/`not_yet_valid` を `totalInScope` の内側へ揃える）を支持する記述が
    無いことは、`docs/` と `docs/decisions/` を読んだ範囲での確認であり、機械的な全文
    grep はしていない。** 見落としがあり得る。
  - **⭐門（`examples/chat` の `compare`）への影響は測っていない。** 本 ADR は
    `totalInScope`/`aggregateScope` の数え方を一切変えていないため、影響は無いと
    見立てているが、実測はしていない——Issue #352「確かめていないこと」がそのまま
    持ち越しになっている。
  - **`examples/chat` 側で `FilteredOmission` を消費しているコード**
    （`examples/chat/src/validity-arm.ts` 等）が `scopeRelation` の追加で型エラーに
    ならないことは `pnpm -r typecheck` で確認したが、`scopeRelation` を実際に使って
    説明を組み立てる改善は、この PR の射程に含めていない（別 PR の仕事）。
  - **ルートの `pnpm run test`（DB 段を含む全体実行）は走らせていない。** オーナー方針
    により、CI に委ねる。手元で走らせたのは対象ファイルを名指しした `vitest run` と、
    `pnpm -r typecheck` / `pnpm run lint` / `pnpm run format:check` のみ。

- **測ったこと**:

  - `pnpm -r typecheck` — 全パッケージ緑。
  - `pnpm --filter @mnemora/core exec vitest run <対象ファイル群>`（下記「歯」参照）—
    全緑（459 + 12 件）。
  - `pnpm --filter @mnemora/testkit exec vitest run
    src/__tests__/in-memory-fixtures.conformance.test.ts` — 全緑（284件）。
  - `DATABASE_URL=postgresql://postgres@127.0.0.1:5433/mnemora pnpm --filter @mnemora/postgres
    exec vitest run src/__tests__/conformance.postgres.test.ts` — 全緑（284件、本物の
    PostgreSQL 17 + pgvector に対して）。
  - **変異試験1（札を取り違える）**: `FILTERED_CONDITION_SCOPE_RELATION.decayed` を
    `"outside_scope"` に変えて上記2ファイル（core の歯・testkit の歯）を再実行 ——
    core 側2件・testkit 側1件が赤くなった。退避コピーから戻して緑に復帰したことを
    再実行で確認した。
  - **変異試験2（数え方を変える）**: `packages/testkit/src/__fixtures__/
    in-memory-memory-store.ts` の `aggregateScope` で `decayed` を `totalInScope` から
    引くように変えて（`continue` を追加）、testkit の歯を再実行 —— 6件が赤くなった
    （既存の ADR 0173 の歯5件 + 本 ADR が足した被覆算術の歯1件）。退避コピーから戻し、
    `git diff` で無変更（原状回復）を確認したうえで再実行し、284件全緑に戻ったことを
    確認した。

- **歯**（`docs/autonomy.md` §2「歯が実際に噛むことを変異試験で示した」）:

  - `packages/core/src/__tests__/filtered-condition-scope-relation.test.ts`（新規）
    - `FILTERED_CONDITION_SCOPE_RELATION` が `FilteredOmission["condition"]` の全値を
      型・実行時の両方で網羅すること。
    - `decayed` だけが `"within_scope"` であること（非対称そのものの固定）。
    - `recall()` を実際に駆動し、7条件（archived/superseded/forgotten/period/expired/
      not_yet_valid/decayed）すべてで `omitted.filtered` の `scopeRelation` が
      `FILTERED_CONDITION_SCOPE_RELATION` と一致すること。
  - `packages/testkit/src/memory-store-conformance.ts`（追加。adapter 非依存、
    postgres/in-memory の両方に届く）
    - ⭐ 被覆の算術: `scopeRelation: "within_scope"` の filtered 件数
      （`filteredDecayed`）が `totalInScope` の部分集合であること
      （`count <= totalInScope`、引くと実際に返りうる件数になる）。
    - ⭐ テナント内の全件数 = `totalInScope` + Σ(`scopeRelation: "outside_scope"` の
      filtered 件数)。既知の内訳を持つ fixture（生存5・decayed 4・expired 3・
      archived 2・superseded/forgotten/period/not_yet_valid 各1、計18件）で実数を
      検査する。
  - 既存の `recall.test.ts` / `recall-pipeline.test.ts` / `recall-decay-gate.test.ts` /
    `recall-validity.test.ts` / `recall-association-gates.test.ts` /
    `observe-occurred-at.test.ts` / `forget.test.ts` / `purge.test.ts` /
    `restore-archived.test.ts` / `consolidate.test.ts` / `recall.postgres.test.ts` の
    `toContainEqual`/`safeParse` 系の期待値に `scopeRelation` を機械的に足した
    （新しい主張は加えていない——既存の歯が破壊的な型変更に追随しただけ）。

- **出所について**:

  - **案(3) を採るという判断・「なぜ非対称が正しいのか」の論拠（`decayed` は到達しにくさ
    のゲートであって切り口のゲートではない、北極星「目指す姿」項目4 が決め手である、
    2群構造の整理）は、マネージャーの決定である**（本作業の担い手が決めたものではない）。
  - **[Issue #352](https://github.com/takecchi/mnemora/issues/352) の指摘・3案の整理・
    ADR 0173 との関係の記述は、Issue 本文（オーナー起票、担い手が調査して書いた）から
    引いた。**
  - **`docs/recall.md` §2 段0 に `validAt` が欠けているという指摘は、マネージャーの調査
    結果として受け取った**（本作業の担い手は、[ADR 0164](./0164-valid-from-until-recall.md)
    の実装済み挙動と現行の `docs/recall.md` の記述を突き合わせて実際に確認した）。
  - **変異試験の実測（何件赤くなり、戻して何件緑に戻ったか）は、本作業の担い手が
    この環境で実際に走らせて得た値である。**
