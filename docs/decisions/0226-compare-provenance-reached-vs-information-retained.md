# ADR 0226: `compare` の `factStatementSurvived` が測るのは出典到達だけである — 欄名は⭐門の契約として据え置き、意味の是正はコメント・表示・文書で行う（Issue #496）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0088 / ADR 0133 / ADR 0146 の体裁を踏む）。

- **【実測】** — この ADR の作業者が自分の手で読み・走らせて確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 委譲文として受け取り、この ADR の作業者が再導出していない。

---

## 文脈

**Issue #496**: `examples/chat/src/provenance-trace.ts` は `sourceObservationId` を辿って
`Observation.externalId` に一致するかどうかだけを判定する（ADR 0052）。`compare.ts` は
この判定を `factStatementSurvived` という名前の関数・欄として表示・JSON 化する。

【現物】この判定は `Memory.digest` を一切読まない。要約が答えの情報を落としていても、
`sourceObservationId` が同じ Observation を指していれば true になる。⟹ **この判定が
証明するのは出典への到達だけであり、「情報が残った」「全文なしで答えられた」ことの
証明ではない。**`docs/autonomy.md` §2.2 の2番（[ADR 0224](./0224-quality-evaluation-and-acceptance-criteria.md)）が、
まさにこの区別（出典到達・情報保持・最終回答の正しさ）を明示的に求めている。

【現物】`compare.ts` の `ComparisonRow.factStatementSurvived` の docstring には、この ADR の
作業時点で次の逐語が残っていた:

> このシナリオと擬似 provider に固有の近似判定であり、一般的な判定ではない。

これは二重に陳腐化していた:

1. `provenance-trace.ts` の判定は **provider が擬似か本物かに依らない**（同ファイルの
   `resultContainsObservation` の docstring、【現物】）。
2. `compare` は [ADR 0133](./0133-compare-baseline-and-gate.md) により `recorded`
   （記録した実 API 応答の再生）で走る。「擬似だから質を主張しない」という理由自体は
   [ADR 0146](./0146-compare-quality-claim-reason-replaced.md) が「正解集合を持たない
   器だから」へ差し替えている。

## 何が公開契約になっているか（【現物】、改名を難しくしている理由）

- `examples/chat/src/compare-json.ts` の `CompareRowJson.factStatementSurvived`
  （`schemaVersion: 1`）——`buildCompareJson` が `ComparisonRow.factStatementSurvived` を
  そのまま写す、公開 JSON のキーである。
- `examples/chat/compare-baseline.json`（⭐門、ADR 0133）——全12行が `factStatementSurvived`
  というキーを持つ。この ADR は本文にも `_readme` にも触れていない（Issue #499 の領域、
  下記「範囲外」参照）。
- `scripts/compare-summary-lib.mjs` の `computeComparison`/`evaluateCompare`——基準値との
  比較で `factStatementSurvived` の `true → false` 退行を⭐門の判定条件の1つにしている
  （ADR 0133 決定3、[ADR 0222](./0222-compare-gate-judges-only-when-turncount-sets-match.md)
  が判定を3値化した後も同じ欄名を使い続けている）。
- `scripts/__tests__/compare-summary-lib.test.mjs` / `compare-summary.test.mjs`——
  文字列 `"factStatementSurvived"` を直接アサートしている。

## 決めたこと

### 決定1: 欄名（`factStatementSurvived`）は改名しない。⭐門・基準値・検査の契約として据え置く

上記「何が公開契約になっているか」の4点はすべて、この名前をキー・文字列として直接
参照している。改名すると `schemaVersion` を上げるか、⭐門・基準値・検査を同時に
書き換える必要が生じる——これは Issue #496 の完了条件2「単なる改名のために既存契約や
検査を黙って破壊しない」に直接抵触する。

### 決定2: 意味のずれは、改名ではなくコメント・表示・利用者向け文書で是正する

- `provenance-trace.ts` の `resolveExternalId`/`resultContainsObservation` の docstring に、
  「出典到達だけを証明する。情報保持・最終回答の正誤は証明しない」を明示した。
