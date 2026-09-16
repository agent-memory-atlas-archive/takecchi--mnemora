# ADR 0199: `examples/chat/README.md` の `identifier-probes` 節と基準値 JSON の一致を、既存 vitest に相乗りする歯で見張る

- **状態**: 採用 (2026-09-17)
- **日付**: 2026-09-17

---

## 文脈

[Issue #425](https://github.com/takecchi/mnemora/issues/425)（docs の【実測】棚卸し）の
「🔴 疑わしい」件3が、`examples/chat/README.md` の `identifier-probes` 節を実体と突き合わせて
発見した drift:

| README の記述 | 実体（`identifier-probe-baseline.json`） |
|---|---|
| 「**3群**を別々に集計する」 | **5群**（`japanese`/`identifiersSparse`/`identifiersDense`/`japaneseNamesSparse`/`japaneseNamesDense`） |
| `identifiersSparse`/`identifiersDense` は probe **12件** | **30件**（2026-09-13、`3350e18`） |
| 実測結果の表が `hit@1` を全群 **12/12** としている | `japaneseNamesSparse`/`japaneseNamesDense` は **11/12** |

**入れ違いの経緯**: `3350e18`（識別子 probe を12→30件へ増量）と `4602678`
（`japaneseNames` 群を2つ新設）——**どちらのコミットメッセージも「本文は書き換えていない」
と自認している。**書いた側が明示的に「README は直さない」と自覚していたにもかかわらず、
その後もこの節を直す PR が出ていなかった。

**さらに issue が名指しした欠落**: `japaneseNamesSparse`/`japaneseNamesDense` は
天井に張り付いていない実データを持つ——`description` に「org-b（開発一課/開発二課）を
弁別できていない」という具体的な失敗が記録されているのに、README には**その群自体が
登場しない**ため、読者には「識別子probeは12/12で完璧」という誤った印象しか残らない。

issue の「⭐ どうすれば再発しないか」候補2は、この種の drift のうち
**「本数・件数・群数のような、実体から機械的に数え直せるもの」**は歯で縛れる、と
指摘している（性能の絶対値そのものは環境依存のため歯で縛るのは筋が悪い、とも）。
本 ADR はこの候補2を、`examples/chat/README.md` の `identifier-probes` 節に対して
実装する。

---

## 決定

### 決定1: README の本文を実体に合わせて直す

`examples/chat/README.md` の該当節を修正:

- 見出し「3群」→「5群」、群一覧表に `japaneseNamesSparse`/`japaneseNamesDense` を追加。
- `identifiersSparse`/`identifiersDense` の probe数を「12件」→「30件」に直し、
  `3350e18`（Issue #109）で12→30へ拡張した経緯を明記。
- 実測結果の表を5行にし、`japaneseNamesSparse`/`japaneseNamesDense` の
  hit@1=11/12・hit@10=12/12・MRR=0.958 を追加。`provenance.commit`
  （`3350e18`）と `measuredAt`（`2026-09-13T14:08:56.811Z`）を明記し、
  `japaneseNames` の2群がこの commit を土台にした**未コミットの作業ツリー**で
  測定されたものである（`identifier-probe-baseline.json` の `provenance.note`）ことも
  併記した——他の3群の値と出所が異なることを隠さない。
- 新しい読み方の節「`japaneseNamesSparse`/`japaneseNamesDense` は『12/12で完璧』
  ではない」を足し、`description` の逐語（org-bの失敗）を引用した。

### 決定2: 新しい CI ジョブは作らず、既存のルート `vitest run` に相乗りする歯を足す

`scripts/identifier-probes-readme-freshness-lib.mjs`（純関数、ファイル I/O 無し）と
`scripts/__tests__/identifier-probes-readme-freshness.test.mjs` を新設した。
ルートの `vitest.config.mts` は `scripts/**/*.test.mjs` を include 済みであり
（`scripts/identifier-probe-summary-lib.test.mjs` 等と同じ場所）、`pnpm run test` の
1発目（`vitest run`）が自動的に拾う。**新しいジョブも新しい CI ステップも増やしていない**
——`.github/workflows/ci.yml` は無変更。

歯がすること（`checkReadmeMatchesBaseline`）:

- README の見出し「N群を別々に集計する」の N と、基準値 JSON の `groups.length` の一致。
- README の群一覧表（`### N群を別々に集計する` 直後の表）の1列目と、基準値 JSON の
  各 `group` 名が過不足なく一致すること。
- README の「実測結果」の表の各行（`probeCount`・`hit1Count`/`probeCount`・
  `hit10Count`/`probeCount`・`mrrOverall` を3桁に丸めた値）が、基準値 JSON の対応する
  群の値と一致すること。

**見ないもの**: `description` の文面・provenance の逐語・性能の絶対値そのものの
良し悪し。`docs/autonomy.md` §4「擬似 provider の数字を『性能』と読む」と同じ理由で、
歯が縛ってよいのは実体から機械的に数え直せる件数・群数だけであり、性能の解釈は
人間の読み物（README のプローズ）に残す。

### 決定3: README には「実測結果」という見出しを持つ節が他にもあるため、`identifier-probes` 節へ明示的にスコープする

最初の実装は README 全体から最初の `### 実測結果` を検索していたため、`compare` 節
（`### 実測結果（2026-09-05、…）`、行 ~342）を誤って拾い、`identifier-probes` 節
（行 ~1038）の表を見つけられなかった（後述「測ったこと」で実際に踏んだ）。
`extractIdentifierProbesSection()` で `## \`identifier-probes\`:` 見出しから次の
`## \`...\`` 見出しまでを先に切り出し、群一覧表・実測結果の表の検索をその範囲に
限定する形へ直した。

---

## 採らなかった案

### 案A: 何もしない（README の修正だけで出す）

issue が候補2として明示的に許可している選択肢であり、本 ADR を書かずに済む分コストは
低い。**採らなかった理由**: 同じ drift のパターン（コミットメッセージが「本文は
書き換えていない」と自認しながら実際に書き換えなかった）が、この節だけでも2回
（`3350e18`・`4602678`）連続して起きている——ADR 0088 §3 が繰り返し名指ししてきた
「基準値ファイルがコミットされているのに誰も比べない」形の再発であり、次に probe 集合を
変える人が同じ穴に落ちる確率は低くないと判断した。歯自体のコストが小さい
（純関数1本、既存の vitest に相乗り、CI ジョブ追加なし）ため、A を選ばなかった。

### 案B: `identifier-probe-summary.mjs`（CI Job Summary 用）に統合する

既存の `identifier-probe-summary-lib.mjs` は実測 JSON と基準値 JSON の比較を既に持つ
（`buildSummaryMarkdown`）。README との比較もそこへ足す案を検討したが、**役割が違う**
——`identifier-probe-summary.mjs` は「実測値 vs 基準値」（CI が毎回生成する動的な入力）
を比べる CLI であり、非0を返さない設計（決定は ADR 0094 §8）。今回縛りたいのは
「README という静的な文書 vs 基準値」であり、**これが崩れているなら
`pnpm run test` を赤くしてよい**（README は人が書き直すまで放置される文書であり、
「相違があっても黙って進む」を許す理由が無い）。別の性質の検査を同じ関数に混ぜると、
どちらの契約か読み取りにくくなるため、独立した lib + test にした。

### 案C: README の数値部分を基準値 JSON から自動生成する

「二重管理をそもそも無くす」という意味ではこちらのほうが強い解決だが、README の
「実測結果」節は表の数値だけでなくプローズ（読み方・限界・provenance の解説）と
一体になっており、自動生成にすると生成部分と手書き部分の境界を新たに設計する必要が
生じる（`docs/decisions/README.md` の ADR 索引のような、明確に「表だけの節」ではない）。
このスコープでは過剰と判断し、**検査だけ足す**（生成はしない）案にとどめた。

---

## 引き受けた負債

### 負債1: この歯は「見出しと表の形」に依存した正規表現 parser である

README の見出しの文言（「N群を別々に集計する」）や表の列順序を変えると、歯自体が
壊れる（誤検知ではなく「表が見つからない」という形で）。**意図的にそうした**
——`docs/decisions/README.md` の生成器のような厳密な Markdown parser を新設するほどの
規模ではないと判断したが、次に `identifier-probes` 節の見出し文言を変える人は、
この歯のテスト（fixture のユニットテスト）も一緒に見ることになる。

### 負債2: MRR の比較は3桁に丸めた値でしか一致を見ない

README は `**0.958**` のように3桁で表示するため、歯もそれに合わせて基準値を3桁に
丸めて比較する。基準値の生の値（`0.9583333333333334`）と表示値の間の丸め誤差自体は
検査していない——3桁表示が意図的な省略であることは「実測結果」節の表記そのものが
示しており、二重の丸め処理を歯に持たせる価値は無いと判断した。

### 負債3: `japaneseNamesSparse`/`japaneseNamesDense` の2群が「未コミットの作業ツリーで
測定された」という provenance 上の注意点は、歯では検査していない

歯が見るのは数値の一致だけであり、「commit と実際の測定条件が完全に対応しているか」
という、より繊細な provenance の正しさは人間の読み物（README の該当段落、この ADR の
文脈節）に委ねている。

---

## 北極星の問いに当てた結果

### 問1〜問5（`docs/north-star.md` の物差し・Background Cognition・説明可能性・
AI推論とユーザー事実の区別・LLM呼び出しの要否）

いずれも該当しない——本 PR は docs の記述と CI の歯であり、mnemora の実装コードは
1行も変えていない（recall・observe・decay のいずれの経路にも触れていない）。

---

## 測ったこと

**この器（`DATABASE_URL` 無し）で実際に走らせたもの:**

- `npx vitest run scripts/__tests__/identifier-probes-readme-freshness.test.mjs`
  — 11 tests 緑（fixture のユニットテスト10件 + 実物の README/基準値 JSON を読む
  統合テスト1件）。
- 上記と既存の `scripts/__tests__/identifier-probe-summary.test.mjs`・
  `identifier-probe-summary-lib.test.mjs` を同時実行 — 56 tests 緑（既存の歯と
  衝突しないことを確認）。
- `npx eslint .`（リポジトリ全体） — 緑。
- `npx prettier --check` を新設2ファイルに実行 — 最初は不整形で赤、
  `prettier --write` 後に緑（`format:check` が実際に対象にするのは
  `.ts/.tsx/.mts/.cts/.js/.mjs/.cjs/.json` のみで `.md` は対象外——
  `package.json` の `format:check` スクリプトのグロブで確認した）。

**変異試験（`git checkout` は使わず、`cp` で `examples/chat/README.md` を
`/tmp/readme.orig.md` へ退避してから `cp` で復元）:**

1. 実測結果の表の `japaneseNamesSparse` 行の `hit@1` を `11/12` → `12/12` に書き換え
   → 統合テストが赤くなり、`"japaneseNamesSparse: hit@1がREADME=12/12、基準値=11/12"`
   という具体的な差分メッセージが出ることを確認。
2. `cp /tmp/readme.orig.md examples/chat/README.md` で復元 → 同じ11 tests が
   すべて緑に戻ることを確認（`git status --porcelain` で該当ファイルが
   意図した差分のみであることも確認）。

**最初の実装ミスとその修正過程も記録しておく**（決定3）: 当初 `extractResultsTable`
がREADME全体から最初の `### 実測結果` 見出しを検索したため、`compare` 節の同名見出しを
誤って拾い、実物ファイルに対する統合テストが「実測結果の表に基準値の群の行が無い」
という誤検知で赤くなった。`extractIdentifierProbesSection()` で節をスコープしてから
検索する形に直し、赤→緑を確認した。

---

## 確かめていないこと

- **CI（`.github/workflows/ci.yml` の `typecheck / lint / test / build` ジョブ）で
  この歯が実際に緑になること。** この PR を出した時点では CI が走っていない
  ——ローカルの `npx vitest run`（対象を絞った実行）でのみ確認した。
- **ルートの `pnpm run test`（全体）は実行していない**（指示により、および
  `docs/autonomy.md` の規律により——DB を要する段は別ジョブで見届ける）。
- **`pnpm run typecheck`/`pnpm run build`（全 workspace）は実行していない**
  ——新設した2ファイルは `.mjs` の純関数であり `scripts/` 配下の他のファイルと
  同様に型検査の対象外だが、リポジトリ全体のビルドが壊れていないことは CI が
  確認する。
- **この歯が将来 probe 集合をさらに増やす（例: 6群目を足す）ときに、どこまで
  自動で追従するか。**群一覧表・実測結果の表のどちらにも新しい行があれば
  歯は対応できるが、実際にそのシナリオを試してはいない。
