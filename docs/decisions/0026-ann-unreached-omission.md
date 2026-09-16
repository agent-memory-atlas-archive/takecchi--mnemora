# ADR 0026: 近似索引が scope に届かなかったことを `Omission { kind: 'ann_unreached' }` として出す

- **状態**: 採用 (2026-09)

- **文脈**:

  [ADR 0025](./0025-ann-underfill-is-not-reported-in-omitted.md) が実測した破れ:
  大きい subject で `recall()` を呼ぶと、6,288件が scope に在るのに 0件返り、
  `omitted` に理由が1つも無かった。`ann_truncated` も付かない
  （条件が `annHits.length >= kPrime` であり、`hits=0 < kPrime=40` では成立しない）。

  **⟹「近似索引がその scope に届かなかった」ことと「そもそも scope に何も無かった」ことが
  `omitted` の上で同じ顔になっていた。** [ADR 0008](./0008-absence-taxonomy.md) の判定基準
  （その区別があると次の一手が変わるか）に照らすと、次の一手は明確に変わる——取りこぼしなら
  `overFetchFactor` を上げる・subject を絞り直す・厳密検索へフォールバックするという手が在るが、
  そもそも無かったのなら何もできない。ADR 0025 はこの実測だけを残し、直すかどうかはオーナー判断
  に預けていた。**オーナーの判断: 出す。ただし `ann_truncated` に相乗りさせない。**

- **決定**:

  新しい `Omission` の種類 `ann_unreached` を足す。

  ```ts
  export interface AnnUnreachedOmission {
    kind: "ann_unreached";
    countKind: "unknown";
  }
  ```

  **`countKind` は `'unknown'` 固定とする。** 値を持つ欄は無い——件数を持たせない。

  **発火条件**（`packages/core/src/recall-runtime.ts`、段5の `aggregate` を使う）:

  ```
  eligible = aggregate.totalInScope - Σ(aggregate.notIndexed の各 reason の count)

  candidateGenerationExecuted
    && kPrime > 0
    && annHits.length < kPrime      // k' に達していない（達していれば ann_truncated の領域）
    && annHits.length < eligible    // scope 内にまだ見られていない候補が残っている
  ```

  `eligible` は「scope 内で、埋め込みが在り、ANN の候補になり得たもの」の件数である。
  **2つ目の条件（`annHits.length < eligible`）が「鳴ってはいけない側」を守る**——候補が
  scope に3件しか無くて3件とも ANN が返した場合、`3 < kPrime(40)` は成立するが
  `3 == eligible` なので鳴らない。この条件を落とすと、候補を全部拾えている場合にも
  常に鳴るようになる（`packages/core/src/__tests__/recall-pipeline.test.ts` の歯Bが
  これを守っている。「変異1」として実際に落として確認済み——後述）。

  **段5がスキップされる経路は無い。** `runRecall`（`recall-runtime.ts`）を通読した結果、
  早期 return は1箇所も無く、段0〜段6は必ず順に実行される。したがって `aggregate` は
  この判定に到達する時点で必ず存在する。**もし将来、段5をスキップする経路が実装されたら、
  そこでは `ann_unreached` を判定できない——「取りこぼしたかもしれない」と断言する根拠
  （`eligible`）が無いため、鳴らさないこと。**

- **`ann_truncated` に相乗りさせない（採らなかった案 1）**:

  `ann_truncated`（over-fetch の打ち切り、`annHits.length >= kPrime`）と今回の事象
  （`annHits.length < kPrime` なのに scope の候補を拾いきれていない）は**別の出来事**である。
  前者は「もっと在るはずだが LIMIT で切った」という確定した事実、後者は「k' に届く前に
  近似索引が scope の他所へ行ってしまった」という取りこぼしの疑いであり、原因も違えば
  次の一手も違う。**同じ札に潰すと、まさに ADR 0008 が禁じている「別の理由を同じ顔にする」を
  自分の手でやることになる。** だから独立した `kind` として出す。2つの発火条件は排反
  （`hits >= kPrime` と `hits < kPrime`）であり、同時には立たない
  （歯C。「変異2」として実際に壊して確認済み——後述）。

- **件数を数えて出す案（採らなかった案 2）**:

  「何件取りこぼしたか」を数値で出す案は**却下する**。この系は原理的に「何件取りこぼしたか」を
  知りようがない——ANN が触れなかった候補を数えるには、scope 全体を厳密に走査して ANN が
  返した集合と突き合わせる必要があり、それをやるなら ANN を使う意味（近似で索引を使い倒す）
  自体が無くなる。数えようとした瞬間に近似索引をやめることになる、という意味で
  この案は自己矛盾している。

  **新しい語彙（例えば独自の countKind 値）を作る必要も無い。** 既に在る
  `CountKind` の `'unknown'` で「取りこぼしたのは確かだが、何件かは分からない」と言える
  ——`AnnTruncatedOmission` が同じ形（`{ kind; countKind: 'unknown' }`、件数の欄を持たない）
  をしているので、それに倣った。