- `compare.ts` のローカル関数名を `factStatementSurvived` → `factStatementSourceReached`
  へ変えた（**この関数は export されておらず compare.ts 内に閉じているため、公開契約には
  当たらない**——【実測】`grep -rn "factStatementSurvived" examples/chat/src/` で
  export 元が `ComparisonRow`/`CompareRowJson` の型の欄名だけであることを確認した）。
  `ComparisonRow.factStatementSurvived`（欄名）は変えていない。
- `ComparisonRow.factStatementSurvived` の docstring から、陳腐化した「このシナリオと
  擬似 provider に固有の近似判定」という記述を削り、出典到達だけを測ること・欄名を
  据え置いた理由（この ADR）を書いた。
- 表示 `formatRecallQualityTable` のヘッダ「冒頭の事実が残っているか」を「冒頭の事実の
  出典に到達したか」へ変えた。**JSON のキー名ではなく、Markdown 表の見出し文字列であり、
  `examples/chat/src/__tests__/format.test.ts` はこの文字列をアサートしていない**
  （【実測】該当テストはセル値をパイプ区切りで比較しており、ヘッダ文字列そのものへの
  アサーションは無い）——品質の合格基準は1つも変えていない、表示文言の追従である。
- `cli.ts` の `compare` サブコマンドの案内文（コンソール出力）も同じ理由で
  「削っても冒頭の事実の出典に到達できるか」へ変え、「情報保持・最終回答の正誤は
  測っていない」を明示的に添えた。
- `compare-json.ts` の `CompareRowJson.factStatementSurvived` に docstring を足した
  （キー名・型は変えていない）。
- `examples/chat/README.md` の該当節（「⭐ 削減率だけでは意味を持たない」節、
  `factStatementSurvived`/「冒頭の事実が残っているか」を説明する箇所）に、この repo の
  既存の作法（取り消し線・日付付き追記の積層。Issue #248/#263 の追記と同じ体裁）で
  追記を足した。**過去の実測を写した表・当時の本文は書き換えていない**——追記のみ。

### 決定3: 検査を1本足す。文言修正には不要な検査を増やさない

`examples/chat/src/__tests__/provenance-trace.test.ts` を新設した。`resultContainsObservation`
に対し、(a) 答えの情報を欠く digest でも同じ出典なら true になること、(b) 陽性対照として
答えをそのまま含む digest でも結果が変わらず true であること（＝判定が digest を見ていない
ことの裏付け）、(c) 陰性対照として別の出典なら false になること、の3つを1つの検査の中で
並べた。(b)/(c) が無いと「true が出た」だけでは、この探り棒が実際に何を区別しているのかが
分からない（`docs/autonomy.md` §2.2 の3番）。

**これ以上の検査は増やしていない**（Issue #496 完了条件3「文言だけの修正に不要なテストは
増やさない」）——`compare.ts`/`compare-json.ts`/README のコメント・表示・文書の変更は、
振る舞いを一切変えていない文言修正であり、既存の `format.test.ts`/`compare-json.test.ts`
がそのまま検査し続ける。

## 採らなかった案

- **⛔ `schemaVersion` を 2 に上げてキーを改名する。** 却下。⭐門
  （`compare-baseline.json`、ADR 0133）・`scripts/compare-summary-lib.mjs`・
  `scripts/__tests__/*` を同時に動かすことになり、Issue #496 完了条件2 が禁じる
  「単なる改名のための契約破壊」に当たる。意味のずれは改名しなくてもコメント・表示・
  文書で消える。
