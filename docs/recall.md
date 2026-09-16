# recall — 想起パイプラインと説明可能性

`recall(ctx, query) -> RecallResult` は mnemora の中で最も説明責任が重い操作である。ここが返すものが、上位のアプリケーションが LLM に渡す文脈そのものになる。

`docs/vision.md` で述べた一本の原則「文脈を剥がして提示しない」には三つの現れがあるとした。

1. 争われている主張は、それを争う相手と必ず同時に提示する
2. 推論は、その根拠と必ず同時に提示する
3. 結果は、そこから漏れたものと必ず同時に提示する

この文書はほぼ全体が3番目の現れの実装である。`recall()` は「何を返したか」と同じ重さで「何を返さなかったか、なぜか」を返す。それが本文書の主題であり、`RecallResult` の型そのものに刻まれている。

---

## 1. Recall が返すもの

まず全体像を型で示す。

```ts
type RecallResult = {
  | { kind: 'not_indexed'
      reason: 'pending' | 'failed' | 'skipped'
      count: number; countKind: CountKind }recallId: string              // 記録された recall の識別子。observe() の usage 報告で使う
  memories: RecalledMemory[]    // 返ったもの。score 内訳 + 取得理由つき
  omitted: Omission[]           // 返らなかったものの分類（§4）
  index: IndexBand              // 目次帯。被覆不変条件を担う（§5）
  usage: RecallUsage            // 焼かれた量の計測（§6）
  explain: { stages: StageTrace[] } // どの段が走り、どの段が走らなかったか（§2）
}
```

`memories` と `omitted` は対になる二つのフィールドであって、片方が主でもう片方が付録ではない。型定義上も並び順上も対等に置く。呼び出し側のコードが `omitted` を無視して `memories` だけを使うことは自由だが、mnemora の側が「無視してよい」という前提で設計してはならない——`omitted` を計算しない・空配列で済ませる、という手を抜く経路を作らない。

`index` と `usage` も同じ理由でトップレベルに置く。「何が在るか」（index、§5）と「どれだけの量を返したか」（usage、§6）は、`memories` の中身をどう解釈するかに直接影響する周辺情報であり、後から復元できない。`explain.stages` はパイプラインの実行そのものの記録であり、次節で扱う。

以降の節はこの型の各フィールドを埋めていく作業である。

---

## 2. パイプラインの段

recall は次の7段からなる。各段は「入力」「出力」「落ちるものの理由」「索引が効くか」を持つ。
**加えて、呼び手が明示したときだけ走る任意の段3.5（連想）が在る**（§9。[ADR 0151](./decisions/0151-recall-association-unprompted.md)）——**番号を 3.5 にしてあるのは、既存の段4〜6 の番号を動かさないためである。**番号を繰り下げると、この段と無関係な節への参照が repo 中で一斉に古くなる（`../architecture.md` §5.2.1 が同じ理由で同じことをしている）。