- **引き受ける負債**:

  **`ann_unreached` は件数を持たない。** 呼び出し側は「取りこぼした可能性が在る」ことは
  分かるが、「どれだけ取りこぼしたか」は原理的に知れない。`ann_truncated` の
  `nearMisses` のような手掛かりも無い——ANN が触れなかった候補の識別子は、
  ANN の外側からは見えないので、`recall()` はそれを持ちようがない。

  これは docs/recall.md §4 の「推定値を実測値の顔で出さない」を徹底した結果の負債であり、
  「せめて下限だけでも出す（`lower_bound`）」という中間案も検討したが**採らなかった**
  ——下限を出すには「ANN が返した件数」以外に何か1つでも厳密な手掛かりが要るが、
  今回の事象にはそれが無い（`ann_truncated` の `lower_bound` 相当の情報、例えば
  「LIMIT に達した」という確定事実に相当するものが、`ann_unreached` には無い）。

- **⭐ 歯（`packages/core` に、DB 不要で配置。`packages/core/src/__tests__/recall-pipeline.test.ts`）**:

  - **歯A（鳴る側）**: scope に候補が5件（すべて `embeddingStatus: 'ready'`）あるのに、
    ANN が2件しか返さない状況（`CappedVectorStore` というテスト内ラッパーで
    ANN の返り件数を人為的に切り詰める。`FakeVectorStore` 自体は変更していない）を作り、
    `ann_unreached` が現れることを確認する。
  - **⭐ 歯B（鳴ってはいけない側。オーナー名指し）**: 候補3件・`kPrime=40`・`hits=3`
    （scope の候補を ANN が全部返した状況）で `ann_unreached` が現れないことを確認する。
  - **歯C**: `ann_truncated` が鳴る状況（`limit=1, overFetchFactor=1` で `hits==kPrime==1`）
    では `ann_unreached` が同時に鳴らないことを確認する。

  **変異テスト（実際に当てて確認済み）**:

  - **変異1**: 発火条件から `&& annHits.length < eligible` を落とす
    → **歯Bが赤くなった**（29 passed / 1 failed、失敗したのは歯Bのみ）。予定どおり、
    鳴ってはいけない場面で鳴るようになったことをこの歯が検出した。
  - **変異2**: `annHits.length < kPrime` を `annHits.length <= kPrime` に変える
    → **歯Cが赤くなった**（29 passed / 1 failed、失敗したのは歯Cのみ）。予定どおり、
    `ann_truncated` と同時に立つようになったことをこの歯が検出した。

  両変異とも直後に元へ戻し、`vitest run` で30件全緑・`tsc -p tsconfig.json` でエラー無しを
  再確認した。

- **確かめていないこと**:

  - **本物の Postgres + pgvector に対する実測をしていない。**
    ADR 0025 が実測した「大きい subject で 6,288件中0件返る」ケースに対して、
    今回の実装が実際に `ann_unreached` を出すことは**確認していない**
    （手元に PostgreSQL が無く、`packages/postgres` 側のテストは走らせていない）。
    `FakeVectorStore` を使ったテストは「発火条件のロジックが正しいか」を検査するものであり、
    「本物の HNSW の振る舞いに対して条件が現実的に発火するか」は別の問いである。
  - **`eligible` の定義（`totalInScope - notIndexed合計`）が唯一の妥当な定義かは検討していない。**
    例えば `filteredPeriod`/`filteredStatus`/`filteredArchived` で落ちた件数を `eligible` から
    引くべきかどうかは考えていない——ただし段1の ANN クエリはこれらのフィルタを掛けずに
    `subjectId` の等値フィルタだけを掛けている（`recall-runtime.ts` 段1のコメント参照）ため、
    「ANN が候補になり得た」の外延に `status`/`period` を含めるべきかは未検討のまま残る。
  - **`examples/chat/src/compare.ts` の `formatOmittedSummary` に `ann_unreached` の表示を
    足したが、実際に compare の出力にこの kind が現れるシナリオを実行して確認していない**
    （`OPENAI_API_KEY` を読まない・実 API を叩かない制約の下で作業したため）。
  - **`docs/roadmap.md` 等、他の文書にこの ADR への言及を足していない。**
    `docs/recall.md` §3・§4 と `docs/decisions/README.md`・ADR 0025 への追記のみ行った。