- **⛔ 情報保持を測る新しい欄を `ComparisonRow`/`CompareRowJson` に足す。** 却下（今回は）。
  [ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定8
  （「区別を足すかどうかは、その区別があると呼び出し側の次の一手が変わるか」）に当てると、
  **測る手段を持たないまま欄だけ足しても次の一手は変わらない**。`compare` の
  `scenario.ts`/`FACT_STATEMENT` は単一の事実の有無しか判定できず（ADR 0146）、
  情報保持や最終回答の品質を測るには別の器（全文経路と記憶経路を同一の会話・質問・
  採点基準で比較する）が要る——これは最終回答品質の評価を扱う Issue #498 の領域であり、
  この ADR の範囲を超える。
- **⛔ `factStatementSurvived` を `compare.ts` のローカル関数名も含めて一切変えない。**
  却下。ローカル関数名（export されていない）まで公開契約として凍結する理由は無く、
  意味とずれた名前をコード内に残すと、次にこの関数を読む人が同じ誤読をする
  （`docs/autonomy.md` §2.2 節末尾「コードのコメントは現在の契約と必要な理由を持つ」）。
- **⛔ ADR 0022 / 0052 / 0133 / 0146 / 0224 の本文を、この差し替えに合わせて書き換える。**
  却下。このリポジトリは採用済み ADR の本文を書き換えない規律を持つ（ADR 0223 決定1）。
  この ADR は参照するだけで、それらの本文には1バイトも触れていない。

## 引き受けた負債

1. **欄名と意味のずれ自体は残る。**`factStatementSurvived` という名前は今後も「生存」を
   連想させ、コメント・表示・文書を読まずに欄名だけを見た呼び出し側は誤読しうる。
   この ADR が対処したのは「読めば分かる」ところまでであり、名前そのものの誤解を
   構造的に消してはいない。
2. **情報保持・最終回答の正しさを測る評価は、この PR の後もまだ存在しない。**
   `compare` はこれまでどおり出典到達と量の削減率しか測らない。Issue #498 が
   その領域を追う。
3. **README の追記は、この ADR が「現在の使い方の説明」と判断した1箇所にのみ置いた。**
   同じ概念（`factStatementSurvived`/「冒頭の事実が…」）は README の複数箇所
   （読み方2 等）にも登場するが、それらは特定時点の実測記録であり、Issue #496 の
   「過去の実測を写した表や当時の主張の本文を書き換えない」という制約と、
   「README 全体の文書監査はしない」という範囲限定（Issue #425/#471 と分ける）に
   従い、そこへは追記していない。**この判断が誤りで、読者が誤読する実害が出たら、
   このリストに追記が要る箇所として足す必要がある。**

## これが覆るとしたら

- **`compare` に正解集合を持つ情報保持の評価器が実際に足されたとき**（Issue #498 の
  結果）。そのとき `ComparisonRow`/`CompareRowJson` に新しい欄を足す判断が改めて要り、
  「採らなかった案」の2番目を再検討できる。
- **`factStatementSurvived` という名前そのものが実害（誤読による事故）を起こしたとき。**
  そのとき初めて「決定1」（改名しない）を再検討する根拠ができる——現時点では、
  この ADR のコメント・表示・文書の是正で足りると判断した。

## 確かめていないこと

- **README の他の箇所（読み方2・読み方3 付近の `factStatementSurvived` への言及）に、
  この ADR の追記と同内容を足すべきかどうか**は、この ADR の作業では判断を1箇所に
  絞った（上記「引き受けた負債」3）。全体の要否は確かめていない。
- **この是正が、実際に呼び出し側（`compare` の出力を読む人）の誤読を防げているか**は、
  この ADR の作業では検証していない（読む人を使った検証は行っていない）。
- **DB を要する検査**（`examples/chat` の postgres 系テスト・`compare` 本体の実行）は、
  この作業環境に `DATABASE_URL` が無いため実行していない。PR 本文参照。
- **「何が公開契約になっているか」節が指す `scripts/compare-summary-lib.mjs` の関数名
  （`computeComparison`/`evaluateCompare`）は、この ADR を着地させる時点の現物
  （`grep -n "^export function" scripts/compare-summary-lib.mjs`）で確認したが、⭐門の
  実際の終了コードの挙動（pass→0/fail→1/indeterminate→2、ADR 0222 決定5）は、この
  作業環境に `DATABASE_URL` が無いため実際には走らせていない。**

## 人から受け取った前提（出所付き）

- **本 ADR が採る方針（欄名を据え置く・意味の是正はコメント/表示/文書で行う・採らなかった
  案の骨子）は、マネージャーからの委譲文として受け取った。**この ADR の作業者が独自に
  導出したものではない。
- Issue #496 の本文——`gh issue view 496` で直接読んだ【現物】。
- ADR 0052 / 0133 / 0146 / 0224 / 0223 の内容——`docs/decisions/` から直接読んだ【現物】。
- `compare.ts`/`compare-json.ts`/`provenance-trace.ts`/README の該当節の現状——
  この ADR の作業者が実際に読んで確認した【現物】。