| 段 | 名称 | 索引 | 概要 |
|---|---|---|---|
| 0 | スコープ確定 | — | tenant / subject / 時間窓 / taxonomy を確定する |
| 1 | 候補生成 | **効く** | ベクトル ANN / タグ一致 / 直近。over-fetch する |
| 2 | 再スコア | 不要（O(k')） | 減衰 × 類似度 × タグ × 鮮度 × 強度 |
| 3 | 矛盾の解決 | — | `contested` の同伴を必須取得する |
| 3.5 | **連想**（任意。既定 off） | **効く** | クエリで引けた記憶を起点に二段目を引き、**クエリに当たらなかった候補**を別の札で足す（§9） |
| 4 | 予算による切り詰め | — | 文字数 / トークン予算で k をさらに絞る |
| 5 | 目次帯の構築 | 集約クエリ | 群カウントを取る |
| 6 | 記録 | — | `recalls` へ書き込み、`recallId` を発行する |

パイプラインの契約として次を明示する。**各段は「なぜ落としたか」を Omission の形にして次の段へ渡す。落とした理由をパイプラインの外で後から復元しようとしない。** 段2で閾値未満として落ちた記憶の識別子とスコアは、段2の中で `Omission { kind: 'below_threshold', ... }` として確定させ、それ以降の段はこれを積み上げるだけにする。パイプラインの最後に「結局何が何件落ちたか」を集計し直す構造にはしない——集計し直す設計は、集計ロジックが実装と乖離した瞬間に `omitted` が嘘をつき始める。

### 段0: スコープ確定

入力: `ctx`（`tenantId`, `subjectId?`）と `query`（自然文またはベクトル、taxonomy フィルタ、時間窓）。
出力: 段1に渡す確定済みの `WHERE` 条件一式。
このスコープの外にある Memory は recall の対象になりようがないので、`omitted` にも `index` にも現れない。これは「無い」の分類の対象外であることに注意する——スコープ外は「無い」ではなく「そもそも問うていない」であり、`index` が示す「スコープ内に何が在るか」の母集団を確定する段である。

#### スコープの外延（2026-09 追記。マネージャー決定。欠けていた定義の補完であり、既存記述の訂正ではない）

上の段落は「スコープ」を tenant / subject / 時間窓 / taxonomy と書いているが、これだけでは外延が確定しない。§4 の `FilteredOmission.condition` には `'status'` / `'archived'` が別途存在し、§5 の被覆不変条件（「スコープ内の全 Memory は、返るか群カウントに乗るかのどちらか」）を検査しようにも、「スコープ」に `status` が入るのか入らないのかが決まらなければ、この不変条件は機械的に検査できない。ここでその外延を確定する。

**決定: スコープ = tenant + subject + 時間窓(period) + 有効性(validAt) + taxonomy + status ゲート。** status ゲートは段1の候補生成と同じ `status IN ('active', 'contested')` である。

> **⚠ 2026-09 追記（Issue #352 / [ADR 0174](./decisions/0174-filtered-omission-scope-relation.md)）: 「有効性(validAt)」を列挙に足した。これは新しい判断ではなく、記録漏れの補完である。**
> [Issue #280 / ADR 0164](./decisions/0164-valid-from-until-recall.md) は `RecallQuery.validAt` ゲート（`validFrom`/`validUntil`、既定 `now`）を追加し、`expired`/`not_yet_valid` で落ちた件数を `totalInScope` から引く実装を既に入れていた——**コードは最初からこの通りに動いていた。**
> しかし当時、この節の決定文（上の1行）は更新されず、`validAt` は一度も列挙に現れなかった。**振る舞いは1バイトも変えていない**——ADR 0164 が既に決めて実装したことを、この節の文章がここまで書き漏らしていただけである。

- **tenant と subject はスコープの外側の境界である。** 呼び出し側が明示した境界の外は「失われた」のではなく「そもそも問うていない」——ちょうどこの段落が「スコープ外は『無い』ではなく『そもそも問うていない』」と述べているのと同じ扱いであり、`Omission`（§4）としては報告しない（`FilteredOmission.condition` に `'tenant'`/`'subject'` の値が無いことと対応する。`'tenant'` という値自体は型として残っているが、Phase 1 の recall はテナント境界の外を問うことが構造的に無いため、実際には発生しない）。
- **period・status（archived / superseded / forgotten）・validAt（expired / not_yet_valid）が実際に `filtered` として報告される次元である。** status ゲートで落ちる Memory はさらに三分する——`status = 'archived'`（`condition: 'archived'`）、`status = 'superseded'`（`condition: 'superseded'`）、`status = 'forgotten'`（`condition: 'forgotten'`）。分ける理由: `archived` は「使われなくなって静かに遠ざかった」ものであり、強化すれば戻ってくる可能性がある（次の一手が違う）。`superseded` はより新しい Memory が既に別の形で返るはずのもの（**機構の都合**であり、`superseded_by_id` で置き換え先を辿れる）、`forgotten` は利用者が明示的に忘れさせたもの（**製品の振る舞い**であり、置き換え先を持たない）で、互いに次の一手が異なる（[ADR 0027](./decisions/0027-split-superseded-forgotten-omission.md)）。以前はこの2つを単純に `'status'` という1つの condition へ丸めていたが、それでは「利用者が忘れてほしいと言ったのか、こちらが作り直しただけなのか」を呼び出し側が判定できなくなる。validAt ゲートも同様に二分する——`expired`（`validUntil` が `validAt` 以前。その事実はもう真ではない）と `not_yet_valid`（`validFrom` が `validAt` より後。その事実はまだ真になっていない）——束ねると「まだ来ていない」のか「もう過ぎた」のかを呼び出し側が判定できなくなる（ADR 0164、`FilteredOmission.condition` の doc）。
- **taxonomy は Phase 1 に実体が無い**（labels/memory_labels は Phase 2、[./memory-model.md](./memory-model.md) §8）。したがって Phase 1 のスコープの taxonomy 次元は常に無条件であり、`Omission { kind: 'filtered', condition: 'taxonomy' }` は Phase 1 では発生しない（型としては残す）。

**件数はすべて単一の集約から取る。** `IndexBand.totalInScope` と `groups`、および `filtered` 系 Omission の件数・`not_indexed` の件数は、すべて同じ1回の集約クエリ（`MemoryStore.aggregateScope`）から得る。ADR 0011 が段1の `count(*) OVER ()` を締め出したのと同じ理由——**別々のクエリから出すと、その間の書き込みで総和が一致しなくなる**——がここでも成り立つ。

**`totalInScope` が何を数えているかを一言で言うと**: 「tenant + subject + period + validAt + taxonomy + status ゲートを**すべて通過した** Memory の件数」である。通過したかどうかは、この段落より上で確定した外延だけで決まる——**到達しにくさ（減衰・閾値・件数超過・予算・索引未整備）は `totalInScope` に影響しない**（下記「2群」参照）。

**帰結**: スコープ内で落ちたもの(`not_indexed` / `below_threshold` / `over_limit` / `budget_dropped` / `ann_truncated`)はすべて群カウントに乗っている。スコープを定義するフィルタ(period / taxonomy / status / validAt)で落ちたものは群カウントには乗らない。これが被覆不変条件の実質的な中身である——「在るなら出せるはず」と読める形で `forgotten`/`superseded` まで群カウントに数えることはしない。

#### `filtered` の2群（Issue #352 / [ADR 0174](./decisions/0174-filtered-omission-scope-relation.md)）

**⚠ 2026-09-16 追記（[ADR 0173](./decisions/0173-decayed-omission-counted-by-aggregate-scope.md)）: 忘却ゲート（`decay_floor_at`/`decay_floor_seq`）はこの外延に入らない。**
上の決定（スコープ = tenant + subject + period + validAt + taxonomy + status ゲート）に忘却ゲートは
**書かれていない**。ADR 0153 がゲートを既定 ON にしたときも、この外延は動かさなかった。
⟹ **減衰しきった Memory はスコープ内に在る**——`IndexBand.totalInScope` にも群カウントにも
目次帯にも現れ続け、`omitted` の `filtered(condition: 'decayed')` は
**その内訳（部分集合）**を名乗る。`archived`/`period`/`expired` が「除かれた件数」なのとは
関係が違う。
**⟹ 被覆不変条件（群カウントの総和 = `totalInScope`）は、この札を足しても崩れない。**

⚠ **これを「スコープに入れる」（＝ `totalInScope` から引く）判断は、あり得るが別の判断である**
——それは「減衰しきった記憶は目次帯にも出さない」という製品の振る舞いの変更であり、
⭐門（`examples/chat` の `compare`）の基準値も動く。ADR 0173「採らなかった案」4番。

**上の `decayed` の扱いは、`archived`/`period`/`expired`/`not_yet_valid` の扱いと構造が同じに見えて逆である**（[Issue #352](https://github.com/takecchi/mnemora/issues/352) が指摘した非対称）。ADR 0174 はこれを偶然ではなく**2つの群がある**と整理し、`FilteredOmission.condition` に `scopeRelation`（`"outside_scope"` | `"within_scope"`）という欄を足して型で見分けられるようにした。

| 群 | `scopeRelation` | 何が起きたか | `totalInScope` との関係 | 該当する `condition` |
|---|---|---|---|---|
| (甲) | `"outside_scope"` | **問うている切り口そのものを定義するゲート**で落ちた——period（いつ）・tenant/subject（誰について）と同じ次元 | **除かれる**（`totalInScope` に入らない） | `archived` / `superseded` / `forgotten` / `period` / `expired` / `not_yet_valid`（`tenant`/`taxonomy` は型に在るが生成されない） |
| (乙) | `"within_scope"` | **スコープの中に居るまま、到達しにくさのゲート**で落ちた——`below_threshold`/`over_limit`/`budget_dropped`/`ann_truncated`/`not_indexed` と同じ側 | **除かれない**（`totalInScope` の内訳・部分集合） | `decayed` |

**決め手は `docs/north-star.md`「目指す姿」の逐語である**:

> 使われない記憶が、静かに遠ざかる。——消えるのではなく、遠ざかる。

`decayed` を (甲) 側に置く（＝ `totalInScope` から引く）と、減衰した記憶は `totalInScope` からも目次帯からも消える——目次帯（`digestEligible`/`digests`）は `totalInScope` と同じ述語に乗っているためである。**呼び手から見て、減衰は削除と区別が付かなくなる。**正典が名指しで否定した振る舞いになるため、ADR 0174 は `decayed` を (乙) 側に固定した。**塞いだ穴は「どちらが正しいか」ではなく、この2群が型で見分けられないことである**——`condition` を持つ値はどちらも同じ形 `{ count, countKind }` であり、`scopeRelation` を足すまでは呼び手が読み分けられなかった（ADR 0173「引き受けた負債」4番）。

`FILTERED_CONDITION_SCOPE_RELATION`（`packages/core/src/recall.ts`）が、どの `condition` がどちらの群かを決める唯一の場所である。`omitted` を組み立てる側（`recall-runtime.ts`）はここから読むだけで、式を2箇所に書かない（ADR 0038 が実測した「実装が2つあると食い違う」穴と同じ理由）。

### 段1: 候補生成（索引が効く）

入力: 段0のスコープ、埋め込みベクトル（あれば）、タグ集合。
出力: 上位 k' 件の候補（k' = 最終的に欲しい件数 k × over-fetch 係数）。
索引が効く段。ANN・タグ一致・直近取得を並行して行い、候補プールに合流させる。ここで over-fetch する理由と設計は §3 で詳述する。

埋め込み provider が使えない、あるいはクエリに埋め込む内容が無い場合、ベクトル候補生成という**経路そのものが走らない**。これは 0 件ではなく `Omission { kind: 'stage_skipped', stage: 'candidate_generation', reason: 'embedding_provider_unavailable' }` として記録する。タグ一致や直近取得が別途走っていれば `memories` が空にならないこともある——「ベクトル検索だけが止まった」という情報は、それ単体で呼び出し側の次の一手（フォールバックするか、埋め込み待ちの再試行をするか）を変える。

**Phase 1 の範囲(2026-09 追記、本 PR の決定)**: 上記は3チャンネル(ANN・タグ一致・直近取得)が並行して走る一般形を述べているが、roadmap.md 段階4の完了条件は「二段検索(段1: 索引が効く形のフィルタ + ANN、段2: over-fetch した候補への再スコア)」とのみ明記しており、タグ一致・直近取得を独立した候補生成チャンネルとして要求していない。**Phase 1 は ANN の1チャンネルのみを実装する。** タグは段2の再スコア(§7)における加点要素としてのみ参加し、それ自体で候補を拾い上げる経路にはしない。

**⚠ この「1チャンネルのみ」は、2026-09-10 に改められた([ADR 0084](./decisions/0084-lexical-recall-channel.md)、Issue #106)。** 候補生成は `RecallQuery.channels` が指すチャンネルを並行して走らせる形になり、**語彙(lexical)チャンネル**が足された——PostgreSQL 組み込みの `to_tsvector('simple', …)` に ASCII 境界の正規化を掛けた式索引で、固有名詞・識別子を**文字列として**引く経路である(追加の PostgreSQL 拡張は要求しない)。**⚠ ただし既定は今も ANN 1本であり(`DEFAULT_RECALL_CHANNELS`)、`channels` を渡さない呼び出しの挙動は1バイトも変わっていない。**⛔ そして**「タグ一致」「直近取得」は、今も実装が無い**——ADR 0084 が足したのは語彙1本だけである。**⚠ 語彙チャンネルは日本語の文に埋もれた日本語の語(人名を含む)を引けない**(ADR 0084 §2 に実測がある)。**この限界を理由に `REQUIRED_EXTENSIONS`(`pg_trgm` 等)を増やすかどうかは [ADR 0149](./decisions/0149-japanese-lexical-no-required-extension.md) が検討し、増やさないと決めている**——買えるのは日本語の固有名詞1点であり、`C` ロケールのクラスタでは黙って0件を返す(ADR 0084 §3.2)という代償のほうが重いためである。**⚠ 日本語表記のチャンネル名・社内システム名についても、人名と同じ穴に落ちる可能性が高いが、確かめていない**(ADR 0149)。**⚠ 2026-09 追記([ADR 0092](./decisions/0092-lexical-or-coverage.md))**: クエリ語彙は OR で結ばれ、`score.lexicalMatch` は「一致した語彙数 ÷ クエリ語彙数」(被覆率)になった——以前はクエリの ASCII の語どうしを AND で結んでおり、`what did we say about PROJ-1234` のような英語の自然文は全語を含む記憶しか返らなかった(ADR 0084 §2.1.1・§8 の負債)。この変更は「引ける」を広げるだけで、低選択率のクエリ(ありふれた語1つ)で語彙候補どうしの順序が事実上任意である、という ADR 0084 §8 の負債そのものは塞いでいない。走らせられるチャンネルの一覧を**ここに書き写さないこと**——唯一の出所は `packages/core/src/recall.ts` の `RECALL_CHANNELS` である。したがって、embeddable なクエリが無い場合(`text`/`vector` のいずれも無い場合)、Phase 1 の `memories` は実際に空になる——「タグ一致や直近取得が別途走っていれば空にならないこともある」という上記の記述は Phase 2 以降でチャンネルを追加した場合に成立する記述であり、Phase 1 の実装はこの緩和を持たない。この限定は、embeddable な内容が無いクエリでは `omitted` に `stage_skipped` が付き、`memories` が空でも `index`(§5)が「スコープ内に何が在るか」を独立に示し続けることで、原則3の要求(「無い」を分類して見せる)は満たされたままである。

### 段2: 再スコア（索引が要らない。O(k')）

入力: 段1の候補 k' 件。
出力: 減衰・類似度・タグ一致・鮮度・強度を掛け合わせてスコアリングし直した上位 k 件（と、それ未満の残り）。
テーブル全体ではなく k' 件だけを触るので索引を必要としない。ここで閾値未満に落ちたものは `below_threshold`、閾値は超えたが k に入らなかったものは `over_limit` として記録する（§4）。

**⚠ 段2の閾値比較は網羅的な三分割である**（[ADR 0044](./decisions/0044-score-not-comparable-omission.md)）。`total >= threshold`（残す）・`total < threshold`（`below_threshold`）・**どちらでもない**（`score_not_comparable`）の3つで、`scored = passed + below_threshold + score_not_comparable` が常に成り立つ。「どちらでもない」が在りうるのは、`total` が `NaN` のとき **`>=` と `<` の両方が false になる**からである——以前この2つを独立した `filter` で書いていたため、その候補は返らないのに `omitted` にも現れず、**`omitted` が空配列になって「取りこぼしは無い」と誤答していた。**

### 段3: 矛盾の解決と必須の同伴取得

入力: 段2で残った候補。
出力: `contested` 状態の Memory について、対向する Memory（`contradicts` の相手）をスコアに関係なく候補に追加した集合。
既定の recall は `status = 'active'` のみを返し `superseded` を返さない。`contested` は単独で返してはならない——相手を必ず一緒に取得する（mandatory companion retrieval）。詳細な状態遷移とデータモデルは `./memory-model.md` の矛盾の扱いの節に譲る。ここでは recall パイプライン上の位置づけだけを扱う（予算と衝突したときの優先順位は §8 で述べる）。

### 段3.5: 連想（任意。既定 off。§9 / [ADR 0151](./decisions/0151-recall-association-unprompted.md)）

入力: 段3までの集合、`query.association?`。
出力: 段3までの集合に、**クエリに直接は当たらなかった候補**を `retrievedVia: 'association'` として足した集合。
`query.association` が**無ければこの段は何もしない**——`omitted` にも1件も積まない。**問われていないことは「無い」ではない。**
詳細（アンカーの取り方・除外規則・`ScoreBreakdown` の扱い・「無い」の名乗り方）は §9 に置く。

**この段が段1（候補生成）ではなく、段3 の隣に在る理由**: 段1 で拾ったものは段2 で
**クエリに対して**再スコアされる。連想の候補は定義上クエリに当たらないのだから、
**段1 に置くと必ず段2 の `below_threshold` で落ちる。**「スコアに関係なく候補へ足す」経路は
既に段3（必須の同伴取得）が持っており、連想はその一般化である（ADR 0151）。

### 段4: 予算による切り詰め

入力: 段3までの集合、`budget?`。
出力: 予算内に収まる部分集合。
文字数・トークン予算を超える分は `budget_dropped` として記録する。順序は「スコアの低いものから落とす」が既定だが、段3で確定した同伴ペアは分割しない（§8）。
**段3.5 の連想の候補は、予算で削るときに最初に落とす**（§9。クエリで引けたものを押し出さない）。落ちた分は同じ `budget_dropped` に乗る。

### 段5: 目次帯の構築

入力: 段0のスコープ全体（段1〜4を通過したかどうかに関係ない）。
出力: `IndexBand`（§5）。
群カウントは段1〜4の絞り込みの影響を受けない——「スコープ内に何が在るか」を独立に数える段である。これが被覆不変条件の完全性を支える。

### 段6: 記録

入力: 最終的な `memories` と `omitted`。
出力: `recalls` テーブルへの1行と `recallId` の発行。
この段が走らないと `recallId` が発行できず、後段の `observe({ kind: 'memory_usage' })` が recall を参照できなくなる。したがって段6は**必須**であり、スキップ可能な段ではない（§4 の5つ目のケースと直結する）。

---

## 3. 二段検索と pgvector

pgvector の HNSW / IVFFlat 索引が効く条件は一つしかない。**`ORDER BY` が距離演算子（`<=>` 等）の結果そのもので、昇順であること。** これは確認済みの事実である。`ORDER BY (embedding <=> $1) * decay_factor` のように式にした瞬間、索引は使われずシーケンシャルスキャンに落ちる。

### ⚠ 二つの別問題を潰さない

recall のクエリ設計を考えるとき、次の二つは似て見えるが**別の問題であり、対処も別**である。この区別を本文書のどこであっても潰さない。

| | フィルタ問題 | スコア問題 |
|---|---|---|
| 何が起きるか | `tenant_id` / `status` / `decay_floor_at > now()` を伴う ANN で、フィルタ後の候補が薄いテナントだと ANN の再帰が浅すぎて候補を取りこぼす | 減衰・タグ・鮮度を「掛けて」並べたい。式にすると索引が死ぬ |
| 対処 | pgvector 0.8.0 で入った iterative index scan（`hnsw.iterative_scan = strict_order \| relaxed_order`）と `hnsw.ef_search` の調整 | over-fetch + 段2の再スコア（本節） |

**iterative scan はスコア問題の解決策ではない。** iterative scan はあくまで「`WHERE` フィルタの下で十分な候補数を確保する」ための機能であり、`ORDER BY` に式を書けるようにする機能ではない。フィルタ問題とスコア問題を同じ機構で解こうとすると、二つとも中途半端になる。mnemora は両方を別々に持つ:フィルタ問題は iterative scan で緩和し、スコア問題は over-fetch + 段2の再スコアという構造そのもので解く。

また、**partial index は離散値・低カーディナリティのフィルタに向く**というのが pgvector 公式の推奨であり、`status = 'active'` のような値には有効だが、`decay_floor_at > now()` のような**連続値の範囲比較**には向かない。この二つを取り違えると「索引を張ったのに効かない」という事故になる。連続値のフィルタで索引を効かせたい場合は、離散化したバケット（例:「直近30日」）を別列に持つ、という迂回はあり得るが、Phase 1 の scope には含めない。

### 段1のクエリ骨格

```sql
SELECT
  m.id,
  m.digest,
  e.embedding <=> $1              AS distance
FROM memory_embeddings_default e
JOIN memories m ON m.id = e.memory_id
WHERE m.tenant_id = $2
  AND m.status IN ('active', 'contested')  -- 誤り1の修正。後述
  -- AND m.decay_floor_at > now()          -- Phase 2 から有効（roadmap.md）。Phase 1 はこの行を含めない
ORDER BY e.embedding <=> $1
LIMIT $3;  -- k' = k × over-fetch 係数
```

`ORDER BY` には距離演算子の結果をそのまま置き、昇順のまま渡す。減衰・タグ一致はここでは掛けない——段2の仕事である。

**⚠ 2026-09 訂正が二つ入っている（PR #2、docs/decisions/0011-no-window-count-in-ann-stage.md に実測記録がある）:**

1. **`status` の条件を `'active'` 単独から `IN ('active', 'contested')` に広げた。** 当初案は `m.status = 'active'` のみだった。しかしこれでは `contested` な Memory が段1の候補集合にそもそも入らず、「争われている主張を、争われていない顔で出さない」（mandatory companion retrieval、`./memory-model.md` §5・本書 §8）が実装として成立しない。対応する索引（`idx_memories_recall_gate`、`./memory-model.md` §10）の述語も同じ形に修正済みである。
2. **`m.decay_floor_at > now()` の行を Phase 1 のクエリから外した。** roadmap.md の Phase 1 範囲の記述（「`decay_floor_at` 列は Phase 1 では書き込むだけ」「Phase 2 で `WHERE decay_floor_at > now()` を使い始めるだけ」）が一次資料であり、本書の当初案がこの行を最初から含めていたのは Phase 分けと矛盾していた。Phase 1 はこの行を持たない。索引の3列目としては最初から `decay_floor_at` を持つため、Phase 2 で読み取りに使い始める際に索引の作り直しは不要。
3. **`count(*) OVER ()` を段1のクエリから外した。** 当初案は「追加のクエリ無しに候補件数を正確に取得でき、`omitted.countKind = 'exact'` を安く出すための実務上の要である」としていたが、これは HNSW 索引の上では成立しないことが実測で分かった（PostgreSQL 18.6 + pgvector 0.8.6、50万行）。索引スキャンを使うプランでは `count(*) OVER ()` の値は真の候補件数ではなく `hnsw.ef_search` に依存する値になり（データと無関係な定数）、正しい件数を出すプランでは索引が捨てられ Seq Scan に落ちる（本書冒頭が禁じる「索引が効かない形」そのもの）。**代わりに §5（目次帯）が既にスコープ全体の群カウント集約を走らせており、その総和が「フィルタ条件下に何件あったか」そのものである。** 追加コスト無しに exact な件数を得られる経路は、段1のクエリではなく段5の集約から得る。詳細は ADR 0011（`docs/decisions/0011-no-window-count-in-ann-stage.md`）を参照。

**⚠ 2026-09 追記（[ADR 0153](./decisions/0153-recall-decay-floor-gate.md)、Issue #196）: 上の2番目の訂正（`m.decay_floor_at > now()` を Phase 1 のクエリから外す）は、その後 ADR 0153 が明示的に上書きした。** `recall()` は既定でこの行を段1のクエリに含める（コメントアウトしていたクエリ骨格の1行が、既定で有効になったと読み替えること）。`RecallQuery.includeFullyDecayed: true` を渡すと、この節が書いていた Phase 1 の挙動（この行を含めない）に戻る。理由・引き受けた負債・語彙チャンネル側の扱いは ADR 0153 を参照。**この節の本文・上の3点の記述自体は書き換えない**（履歴を書き換えない）。

### over-fetch 係数の決め方

既定案は **k' = k × 4**（k=10 なら k'=40 を取得し、段2で10件に絞る）。この数字に強い根拠はなく、次の裁量として書く。

- 係数を大きくするほど、段2が「本来なら上位に来るはずだった記憶」を取りこぼす確率は下がるが、段2の計算量（O(k')）と DB からの転送量が線形に増える。
- 係数を小さくするほど、段1の ANN 索引の再帰が浅くなり、`hnsw.ef_search` を上げない限り取りこぼしが増える。
- テナントのデータ規模が小さいうちは k' が候補総数を超えることがあり、その場合は事実上フルスキャンと同じ精度になる（取りこぼしは発生しない）。

**正直に書くべき限界**: over-fetch は近似である。「段1で k' 位以下に落ちたが、段2の再スコアなら k 位以内に入れたはずの記憶」は、原理的に recall に現れない。これは実装のバグではなく、この構成そのものが持つ性質である。したがって mnemora は取りこぼしを隠さず、`Omission { kind: 'ann_truncated', countKind: 'unknown' }` として結果に出す。`countKind` が `'unknown'` である理由は、ANN が「返さなかった候補」の総数は原理的に数えられないためである(§4)。

---

## 4. 「無い」の分類

### 渡された問題設定

「検索して0件だった」「そもそも検索していない」「候補には出たがスコアで落ちた」「フィルタで落ちた」「候補に出たが LLM が使わなかった」は、呼び出し側から見るとどれも「結果に現れなかった」という一点で同じに見える。しかし mnemora はこれらを型で区別する。区別する基準はただ一つ、**「その区別があると、呼び出し側の次の一手が変わるか」**である。区別のための区別はしない。

例えば「そもそも検索していない」は、呼び出し側に「別の経路（埋め込み待ちの再試行、フォールバック検索）を試す」という一手を与える。「候補には出たがスコアで落ちた」は、「閾値を緩めて聞き直す」という一手を与える。この二つを 0 件という同じ顔で返すと、後者しかできない呼び出し側は前者に対しても無力なままになる。

### ⚠ alteroid から確認できたこと・できなかったこと

この節を正直に書く。**alteroid の現物を読んだ結果、「候補に出たがスコアで落ちた」「候補に出たが LLM が使わなかった」に相当する処理はそもそも alteroid に存在しない。** alteroid の記憶へのアクセスは `memory_list`（一覧）と `memory_read`（slug 指定で開く）のみであり、スコア付き候補・閾値・LLM 選別を伴う検索は無い。埋め込み・ベクトル検索・rerank はリポジトリ全体で1件もヒットしなかった。

alteroid で確認できたのは1箇所だけである——journal（日誌）の部分一致検索(`ILIKE`)が0件を返したとき、「探索対象に入っていない欄がある」ことまで自然文で応答に含めている実装がある。これは「検索して0件」と「そもそも検索していない」の区別に当たり、この節が採用する原則の核そのものである。ただし決定的な違いがある。**alteroid のそれは型に落ちた構造ではなく、自然文1メッセージである。** mnemora がやるのは、その態度を型に持ち上げることである。これは alteroid の延長線上の作業ではなく、mnemora で新しく行うことだと明記しておく。「候補に出たがスコアで落ちた」以下の区別に alteroid からの経験的裏付けは無い——設計判断として独自に採用する。

### `Omission.kind` の一覧

```ts
type CountKind = 'exact' | 'lower_bound' | 'unknown'

type Omission =
  | { kind: 'stage_skipped'
      stage: 'candidate_generation' | 'rescore' | 'index_band'
      reason: 'embedding_provider_unavailable' | 'empty_query_content' }
  | { kind: 'filtered'
      condition: 'tenant' | 'superseded' | 'forgotten' | 'archived' | 'taxonomy' | 'period'
      count: number; countKind: CountKind }
  | { kind: 'below_threshold'
      count: number; countKind: CountKind
      nearMisses?: { memoryId: string; score: number }[] }
  | { kind: 'over_limit'
      count: number; countKind: CountKind }
  | { kind: 'budget_dropped'
      count: number; countKind: CountKind }
  | { kind: 'not_indexed'
      reason: 'pending' | 'failed' | 'skipped'
      count: number; countKind: CountKind }
  | { kind: 'ann_truncated'
      countKind: 'unknown' }
  | { kind: 'ann_unreached'
      countKind: 'unknown' }
  | { kind: 'lexical_truncated'
      countKind: 'unknown' }
  | { kind: 'score_not_comparable'
      count: number; countKind: CountKind }
  | { kind: 'unit_assembly_dropped'
      count: number; countKind: CountKind }
```

**⚠ 2026-09 追記（[ADR 0153](./decisions/0153-recall-decay-floor-gate.md)、Issue #196）**:
`filtered` の `condition` は上のコード例には無い `'decayed'` も持つ（本節の型例は書き換えない
——追記としてここに足す）。`decay_floor_at` を過ぎた（完全に減衰しきった）Memory が
recall の候補から外れたことを表す。`'archived'` には相乗りしない——`archived` は `status`
列によるゲート、`decayed` は `decay_floor_at` 列によるゲートであり、別の列・別の理由・
別の次の一手（`archived` は強化すれば戻る可能性があるが、`decayed` は強化すれば
`decayFloorAt` 自体が先へ延びるため、そもそも次の recall では条件に当たらなくなる）を持つ。
**`count`/`countKind` は他の `filtered` 系と性質が違う**——ANN 段（段1）へ押し下げた分は
ADR 0011 と同じ理由で原理的に数えられず、ここに載る `count` は core の後置フィルタが
実際に落とした件数だけである。⟹ `countKind` は常に `'lower_bound'`。詳細は ADR 0153。

**⚠ 2026-09-16 訂正（[Issue #329](https://github.com/takecchi/mnemora/issues/329) /
[ADR 0173](./decisions/0173-decayed-omission-counted-by-aggregate-scope.md)）: 直前の段落は
もう実態ではない。**`countKind` は **`'exact'`** になり、件数は他の `filtered` と同じく
`MemoryStore.aggregateScope` の `count(*) FILTER`（段1の押し下げと**同じ述語**）から出る。
ADR 0153 が「引き受けた負債」2 として明記していた `'lower_bound'` は、ADR 0173 が返した。
**この訂正が必要だったのは、負債が既定経路で実害を出していたからである**——既定チャンネルは
ANN 1本（`DEFAULT_RECALL_CHANNELS`）であり、押し下げで落ちた記憶は後置フィルタに届かないため、
**`filtered(decayed)` のエントリ自体が一度も出なかった**（記憶が名乗り無く消えていた。
「目指す姿」項目6 と正面から食い違う）。

**⚠ ただし、この `count` が数えているのは「scope 内で減衰しきっていた件数」であって、
「ANN が k' の窓の中で落とした件数」ではない。**この2つは違う数である。
**窓の内側で何件落ちたかは [ADR 0011](./decisions/0011-no-window-count-in-ann-stage.md) の
限界として引き続き不明である。**⟹ ADR 0173 の欠陥ではなく、**契約の範囲外**である
——`archived`/`period`/`expired`/`not_yet_valid` も**すべて前者**を数えており、
§5「スコープの外延」の「件数はすべて単一の集約から取る」という契約がそもそも前者である。

**⚠ `decayed` の件数だけは `IndexBand.totalInScope` から引かれていない。**
忘却ゲートは §2 段0「スコープの外延」が列挙する次元（tenant + subject + period + validAt +
taxonomy + status）に**入っていない**——減衰しきった Memory は**スコープ内に在り**、群カウントにも
目次帯にも現れ続ける。⟹ `filtered(decayed)` は `totalInScope` から除かれた件数ではなく、
**その内訳（部分集合）**である。**被覆不変条件（群カウントの総和 = `totalInScope`）は
これによって崩れない。**この点で `decayed` は `archived`/`period`/`expired` より
`below_threshold`（スコープ内で落ちたもの）の側に近い。

**⚠ 2026-09 追記（Issue #352 / [ADR 0174](./decisions/0174-filtered-omission-scope-relation.md)）:
`FilteredOmission` は本節冒頭の型例には無い `scopeRelation` も持つ（型例は書き換えない
——追記としてここに足す）。**上の段落が述べている非対称（`decayed` だけ `totalInScope` の
内側にある）を、呼び手が型で読み分けられるようにした欄である。値は `"outside_scope"`
（`totalInScope` から引かれる。`archived`/`superseded`/`forgotten`/`period`/`expired`/
`not_yet_valid`）と `"within_scope"`（引かれない。`decayed`）の2つ。どの `condition` が
どちらかを決める唯一の場所は `packages/core/src/recall.ts` の
`FILTERED_CONDITION_SCOPE_RELATION` であり、§2 段0「`filtered` の2群」に表がある。

**⚠ 2026-09-16 追記**: `reason` は以前 `'budget_exhausted'` も持っていたが、
生成するコードが一度も無かった（Issue #206 / [ADR 0117](./decisions/0117-unreachable-union-values-inventory.md)
の分類3）。オーナー判断を受けて
[ADR 0144](./decisions/0144-drop-unreachable-classification-3-union-values.md) で落とした
——`RecallBudget` を使い切ったときの実際の落とし方は `budget_dropped` である。

**⚠ 2026-09-17 追記（[Issue #375](https://github.com/takecchi/mnemora/issues/375) /
[ADR 0188](./decisions/0188-association-over-limit-omission.md)）**: `over_limit` は
上のコード例には無い `stage: 'rescore' | 'association'` も持つ（本節の型例は書き換えない
——`decayed` と同じ扱いで、ここに追記する）。**`'rescore'`** は段2（§7）の
`RecallQuery.limit` を超えた分、**`'association'`** は段3.5（§9）の
`RecallAssociationQuery.maxCount` を超えた分——**どちらも「ゲートと閾値を通過した
集合を、この段自身の上限で切った」という同じ形の事象だが、動かす欄が違う**
（`limit` を増やしても `maxCount` を超えた分は戻らない、逆も同様）。`filtered` の
`condition` が「どのゲートで落ちたか」を言うのと同じ理由で、`over_limit` にも
「どの上限で切ったか」を持たせた。**`count`/`countKind` は段2の `over_limit` と同じ
性質**——連想枠の候補（`associationHits`）は、この slice の時点で既に忘却/`validAt`
ゲートと `minSimilarity`/除外集合を通過し類似度降順に並び終えた、JS 側で確定済みの
集合である。DB への未取得候補ではない（`decayed` が ANN の押し下げで原理的に数え
られない `lower_bound` なのとは対照的）。⟹ `countKind` は常に `'exact'`。

**`ann_truncated` と `ann_unreached` の違い（2026-09 追記、[ADR 0025](./decisions/0025-ann-underfill-is-not-reported-in-omitted.md)・[ADR 0026](./decisions/0026-ann-unreached-omission.md)）**:
`ann_truncated` は「k' に達した＝もっと在るはずだが LIMIT で打ち切った」という**打ち切り**であり、
`ann_unreached` は「k' に届く前に、近似索引がこの scope の候補へ**そもそも辿り着かなかった**」
という**取りこぼし**である。前者は「LIMIT を打った」という確定した事実、後者は
「scope にまだ見られていない候補が残っているのに、返った件数が k' 未満で止まった」という
不確実な事実であり、原因も違えば呼び出し側の次の一手も違う（前者は k' を上げる、
後者は厳密検索へのフォールバックを検討する）。**2つは同時には立たない**
——`ann_truncated` の条件（hits ≥ k'）と `ann_unreached` の条件（hits < k'）は排反である。

| kind | 次の一手がどう変わるか |
|---|---|
| `stage_skipped` | その段の経路自体を疑う（埋め込み provider の復旧、クエリの中身の見直し、予算そのものの見直し）。スコアやフィルタの調整では直らない。 |
| `filtered` | 条件を緩める判断ができる（例: `taxonomy` フィルタを外す、`period` を広げる）。どの条件かが分かって初めて緩め方が決まる。`condition: 'superseded'` なら `superseded_by_id` を辿って置き換え先を探す一手があるが、`condition: 'forgotten'` にはその一手が無い（利用者が意図して忘れさせたものであり、指す先を持たない）。この2つを束ねると一手が選べなくなる（ADR 0027）。 |
| `below_threshold` | 閾値を緩めて聞き直す判断ができる。`nearMisses` があれば「惜しかったものがどれくらい惜しかったか」まで見える。 |
| `over_limit` | 閾値は超えている集合が k より大きいと分かる。**`stage` で一手が分かれる**（2026-09-17 追記、Issue #375 / ADR 0188）——`'rescore'` なら `limit` を増やす・ページングする、`'association'` なら `RecallAssociationQuery.maxCount` を増やす。 |
| `budget_dropped` | スコアの問題ではなく量の問題だと分かる。予算を緩めるか、`memories` を要約させる判断につながる。 |
| `not_indexed` | 記憶は存在するが埋め込みがまだ無いと分かる（`embeddingStatus`、`./memory-model.md` 参照）。記憶が失われたと誤認しない。**`reason` によって次の一手が分かれる**——`pending` は待つ・再試行する、`failed` は埋め込みパイプラインそのものを疑う、`skipped` は意図した除外なので何もしなくてよい。この3つを1つに潰すと、恒久的な失敗と一時的な遅延が同じ顔になる（2026-09 追記。当初案は `reason` を持たなかった）。 |
| `lexical_truncated` | 語彙チャンネルが窓（k'）を埋めたと分かる（[ADR 0084](./decisions/0084-lexical-recall-channel.md) §7.1）。`ann_truncated` とは別の札——語彙チャンネルは損失可能性を判定する機構を持たないため、`countKind` は常に `'unknown'` である。次の一手は「窓を広げる（`overFetchFactor`/`limit`）」であり、閾値やフィルタの調整では直らない。 |
| `ann_truncated` | 「見えていない領域があるかもしれない」という不確実性そのものが一手になる——例えば厳密検索へのフォールバックを選べる。 |
| `ann_unreached` | 近似索引がこの scope に届かなかった可能性がある、と分かる（ADR 0025・0026）。`ann_truncated`（打ち切り）とは別の出来事——こちらは k' に届く前に候補を取りこぼした疑いであり、厳密検索へのフォールバックや subject を絞り直す一手につながる。件数は原理的に分からない（`countKind` は常に `'unknown'`）。 |
| `score_not_comparable` | **スコアが閾値と比較できなかった**と分かる（[ADR 0044](./decisions/0044-score-not-comparable-omission.md)）。閾値を緩めても直らない——`below_threshold` とは別の出来事である。実際に起きるのは埋め込みがゼロベクトルのとき（コサインが未定義になり距離が `NaN` になる。[ADR 0040](./decisions/0040-zero-vector-never-returned.md)）で、次の一手は「その記憶の埋め込みを作り直す」であって「閾値を下げる」ではない。**件数は数え上げられる**（段2が触った候補の三分割なので）——ただし `countKind` は三分割が網羅であることを確かめた結果から決まる。 |
| `unit_assembly_dropped` | **段3で単位を組むときに候補が漏れた**と分かる（[ADR 0043](./decisions/0043-unit-assembly-dropped-omission.md)）。原因は `contested_with_id` の一対一が破れていることであり、次の一手は「その対向関係を直す」——閾値にも予算にも索引にも関係がない。**⚠ 口は在るが、今日は `Runtime` 経由では発火しない**（2026-09-16 訂正）——[Issue #197](https://github.com/takecchi/mnemora/issues/197) / [ADR 0134](./decisions/0134-mark-contested-explicit-operation.md) で `Runtime.markContested` が入り、**`contested` を書く主体そのものは存在するようになった。**ただし `markContested` は両側 `status='active'` の CAS を課したうえで相互参照を1トランザクションで書くため、**`Runtime` 経由で作られた `contested` ペアが一対一を破ることは無い**——⟹ **今日この分岐が通るとすれば、`MemoryStore` を `Runtime` を経由せず直接叩いた場合に限る**（`packages/core/src/recall-runtime.ts` の同じ分岐のコメントが、同じことを書いている）。**さらに、`markContested` を呼ぶ本番コードは今日ひとつも無い**（【実測】2026-09-16、`main` が `5f11291` の時点で `rg "markContested" --glob '!**/__tests__/**' packages examples` が返すのは定義と適合テストだけである）——追跡は [Issue #284](https://github.com/takecchi/mnemora/issues/284)。`countKind` は `'lower_bound'`——二重計上が同時に起きていると消失が隠れるため、下限しか言えない。 |

**`filtered(condition: 'decayed')` の次の一手（2026-09 追記、[ADR 0153](./decisions/0153-recall-decay-floor-gate.md)、Issue #196）**: 忘却ゲートが効いたと分かる。`filtered(condition:'archived')` とは別の一手につながる——`archived` は強化すれば戻る可能性があるが（次の recall で `status` を見直す）、`decayed` は `RecallQuery.includeFullyDecayed: true` を明示的に渡さない限り、強化しても `decayFloorAt` が先へ延びるだけで、次の recall では再びこの条件に当たらなくなる。

**`over_limit(stage: 'association')` の次の一手（2026-09-17 追記、[Issue #375](https://github.com/takecchi/mnemora/issues/375) / [ADR 0188](./decisions/0188-association-over-limit-omission.md)）**: 連想枠（§9）が `RecallAssociationQuery.maxCount` で切り捨てた分だと分かる。`over_limit(stage: 'rescore')` とは別の一手——`limit` を増やしても連想枠の切り捨ては直らない（連想枠は段2の `limit` を一切見ていない）。`maxCount` を増やすと、切り捨てられていた候補が `retrievedVia: 'association'` として本体へ入ってくる。⚠ この札が積まれても `RecallResult.memories` の合計件数は変わらない——連想枠は「元々居なかった候補を追加する」機能であり、切り捨てられた分は最初から `memories` に入っていない。

### 件数にも「無いの種類」を適用する

`Omission.countKind: 'exact' | 'lower_bound' | 'unknown'` は、omitted の「件数」自体に対して原則3を適用したものである。`filtered` の件数は SQL の `WHERE` 条件で正確に数えられるので `'exact'` になり得る。一方、**ANN が候補として返さなかったものの件数は原理的に数えられない**——ANN 索引はテーブル全体を走査しないので「返さなかった件数」という概念自体が索引の外にある。この場合は `'unknown'` を置く。中間として、下限だけは分かる（例えば段1の LIMIT に達したことは分かるが、その先に何件あるかは分からない）場合に `'lower_bound'` を使う。**推定値を実測値の顔で出さない**——これが `countKind` を持つ理由のすべてである。

### 5つ目のケースは recall の外側にある

「候補に出て返したが、LLM がそれを使わなかった」は、recall の実行時点では原理的に判定できない。何を使ったかは呼び出し側の LLM 呼び出しの後にしか確定しない。この情報は `recallId` を持ち帰った呼び出し側が `observe(ctx, { kind: 'memory_usage', recallId, usedMemoryIds })` を呼んで初めて mnemora に届く。

このことから二つの帰結が導かれる。

1. **recall は必ず記録されなければならない。** `recallId` が発行されない recall は、後から「何を使ったか」を紐付ける先を持たない。段6（記録）が省略可能な段ではない理由はここにある。
2. **これは「実際に使われたものだけを強化する」（[./memory-model.md](./memory-model.md) の強化の節）が必要とする機構と同一である。** `recall_usages(recall_id, memory_id)` という同じテーブル・同じ経路が、「LLM が候補の何を選んだか」という説明可能性の要求と、「何を強化するか」という reinforcement の要求の両方を満たす。一つの機構が二つの要求を満たしており、これは偶然の一致ではなく、両者が「実際に使われた」という同じ事実を必要としているからである。

---

## 5. 目次帯 / 被覆不変条件

### 渡された定式

> 目次は、検索を不要にする仕組みではなく、検索が外れたことを可視化する仕組みである。埋め込みを「必ず当たらなければならないもの」から「当たったら得なもの」へ降格する。

この定式を mnemora でも採る。ただし可視化の担い手が alteroid とは異なる。

### ⚠ alteroid の限定

alteroid の「全文か目次1行かのどちらかに必ず現れる」という二階建ての不変条件は、現物のコード(`packages/core/src/memory.ts` の `renderMemoryDocuments` / `buildMemoryDocumentSections`)で確認できた。分岐が2値しかなく、frontmatter が無い・壊れている・未知の値はすべて `premise`（全文・安全側)に倒れる安全弁も確認できた。ここは mnemora が真似すべき点である——**分類に失敗したとき、記憶を「目次だけ」の薄い側に落とさない。曖昧なら厚い側に倒す。**

一方で、重要な限定が三つある。

1. **不変条件が厳密に成立するのはセッション構築時の1回(システムプロンプト全体)についてだけ**である。セッション途中の差分通知(「変わった文書だけ」を渡す経路)では成立しない——これはコードの doc コメント自身が明記している穴である。したがって mnemora は「どの単位で保証されるか」を最初に定義する。**被覆不変条件は `recall()` 1回の返り値について成立する**、と定義し、これを曖昧にしない。セッションという単位を mnemora は持たない(§6 で述べる理由と同根)。
2. **alteroid には埋め込みが存在しない。** したがって「埋め込みを安全に外せるようにする」という alteroid の教訓は、「埋め込みが最初から無い」状態の記述であって、「埋め込みを持つ系に目次を足した」経験ではない。この違いは決定的である。mnemora は埋め込みを持つ系で目次帯を設計する初めてのケースであり、alteroid からの実績としては引用できない。
3. alteroid の目次には**エントリ数の上限(300件)がある。** 規模で壊れる経路が既にコード上に見えている。

### mnemora の決定: 三階建ての被覆不変条件

**recall のスコープ内にある全ての Memory は、返り値の中に (1) 全文 / (2) digest 1行 / (3) それが属する群の件数 のいずれかで必ず現れる。かつ (3) の件数の総和は、スコープ内の総数と一致する。**

**「スコープ」の外延は §2 段0「スコープの外延」で確定した(tenant + subject + 時間窓 + 有効性(validAt) + taxonomy + status ゲート)。この不変条件が指す「スコープ内の総数」はその定義そのものであり、status ゲートで落ちた Memory(`archived`/`superseded`/`forgotten`)・validAt ゲートで落ちた Memory(`expired`/`not_yet_valid`)は「スコープ内」に含まれない——したがって群カウントにも乗らない。乗るのは、スコープには入ったが段1〜4のどこかで(索引未整備・閾値・件数超過・予算・忘却ゲートのいずれかで)落ちたものだけである(`decayed` を含む——§2 段0「`filtered` の2群」参照)。**この区別を曖昧にすると、この不変条件は「在るなら出せるはず」という誤読を生む——忘れられた Memory まで「在る」と数えて見せることは、原則3(結果は、そこから漏れたものと必ず同時に提示する)の逆効果になる。**

二階建てが mnemora で成り立たない理由は単純である。1テナントが100万件の Memory を持ちうる設計で、digest 1行ずつでもプロンプトに載せれば数十万文字になる。alteroid の二階建てが成立していたのは、想定するのが単一所有者・文書数が少ないという前提の上だからである(§1 参照)。mnemora はこの前提を持たない。

そこで第3階(群カウント)を導入する。**第3階が「完全」(総和が一致)であることが、この設計の要である。** これによって「recall が0件でも、何が在るかは知っている」が成立する。0件の recall がどう見えるか、`index` フィールドだけを示す。

```json
{
  "recallId": "rcl_01HXYZ...",
  "memories": [],
  "omitted": [
    { "kind": "filtered", "condition": "period", "count": 3, "countKind": "exact" }
  ],
  "index": {
    "groups": [
      { "axis": "subject", "key": "project/mnemora", "count": 412, "countKind": "exact" },
      { "axis": "subject", "key": "person/alice/preference", "count": 30, "countKind": "exact" },
      { "axis": "subject", "key": "person/bob/preference", "count": 12, "countKind": "exact" }
    ],
    "totalInScope": 454,
    "countKind": "exact"
  }
}
```

該当0件という結果だけを見ると「このテナントには何も無い」ように読めるが、`index` を見れば「このスコープには454件あり、`project/mnemora` に412件、`person/alice/preference` に30件、`person/bob/preference` に12件ある」ことが分かる。0件は「記憶が無い」ではなく「その問い方には引っかからなかった」だと機械的に判別できる。これが「検索を不要にする仕組みではなく、検索が外れたことを可視化する仕組み」の mnemora での実装である。

### 型

```ts
type IndexBand = {
  groups: GroupCount[]
  totalInScope: number
  countKind: CountKind         // groups の総和が totalInScope と一致するかの信頼度
  digestBand?: DigestEntry[]   // Phase 2。Phase 1 では常に undefined
}

type GroupCount = {
  axis: 'subject' | 'taxonomy'
  key: string | null   // D12（2026-09 追記）: subject_id IS NULL の群は null で表す。
                        // '(none)' のような番兵文字列は実在する subject 名と衝突しうるため採らない。
  count: number
  countKind: CountKind
}
```

**⚠ 2026-09-16 追記**: `axis` は以前 `'time_window'` も持っていたが、生成するコードが
一度も無かった（Issue #206 / [ADR 0117](./decisions/0117-unreachable-union-values-inventory.md)
の分類3）。オーナー判断を受けて
[ADR 0144](./decisions/0144-drop-unreachable-classification-3-union-values.md) で落とした。

### 正直に書くべき限界

第3階の完全性は `count(*)` を要求する。大規模テナントで、recall のたびに毎回厳密な `count(*)` を取るのはコストが高い(pgvector の類似検索とは別に、group by の集約クエリが走る)。したがって**群カウントは近似を許すが、近似であることを型で示す**——`GroupCount.countKind` が `'lower_bound'` や `'unknown'` になり得る。近似カウントを許すかどうかは recall のオプションにし、**既定は近似許可**とする(厳密性より低レイテンシを優先する)。厳密カウントを要求する呼び出し側は、明示的にオプションで指定する。

> **⚠ 2026-09 追記: 上の段落は設計の意図であって、Phase 1 の実装ではない。**
> Phase 1 は**常に厳密集計**であり、近似経路もそれを要求するオプションも**存在しない**（下記「Phase 1 の実装上の限界」・[ADR 0024](./decisions/0024-remove-exact-counts-option.md)）。
> **近似が実際に要るかどうかは、下記「`aggregateScope` の実測」で 10k / 100k / 1M の3点を測った。**
> 費用は**テナント全体の集計**に在り（1M で 408ms）、**subject で絞った集計には無い**（全規模で 1ms 未満）。
> **ただし「何 ms なら割に合わないか」の閾値をこの repo は定義していないので、
> 「近似が要る」とはまだ結論していない。**欄を足すかどうかは、その閾値を決めてからである。
> **欄を先に足すと、[ADR 0011](./decisions/0011-no-window-count-in-ann-stage.md) の `count(*) OVER ()` と同じ事故になる**
> ——区別を表す欄が、名乗りどおりの値を持たないまま置かれる。

**Phase 1 の実装上の限界(2026-09 追記、本 PR)**: 上記は近似経路を持つことを前提に書かれているが、`MemoryStore.aggregateScope`(roadmap.md 段階4/5 の実装)は Phase 1 では**常に厳密集計のみ**を実装しており、近似経路(例えば `pg_stats`/`reltuples` に基づく安価な推定)は無い。**近似を要求するオプションも持たない**——以前は `RecallQuery.exactCounts` という欄が型に在ったが、値を受け取って黙って無視していた（呼び出し側は「頼んだ」と思い込める形だった）ため、[ADR 0024](./decisions/0024-remove-exact-counts-option.md) で**削除した**（「予約・未実装」と書き残すのではなく消した。理由は ADR を参照）。これは 100万件級のテナントで `aggregateScope` のコストが無視できなくなる可能性を先送りしたものであり、隠さずここに書く(PR 本文「設計上の疑義」参照)。

### `aggregateScope` の実測（2026-09 追記）

上の「先送りにした」コストを、規模を振って測った（GitHub Actions run 34009301567、
PostgreSQL 17 + pgvector、`packages/postgres/src/bench/scale-bench.ts`、擬似の合成ベクトル・
実 API 不使用）。

| 規模（行数） | subject 数 | 変種 | 所要時間（中央値） | プランの要点 |
|---:|---:|---|---:|---|
| 10,000 | 200 | 全体 | 9.0ms | Seq Scan あり（HashAggregate） |
| 10,000 | 200 | subjectId 指定（小さい subject） | 0.9ms | Seq Scan 無し（GroupAggregate + idx_memories_by_subject） |
| 100,000 | 2,000 | 全体 | 45.8ms | Seq Scan あり（Finalize HashAggregate、並列） |
| 100,000 | 2,000 | subjectId 指定（小さい subject） | 0.7ms | Seq Scan 無し |
| 1,000,000 | 20,000 | 全体 | 408.0ms | Seq Scan あり（Finalize HashAggregate、並列） |
| 1,000,000 | 20,000 | subjectId 指定（小さい subject） | 0.7ms | Seq Scan 無し |

**読み方**: コストは「テナント全体を集計する」呼び出しに在り、「subject で絞って集計する」
呼び出しには無い。全体集計は 10k→9.0ms / 100k→45.8ms / 1M→408.0ms と規模に応じて伸びる
（`Seq Scan` を伴う `HashAggregate`）。一方 subject 指定は全規模でおおむね 0.7〜0.9ms の
横ばいで、`idx_memories_by_subject` を使った索引スキャンに乗っている。

**⚠ この数値だけから「近似が要る／要らない」を結論しないこと。** 「何 ms なら割に合わないか」
の閾値を、この repo はまだ定義していない。ここでは生の数値とスケーリングの傾向だけを示し、
閾値の判断は読む人に委ねる。

**⚠ 測っていないこと**:

- ~~大きい subject を測っていない~~ → **測った**（run 34010394105、全体100,000行固定・次元256固定、
  狙いの subject の行数は `SELECT count(*)` で実測）。`aggregateScope` は subject が大きいほど伸びる:
  **10行で 0.8ms / 1,000行で 1.2ms / 10,000行で 5.2ms**。
  ⟹ **subject で絞れている限り、テナント全体の集計（100,000行で 45.8ms、1,000,000行で 408ms）
  とは桁が違う。** ただし**全体行数は 100,000 に固定しており、振っていない。**
  同じ subject の大きさでも全体行数が変われば結果は変わりうる。
- **同時実行下では測っていない**（単発クエリの中央値のみ）。
- 1,000,000行を超える規模、および `subject` 以外の軸（`taxonomy` / `time_window`）での
  集計は測っていない。

このベンチは同時に `PostgresVectorStore.search` の subject フィルタ（段1の ANN クエリ）も
測っており、そちらの実測と見立ての訂正は
[ADR 0023](./decisions/0023-subject-filter-in-ann-stage.md) の追記節に書いた
（本節が対象とする `aggregateScope` とは別のクエリである）。

**回し方**: `pnpm --filter @mnemora/postgres run bench:scale`。環境変数
`BENCH_SCOPE_SCALES` / `BENCH_VECTOR_SCALES` / `BENCH_VECTOR_DIMENSIONS` で規模・次元数を
調整できる（既定値・詳細は `packages/postgres/src/bench/scale-bench.ts` 冒頭のコメントを参照）。
**このベンチは CI に常時つないでいない**——一時的な計測ジョブで1回回した実測であり、
手で回す口として repo に残っている。

### Phase 1 の範囲

**Phase 1 では第3階(群カウント)のみを実装する。digest 帯(第2階)は Phase 2 に送る。** 理由は、digest 帯が taxonomy(分類語彙)を要するのに対し、群カウントは `subject` 単位だけでも成立するからである。Phase 1 の `IndexBand.groups` の既定 `axis` は `'subject'` とする。`taxonomy` 軸によるグルーピングは、taxonomy の `registered` / `proposed` 状態(`./memory-model.md` の taxonomy strict/open の節を参照)を扱う必要があり、digest 帯と合わせて Phase 2 に含める。**`time_window` 軸は当時型として持っていたが、生成するコードが一度も無く、[ADR 0144](./decisions/0144-drop-unreachable-classification-3-union-values.md)（2026-09-16）で型からも落とした。**

最も価値のある性質——「0件でも何が在るか言える」——は、digest を持たなくても群カウントだけで既に得られる。これが Phase 1 の範囲をこう切った理由である。

**⚠ 2026-09 訂正（digest 帯の実装 PR、[ADR 0073](./decisions/0073-digest-band-bounded-without-taxonomy.md)）: 「digest 帯が taxonomy(分類語彙)を要する」という上の理由は誤りだった。**

**digest 帯は taxonomy を要さない。**`DigestEntry` は `{ memoryId, digest }` だけで `axis` を持たない（`axis` を持つのは `GroupCount` のほうである）。`digest` は Phase 1 の `memories` 列であり `NOT NULL` である。taxonomy を要するのは、**同じ段落の後半が既に書いているとおり `taxonomy` 軸によるグルーピングのほう**であって、帯そのものではない。したがって帯は `labels` / `memory_labels` を待たずに実装できる——schema も migration も変更していない。

**⛔ ただし Phase 1 / Phase 2 の線は動いていない。**オーナーの指示により**「1件1行の要旨を出す機能」1つだけを前倒しで実装した**。`taxonomy` 軸によるグルーピング・`labels` / `memory_labels`・その他の Phase 2 の項目は**前倒しされていない**。**1つの機能が前に出ただけであり、Phase 2 が始まったわけではない。**

**⚠ そして帯には上限が要る。**上の「1テナントが100万件の Memory を持ちうる設計で、digest 1行ずつでもプロンプトに載せれば数十万文字になる」という段落が述べているとおり、**上限のない digest 帯はこの文書が明示的に落とした案である**。実装は**件数・帯全体の文字数・1件あたりの長さの3つ**の上限を持ち、どの上限で切れたかを `IndexBand.digestBandCoverage.limitedBy` で名乗る。**切り詰められたものは第3階の群カウントに乗り続けるため、被覆不変条件は壊れない**——三階建てはそのために在る。理由と採らなかった案は [ADR 0073](./decisions/0073-digest-band-bounded-without-taxonomy.md)。


---

## 6. 焼かれる量の計測と予算

```ts
type RecallUsage = {
  chars: number              // 返した全量（memories tier + 目次帯）
  estimatedTokens: number
  counter: 'heuristic' | 'exact'
  byTier: { full: number; digest: number; index: number }
  indexChars: number         // 目次帯の実費。budget の対象外（下記）
  share?: number             // budget 申告時のみ: memories tier / budget。1 を超えうる（超えたら budgetExceeded が true）
}

type RecallBudget = {
  maxMemoryChars?: number    // memories tier の上限。目次帯は含まない
  maxMemoryTokens?: number   // 同上（トークン）
  promptBudgetTokens?: number
}

interface TokenCounter {
  count(text: string): { tokens: number; counter: 'heuristic' | 'exact' }
}
```

### ⚠ 目次帯は予算の対象外である（2026-09 訂正）

**`budget` が縛るのは `memories` tier だけである。目次帯（`IndexBand`）は予算の対象外であり、
`budget` をどれだけ小さくしても削られない。**

理由は [ADR 0008](./decisions/0008-absence-taxonomy.md) の芯にある——目次帯の唯一の存在理由は
**「recall が0件でも、何が在るかは言える」**ことである。これを予算の対象にすると、
**呼び出し側が渡した数字ひとつでその保証が消える。予算次第で消える保証は、保証ではない。**

**当初案は予算の項目を `maxChars` / `maxTokens` と呼んでいた。これは誤りだった**——
「recall 全体の上限」と読める名前でありながら、実際には `memories` tier しか縛らない。
名前を `maxMemoryChars` / `maxMemoryTokens` に改め、**何に対する上限なのかを名前に出す。**
名前で誤解を潰しておかないと、次に誰かが「予算なのに効かないのは変だ」と言って
目次帯を予算に含めにいく。**そのとき止めるのは、名前ではなく上に書いた理由である。**

### ⚠ `share` は「予算の何割を使ったか」であり、「全体でいくらか」ではない（2026-09 訂正）

当初の実装は `share` の分子に**目次帯を含めていた**。目次帯は予算の対象外なので、
予算が縛っていない量まで分子に数えることになり、**`share` が 100% を超えた**
（サンプルアプリで 248.3% を実測）。

**1つの数で2つの問いに答えようとすると、どちらかが嘘になる。**

| 問い | 答える値 |
|---|---|
| 私が渡した予算のうち、記憶がどれだけ使ったか | `share`（**1 を超えうる**。超えたら `budgetExceeded` が `true`） |
| この応答は全体でいくらかかったか | `chars`（= `memories` tier + `indexChars`） |

⟹ **`share` の分子は `memories` tier だけとする。**この絞り込み自体は 248% 問題（目次帯混入）
を直した点で正しい。**しかし、それだけでは「`share` は 1 を超えない」の根拠として足りない**
（2026-09 再訂正、[ADR 0097](./decisions/0097-recall-usage-share-may-exceed-1.md)）。

段4の切り詰め（強制）は `memories` tier を **予算内に収めることを保証する**が、それは
「強制側が数える量」の話であって、「`share` の分子が数える量」とは**別の数え方**である。
強制側は digest ごとに `TokenCounter.count()` を呼んで合算する（`unitTokens` の合計）が、
`share` の分子は `digests.join("\n")` を**1回だけ** `count()` する。改行区切り文字の分だけ
後者が前者を上回ることがあり、そのとき段4は「予算内」と判定して両方残すのに、実際に返した量
（`share` の分子）を測り直すと予算を超える。**実測**（非CJK20字の digest2件・
`maxMemoryTokens: 10`）: 強制側 `5+5=10 ≤ 10`（両方残す）、`share` の分子は
`ceil(41/4)=11`、`share = 11/10 = 1.1`。**`RecallUsageSchema` は現在この値を型としても
そのまま受け付ける**（`.max(1)` は ADR 0097 で外した——守られていない保証を宣言し続ける
ほうが実害が大きいため）。
全体量を知りたい呼び出し側は `chars` を見るか、`chars - indexChars` で予算対象分を取れる。

**これは「無い」の種類を潰さない、という規律を*数*に当てたものである**——
割合として成立しない数を、割合の顔で返さない。

`budget` は `recall()` への入力、`usage` は出力である。この二つを分けて持つことに意味がある——後述する。

### `usage.budgetExceeded`（2026-09 追記、Issue #108「案3」）

```ts
type RecallUsage = {
  // ...(上記に同じ)
  share?: number
  budgetExceeded?: boolean   // 申告された予算次元のうち、いずれか1つでも超えたか
}
```

**3状態を区別する。** 予算が1次元も申告されていない ⟹ 欄そのものが無い（`undefined`）。
申告されていて超えていない ⟹ `false`。申告されていて超えた ⟹ `true`。
**`false` を「超えていない」と「測っていない」の両方の意味にしない**——存在条件は
`share` と同じにしてある（`budget: {}` のように次元が1つも無ければ、この欄も無い）。

**`share` からは導出しない。** 理由は2つ:

1. 強制側（段4の切り詰め）は digest ごとに `TokenCounter.count()` を呼ぶため、
   ヒューリスティックなカウンタの `Math.ceil` が件数ぶん掛かる。`share` の分子は
   連結した1本に対して `ceil` を1回だけ行うので、加法的に一致しない
   （非CJK20字の digest 2件・各5トークンに `maxMemoryTokens: 10` を渡すと、
   強制側は `5+5=10 <= 10` で両方残すが、連結して測り直すと改行込み41字で
   `ceil(41/4) = 11` になり超えている——実測はコードの歯を参照）。
2. `share` の分母はトークン予算優先（`maxMemoryTokens`/`promptBudgetTokens` の
   最小値 ?? `maxMemoryChars`）なので、トークン予算が申告されると `maxMemoryChars` は
   分母から丸ごと消える。両方申告された場合、chars 次元の充足度は `share` からは読めない。

⟹ 返した memories を、申告された全予算次元（`maxMemoryChars` / `maxMemoryTokens` /
`promptBudgetTokens`）に対して個別に測り直し、どれか1つでも超えていれば `true` にする。

**`maxMemoryChars` だけは、この不一致が起こらない。** 強制側と計測側が「digest.length の
単純な合計」という同じ式であり、連結の区切り文字も複数回の `ceil` も無いためである。
段4は `maxMemoryChars` が申告されていれば必ずそれを守ってから候補を確定するので、
**この次元だけを申告した経路では `budgetExceeded` は構造的に常に `false` になる**
（true になる入力を作れない）。それでも判定に含めているのは、他の次元と併せて
申告されたときにこの次元を判定から落とさないため——`share` の分母がトークン優先で
`maxMemoryChars` を切り捨てるのと同じ落とし穴を、ここで繰り返さないためである。

**引き受けた負債:**

1. **`budgetExceeded` は真偽値なので、`heuristic` な推定が実態から外れていること自体は
   検知できない。それは別の口が要る。** 採らなかった案——「推定である」ことも欄に出す——
   のほうがこの問いに答えていたが、本 PR ではそこまでは実装していない。
2. 「強制と計測で数え方が違う」という `share` の穴（上記1）は、ここでも直していない。
   **これは見落としではなく、ADR 0083 が型変更の影響範囲の広さを理由に意図的に見送った
   範囲である。**[ADR 0097](./decisions/0097-recall-usage-share-may-exceed-1.md) が回収したのは
   **この不一致そのものではなく**、「`share` は 1 を超えない」という `RecallUsageSchema` /
   JSDoc の**誤った保証の宣言**のほうである——`.max(1)` を外し、超えうることと理由を明記した。
   **強制側と計測側の数え方をどちらに統一するかは、依然として別の判断として残っている。**

### 正直に書くべき限界: mnemora はプロンプトを組み立てない

`usage.share` が測れるのは「呼び出し側が `budget` を申告した場合の、その予算に対する割合」だけである。**「プロンプト全体の何割を mnemora の出力が占めているか」は mnemora には原理的に測れない。** mnemora が返した文字列を呼び出し側がどう他の文脈(システムプロンプト、ツール定義、会話履歴)と組み合わせるかは mnemora の関知するところではないからである。alteroid が「セッション構築時点からの増分%」を出せているのは、alteroid 自身がプロンプト全体を組み立てているクローンだからである。mnemora とアプリケーションの間にはこの非対称性があり、それを明記しておく([./roadmap.md](./roadmap.md) のリスク「認知レイヤーが利用側のプロンプト構築と密結合になるリスク」と同根)。

### セッション基準値を持たない

alteroid の増分計測は「セッション構築時点」を基準にしており、その基準値は**プロセス内のメモリ変数**として保持されている。これは「1クローン = 1長寿命プロセス」という前提に強く依存する設計である。mnemora は多テナント・マルチインスタンスで動くことを前提としており、「セッション」という概念自体を持たない——セッションの概念は呼び出し側にある。この基準値を mnemora 側に持ち込むと、それをどこかに永続化する必要が生じ、mnemora が状態を持つことになる。したがって**mnemora は「セッション構築時点からの増分」を持たない**という決定をしている。mnemora が返すのは「1回の recall が返した量」(`usage`)と、予算が申告されていればその割合(`share`)だけである。

### ⚠ 最も重い発見: 計測は行動を変えると仮定しない

alteroid のコード自身が「この計測機能が効くかは未検証」と明記している。実測ログには、文字数が 37,515 から 51,751(+38%)まで増えたのを見ながら、クローンが畳む(要約・削除する)行動を取らなかった事例が記録されている。**「測って見せれば行動が変わる」という前提を、検証済みのものとして輸入してはならない。** mnemora は計測(`usage`)を提供するが、それが肥大を抑止すると主張しない。

### 設計上の帰結

抑止するのは計測ではなく、実際に超えたら落とす**強制力のある予算**である。したがって mnemora は計測(`usage`)と強制(`budget`)を型として分け、両方を持つ。`usage` だけを返して「見えるようにしたのだから後は呼び出し側の判断」で済ませない。`budget` を渡された recall は、パイプライン段4で実際に候補を切り詰める。渡されなければ切り詰めは起こらず、`usage` は観測専用の値になる。

### トークン数の推定

core はモデル固有のトークナイザに依存しない。`TokenCounter` interface を core に置き、既定実装は文字数ベースの推定(ヒューリスティック)とする。実装を差し替えれば特定モデルの正確なトークナイザ(`counter: 'exact'`)に切り替えられる。**推定値には必ず `counter: 'heuristic' | 'exact'` を付ける**——これも「推定値を実測値の顔で出さない」という原則3の適用である。この計測(`usage`)は Phase 1 に含める。「載せる量を測る」はコスト管理の一部であり、後から足す性質のものではない。

既定実装は**文字種で重み付けする**（CJK 0.9トークン/コードポイント・非CJK 0.25。[ADR 0083](./decisions/0083-cjk-aware-heuristic-token-counter.md)）。以前の「4文字 ≒ 1トークン」は日本語の合計を実測の **0.353倍**しか数えず、`maxMemoryTokens` はこの値で判定されるため**予算が静かに超過していた**。⚠ **精度が上がっても推定は推定である**——`counter` は `'heuristic'` のままであり、CJK 以外の非ラテン文字（キリル・タイ・アラビア文字）は依然として過小評価する。**日本語主体でも厳密さが要る用途では `TokenCounter` を実測トークナイザに差し替えること。**

---

## 7. スコア内訳と説明

`RecalledMemory` はスコアの内訳を要素ごとに個別に見える形で持つ。

```ts
type RecalledMemory = {
  memoryId: string
  digest: string
  retrievedVia: 'ann' | 'lexical' | 'mandatory_companion'
  companionOf?: string          // 矛盾の相手として同伴取得された場合、その相手の memoryId
  provenanceKind: ProvenanceKind // 本人が述べた事実か、AI の推論か（オーナーの原則7）
  score: ScoreBreakdown
}

type ScoreBreakdown = {
  similarity?: number   // ANN 経由でのみ存在。距離から変換した類似度
  decay: number          // decay(now, lastReinforcedAt, strength, halfLife) の値
  tagMatch: number
  freshness: number      // 1 で頭打ち（ADR 0036）。まだ起きていない出来事は古びようがない
  strength: number
  total: number           // 段2で使った最終スコア
}
```

**⚠ 2026-09-16 追記**: `retrievedVia` は以前 `'tag_match'` / `'recency'` も持っていたが、
生成するコードが一度も無かった（Issue #206 /
[ADR 0117](./decisions/0117-unreachable-union-values-inventory.md) の分類3）。オーナー判断を
受けて [ADR 0144](./decisions/0144-drop-unreachable-classification-3-union-values.md) で落とした。
**また、上のスニペットはこの追記の前まで `'lexical'`（[ADR 0084](./decisions/0084-lexical-recall-channel.md)
で実装済み）を欠いたまま放置されていた——ここで併せて直した。**

Memory 本体(内容・provenance の詳細・状態)の型は `./memory-model.md` に譲る。ここで持つのは recall という文脈固有の付加情報——「どの経路で拾われたか」「スコアの内訳」「同伴取得ならどの矛盾の相手として来たか」、そして**「本人が述べた事実か、AI の推論か」**である。

**`provenanceKind` だけは `Memory` 本体からの持ち出しである(2026-09 追記)。**理由は `./memory-model.md` §2 が既に書いていた——「recall がデフォルトで `stated` と `inferred` を**区別して返す**」ために `provenance_kind` を列に上げている。**列は最初から在ったが、`recall()` の返り値に出ていなかった。**オーナーが `../roadmap.md` §5.5 の回答で「含める。ただし `provenance.kind` で区別して返す」という条件を明示したため、この欠落を塞いだ([ADR 0035](./decisions/0035-recalled-memory-provenance-kind.md))。

**⚠ 持ち出すのは `kind` だけである。**`model` / `promptVersion` / `basis` / `confidence` は返さない。求められているのは**区別**であって中身の追加ではなく、毎回の返り値を太らせない(問い1)。それらが要る呼び出し側は `MemoryStore.get()` を引く——「1件を詳しく見る」は別の問いである。

**「なぜこれが返ったか」は自然文ではなく構造で返す。** `explain.stages` と `RecalledMemory.score` を組み合わせれば「段1でベクトル距離0.12として拾われ、段2で decay 0.9 × tagMatch 1.2 × freshness 1.0 × strength 0.8 を掛けて total 0.83 になり、k=10 の9位で予算内に収まった」という説明を機械的に再構成できる。この構造から自然文の説明文を組み立てるのは呼び出し側の仕事であり、mnemora の仕事ではない。理由は §6 で述べたのと同じ——mnemora はどんな言語で・どんなトーンで・誰に向けて説明するかを知らない。mnemora が保証するのは、説明を組み立てるために必要な材料が欠けていないことだけである。

---

## 8. 矛盾がある場合の提示

段3(矛盾の解決と必須の同伴取得)が recall パイプライン上でどう働くかを述べる。データモデル側の詳細(`status` の遷移、`contradicts` の対向関係、`superseded_by_id` 列)は `./memory-model.md` に譲る。

recall は既定で `status = 'active'` の Memory のみを候補にする。ただし `contested`(判定できない矛盾)の Memory は、候補になった時点で**単独では返さない**。対向する Memory(`contradicts` の相手)をスコアに関係なく候補集合へ追加する。これが段3の仕事であり、`RecalledMemory.retrievedVia = 'mandatory_companion'` として、それがスコアで選ばれたのではなく矛盾解決のために強制的に足されたことを型で示す。

**予算(段4)と衝突したときの優先順位: 同伴を落とすくらいなら本体を落とす。** `contested` の Memory とその対向は必ずペアで扱い、ペアを分割して片方だけを予算内に残すことはしない。予算が両方を載せられない場合、そのペア全体を候補から外し、`Omission { kind: 'budget_dropped', ... }` に含める(あるいは、そのペアの片方だけを「争われている」という印を付けて残す設計も選択肢としてあり得るが、Phase 1 の既定は「両方落とす」とし、争われている主張を争われていない顔で出すという事故を避ける側に倒す)。**争われている主張を、争われていない顔で出すくらいなら、両方とも出さない**——これが原則1の recall パイプライン上の実装である。

**⚠ 段3は長いあいだ「一度も発火しない分岐」だった**(Issue #197)。`contested` を書く本番コードが1つも無かったためである。2026-09 に `Runtime.markContested`([ADR 0134](./decisions/0134-mark-contested-explicit-operation.md))が入って発火するようになり、対の**解決**(`contested → active | superseded`。`./memory-model.md` §11 行7)は `Runtime.resolveContested`([ADR 0150](./decisions/0150-resolve-contested-explicit-operation.md))が担う。**決着がつくと `contested_with_id` が消えるため、負けた側は次の recall から返らなくなり、同伴取得も起きなくなる。**

**この段を通ったかどうかは、`RecallResult.explain.stages` の `contradiction_resolution` の `detail.companionsAdded` で数えられる**(0 なら同伴取得は1件も起きていない)。ADR 0150 決定7は、この値を歯として使い、さらに**段3が壊れた世界をテスト側で作って歯が実際に赤くなることを示す変異試験**を置いている——**「テストが緑である」ことは「その分岐を通った」ことを意味しない**、という Issue #197 の指摘への答えである。
---

## 9. 「聞かれていないことを、自分から思い出す」— 連想枠（[ADR 0151](./decisions/0151-recall-association-unprompted.md)、Issue #200）

**`docs/north-star.md`「目指す姿」7項目のうち、唯一まるごと空いていた1行がこれである。**

> - **聞かれていないことを、自分から思い出す。**

**この節が、その1行に対応する設計である。**

### 9.1 どちらの意味に採ったか

Issue #200 は**2つの読み方**を挙げていた。

1. **mnemora が*話しかける*** — `Sensor` / `SpeechPolicy`（`../architecture.md` §5.13）の設計が要る
2. **呼び出し側が*問い合わせなくても候補が手元に在る*** — `recall()` の拡張で済む

**2 を採った。**1 は北極星の**問い2**（これを無効にしたとき Memory Framework として成立するか）で落ちる
——`Sensor` が「これが無いと動かない」になる方向へ引っ張るためである。
**⟹ 動詞は5つのまま増えない。**`Sensor` / `SpeechPolicy` は `../architecture.md` §5.13 の仮置きのまま据え置く。

**⚠ この分岐の決定の出所と、覆り方は ADR 0151 に書いてある。**ここには書き写さない。

### 9.2 何をするか

**クエリで引けた記憶（アンカー）の近傍を、同じ埋め込み空間の二段目として引く。**

1. `query.association` が無ければ**何もしない**（`omitted` にも積まない）。
2. `VectorStore.getVectors`（**任意メソッド**）が無ければ
   `stage_skipped { stage: 'association', reason: 'vector_store_lacks_get_vectors' }` を積んで終わる。
3. 段3までに残った集合の上位 `anchorCount` 件をアンカーにする。0件なら
   `stage_skipped { stage: 'association', reason: 'no_anchor' }`。
4. アンカーのベクトルを `getVectors` で引き、**そのベクトルで** `VectorStore.search` を
   **段1の ANN 検索と同じ filter で**呼ぶ——scope（tenant/subject/status/period/
   `excludeProvenanceKinds`）**だけでなく、忘却ゲート（[ADR 0153](./decisions/0153-recall-decay-floor-gate.md) /
   [ADR 0165](./decisions/0165-decay-activity-clock.md)）と `validAt` ゲート
   （[ADR 0164](./decisions/0164-valid-from-until-recall.md)）も含む。**
   ⚠ **ここで境界を散文で数え直さないこと**——段3.5 だけが忘却ゲートと `validAt` ゲートを
   渡しておらず、減衰しきった記憶と期限切れ／未発効の記憶が連想枠から返っていた
   （[Issue #347](https://github.com/takecchi/mnemora/issues/347) /
   [ADR 0172](./decisions/0172-association-passes-decay-and-validity-gates.md)）。
   実装の単一の出所は `recall-runtime.ts` の `gateVectorFilterFields` である。
   後置フィルタも段1と同じ述語（`survivesDecayGate` / `survivesValidityGate`）を呼ぶ。
5. 既に返る集合・アンカー自身・`minSimilarity` 未満を除く。
6. 残りを `maxCount` 件まで採り、`retrievedVia: 'association'` と
   `associationOf: <アンカーの memoryId>` を立てる。**`maxCount` を超えた分は
   `omitted { kind: 'over_limit', stage: 'association', count, countKind: 'exact' }`
   として報告する**（2026-09-17 追記、[Issue #375](https://github.com/takecchi/mnemora/issues/375) /
   [ADR 0188](./decisions/0188-association-over-limit-omission.md)）——この手順4〜5を
   通過した時点で候補は既にゲート・除外・類似度の条件を満たしており、単に `maxCount`
   で切っただけである。段2の `passed.slice(limit)`（§7）が `over_limit` を積むのと
   同じ形。

**⚠ 「走らせて0件だった」と「走らせなかった」を同じ顔にしない。**
走らせて0件のときは `stage_skipped` を積まない——本文書全体を貫く原則3
（結果は、そこから漏れたものと必ず同時に提示する）の、この段への適用である。

### 9.3 なぜ新しい「似ている」の定義を作らないか

**使うのは ANN が既に使っているコサイン類似度そのものであり、起点がクエリからアンカーに変わるだけである。**

これは意図した制約である。**「何が似ているか」を製品側が新しく定義することは、
`../roadmap.md` §5.7（Issue #135）がオーナー判断として保留している事柄そのもの**であり、
設計側で決めてよい範囲の外にある（`../autonomy.md` §3.1）。
⟹ **連想枠は §5.7 を踏まずに「自分から思い出す」を埋める。**
逆に、**クエリを一切持たない周辺想起**（「問われていないときに何を出すか」）は §5.7 と同族であり、
**ここでは決めない。**

### 9.4 説明可能性 — `associationOf`

**「聞かれていないことを返す」機能は、聞かれて返す機能よりも説明責任が重い。**
呼び手は自分で問いを立てていないので、**なぜそれが来たのかを推測できない。**

だから連想の候補は `associationOf`（どのアンカーが連れてきたか）を持つ——
既存の `companionOf`（必須の同伴取得）と同じ形・同じ理由である。北極星の**問い3**。

**⚠ `ScoreBreakdown` にアンカーとの類似度を入れてはならない。**
`score.semanticSimilarity` は**クエリとの**類似度である。そこへ別の起点からの量を入れると、
呼び手は2つの量を同じ尺度として比べてしまう。北極星の**問い3・問い4**に反する。

**⚠ `associationOf` はアンカーを1つしか指さない。**複数のアンカーから同じ記憶が浮上したとき、
記録されるのは1つだけである（ADR 0151 の負債4）。

### 9.5 予算 — ⭐ 北極星の問い1の関門

**連想枠は、量を増やす方向の機能である。**素朴に入れれば北極星の**問い1**
（毎回渡す量を減らす方向に働くか）で落ちる。通したのは条件を付けたからである。

1. **既定 off。**`association` を渡さない呼び出しの挙動は**1バイトも変わらない。**
2. **予算（段4）の内側に置く。**⚠ **§6 の「目次帯は予算の対象外」をここへ適用しない**
   ——目次帯が対象外でよいのは**件数だけの帯だから**であり、連想枠は digest 本文を持つ。
   **実トークンを焼く。**
3. **予算で削るときは最初に落とす。**クエリで引けたものを押し出さない。

### 9.6 これが無くても成立する

`VectorStore.getVectors` は**任意メソッド**であり、`association` は**任意フィールド**である。
⟹ **新しい動詞・新しい必須依存・新しい常駐プロセスを1つも作らない。**北極星の**問い2**。

### 9.7 ⚠ 「実装した」と「効いた」は別である

**この節は実装を述べたに過ぎない。**北極星の物差し
（使う側が会話ログを全部プロンプトへ積むのをやめられたか）を動かしたとは**主張しない。**

- **既定 off である限り、物差しは動かない。**呼び手が明示しなければ何も変わらない。
- **`examples/chat` の `compare` ベンチは、連想枠の便益を測れない**
  ——想起側の指標 `factStatementSurvived` は基準値の全12行で既に `true` であり、**伸びる余地が無い。**
  測るべき器は `retrieval` ベンチ（`hit@k` / MRR）だが、**それは⭐門ではない**（ADR 0133）。

⟹ **測る仕事は別に割ってある。**測って動かなければ落とす（ADR 0151「これが覆るとしたら」3番）。