- **これが覆るとしたら**:

  ADR 0025 の「確かめていないこと」にある通り、HNSW の近似は index の構築ごとに揺れ、
  「何件返るか」は再現しない。もし本物の Postgres での実測で、`eligible` の定義や
  発火条件の閾値（例えば `annHits.length < eligible` を `annHits.length < eligible * 0.9` の
  ような緩和にすべきかなど）が実運用のノイズに対して過敏/鈍感だと分かったら、
  そのときに条件式を見直す。**その見直しも、今回と同様に歯を先に赤くしてから直すこと。**

---

## 追記（2026-09-06）: **足した欄が、名乗りどおりに働くことを本物の DB で実測した**

[ADR 0024](./0024-remove-exact-counts-option.md) が自分に課した線
——**「区別を表す欄を足したら、その値を作る経路を1つずつ実測して、名乗りどおりのものが
入るか確かめる」**——を、この欄に対して実際に行った。
`exactCounts` は「受け取って黙って無視する」欄だった。**同じものをもう1つ作らないため**である。

出所: GitHub Actions run 34012828007、PostgreSQL 17 + pgvector、
`packages/postgres/src/bench/scale-bench.ts` Part 4（[ADR 0025](./0025-ann-underfill-is-not-reported-in-omitted.md)
が破れを実測したのと**同じ条件・同じベンチ**）。

| 呼び出し | `omitted` 件数（ADR 0025 実測時） | `omitted` 件数（本 PR 適用後） | `ann_unreached` |
|---|---:|---:|---|
| `subjectId` 指定（10,000行の subject） | 5 | **6** | **出た** |
| `subjectId` 指定・`scoreThreshold: 0` | 5 | **6** | **出た** |
| `subjectId` 無し（比較用） | 7 | 7 | **出ない** |
| `subjectId` 無し・`scoreThreshold: 0` | 7 | 7 | **出ない** |

⟹ **破れが実測された当の経路で、ちょうど1件だけ増えている。**
そして**`subjectId` を指定しない経路では増えていない**——そちらは `hits = 40 = kPrime` であり、
**`ann_truncated` の領域**だからである（両者が同時に立たないことは、歯Cが単体テストでも押さえている）。

**⟹ この欄は「置いてあるだけ」ではない。破れた場所で鳴り、鳴ってはいけない場所で黙っている。**

**⚠ ただしこの実測でも確かめていないこと**: 本物の DB で**鳴ってはいけない側**
（小さい subject で候補を全部返した場合に鳴らないこと）は、**単体テスト（歯B）でしか
確かめていない。** 上の表の「`subjectId` 無し」は `ann_truncated` の領域であって、
「scope を全部見た」場合ではない。**本物の DB での「鳴ってはいけない側」は未実測である。**

---

## 追記（2026-09-17）: **「両者は同時に立たない」（歯C）という決定は、[ADR 0193](./0193-ann-unreached-covers-full-window.md) で覆った**

**この節から上は当時の決定・実測の記録のまま書き換えていない。** 以下は事後の訂正である。

`ann_unreached` の発火条件に `annHits.length < kPrime`（窓が埋まっていない）を含めた
判断は、「窓が埋まっていれば `ann_truncated` の領域であり、scope の候補は ANN が
拾いきれている」という前提に立っていた。**この前提は誤りだった**——`ann_truncated`
の判定式（`packages/core/src/ann-truncation.ts`）の doc コメント自身が、窓が満杯でも
近似索引が scope の他所へ行っていれば上界が破れうると明記しており、その事象を
「`ann_unreached` が別に扱う」と名指ししていた。ところが当時の `ann_unreached` の
条件式は、まさにその場合（窓が満杯）を除外していたため、**窓が満杯かつ近似索引が
真の近傍を取りこぼした場合、`ann_truncated` も `ann_unreached` も鳴らない**という
無音の穴が残っていた。ADR 0193 がこの条件から `annHits.length < kPrime` を落とし、
窓の満杯/未満を問わず `annHits.length < eligible` だけで判定するよう直した。
**⟹ 今日、`ann_truncated` と `ann_unreached` は同時に立ちうる。** 上表の
「`subjectId` 無し」（`hits = 40 = kPrime`）を今日の条件で再実測すれば、
`eligible > 40` である限り `ann_unreached` も出るようになったはずである
（ADR 0193 側で別途、単体テストの歯として固定した。本追記の時点で本物の DB による
再実測は行っていない）。詳細と理由は ADR 0193 を見ること。
