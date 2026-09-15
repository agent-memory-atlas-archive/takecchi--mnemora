# ADR 0136: 片側だけの `contested`（`contestedWithId=null`）を、読み取り側で単独返却させない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-15

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ／受け取った前提」を混ぜない。

---

## 問い（[Issue #243](https://github.com/takecchi/mnemora/issues/243)）

[ADR 0046](./0046-contested-pair-invariant-tooth.md) が実測したとおり、`MemoryStore.updateStatus(id,
"contested")` を単独で呼ぶと成功し、`contestedWithId` は `null` のまま残る——**片側だけの
`contested`** が既存の公開 interface だけで作れる。[ADR 0134](./0134-mark-contested-explicit-operation.md)
（Issue #197 第1弾）が `Runtime.markContested` を足したが、これは常に両側 `status='active'` の
CAS を課したうえで相互参照を1トランザクションで書くため、**`markContested` 経由ではこの壊れた
状態を作れない。**⟹ 実害が起きるのは、`MemoryStore` を `Runtime` を経由せず直接叩いたときに限る。

**【現物】確認した現状**（`packages/core/src/recall-runtime.ts` を自分で読んで裏取りした）:

- 段1の候補生成の status ゲートは `["active", "contested"]`（`recall-runtime.ts` の ANN/lexical
  両フィルタ）——`contestedWithId` の有無は見ていない。
- 段3の必須同伴取得のフィルタは `c.memory.status === "contested" && c.memory.contestedWithId &&
!presentIds.has(...)` であり、**`contestedWithId` が `null`（falsy）だとこの対象は同伴取得の
  対象にすら入らない。**
- 単位を組む繰り返し（隣接性の不変条件、`docs/memory-model.md` §5 機構3）は、対向が見つからない
  候補を**単独の単位として `units` に積んでいた**——これが最終的な `recall()` の出力に単独の
  `contested` を漏らしていた実体である。
- `packages/core/src/interfaces/memory-store.ts:175` 付近の契約——「`status='contested'` の
  Memory を単独で返してはならない」——と、上記の実装は衝突していた。実際に
  `packages/core/src/__tests__/recall-pipeline.test.ts` の「recall() — 既知の未修復のギャップ:
  片側だけの contested（Issue #243）」が、この壊れた挙動を 🔴 として固定していた
  （ADR 0134 が実装時に書いた歯。本 ADR で修復側に書き換えた）。

issue が提示した2択:

1. **読み取り側の防御** — `recall-runtime.ts` で「`contested` かつ対向が見つからない候補は
   単独では返さず落とす」。
2. **書き込み側の制約** — `MemoryStore.updateStatus`/`updateStatusWithEvent` が `status:
'contested'` を単独で書けないようにする。

---

## 決定1: 案1（読み取り側の防御）を採る。案2は実装せず、提起に留める

**採った理由**:

1. **`docs/recall.md` §8 が既にこの形の答えを定めている。** 「予算(段4)と衝突したときの優先順位:
   同伴を落とすくらいなら本体を落とす…争われている主張を、争われていない顔で出すくらいなら、
   両方とも出さない」。**対向が最初から存在しない（`contestedWithId=null`）ケースは、この原則の
   最も単純な適用先である**——同伴を落とすまでもなく、対向自体が無い。「単独で出すくらいなら、
   何も出さない」と同じ判断を、対向が0件の場合にも一貫させる。
2. **案2は公開 API の破壊的変更になりうる。** `updateStatus(id, "contested")` は今日
   成功しており、これを失敗させる変更は、`docs/autonomy.md` §3「してはいけないこと」表の
   「公開 API の破壊的変更」に該当する——**同§3は「提起までにする。ADR を書き、実装は別 PR に
   して、承認を待つ」と明示している。** ⟹ 本 PR では実装しない（「採らなかった案」参照。
   提起そのものは残す）。
3. **案1は `packages/core` だけで閉じる。** この作業環境には `DATABASE_URL` も docker も無く
   （`AGENTS.md`「いまの状態」節）、`packages/postgres` に触る変更の変異試験は手元で実行できない
   （Issue #247 が住所）。案1は `recall-runtime.ts`（`packages/core`）の変更だけで完結し、
   **in-memory の testkit（`FakeMemoryStore`/`createFakeRuntimeStores`）で変異試験まで手元で
   完結できる。** 案2を選んでいたら、`packages/postgres` の `updateStatus`/`updateStatusWithEvent`
   にも手を入れる必要があり、CAS の破壊的変更を Postgres に対して実測しないまま出すことになった。

## 決定2: 実装は「単位を組む繰り返し」で対向未解決の `contested` を単位に入れないことに限定する。新しい `Omission` は足さない

`packages/core/src/recall-runtime.ts` の隣接性の不変条件（単位を組む繰り返し、
`docs/memory-model.md` §5 機構3）は、`withinLimit` の各候補を順に消費しながら、対向が見つかれば
ペア単位、見つからなければ単独の単位を組んでいた。

**変更**: 候補の `status === "contested"` かつ対向が解決できない（`companion` が `undefined`）場合、
**単位を組まずに `consumed` のまま落とす。**

```ts
} else if (candidate.memory.status === "contested") {
  // 対向が見つからない contested は単位を組まない（単独で返さない）。
} else {
  units.push({ members: [candidate], rankScore: candidate.score.total });
}
```

この候補は `units` に一切現れないため、既存の `unitAssemblyShortfall(units, allCandidates.length)`
（[ADR 0043](./0043-unit-assembly-dropped-omission.md)）が「候補が単位を覆えていない」件数として
**自動的に検出し**、既存の `unit_assembly_dropped` Omission として黙らずに報告される。

**新しい `Omission.kind` を足さなかった理由**: `unit_assembly_dropped` の doc（`recall.ts`）は
既に「一対一が破れていると、候補がどの単位にも入らないまま落ちる」ケース一般を指しており、
`contestedWithId=null`（対向がそもそも無い）は「一対一の対向関係が破れている」の一種——
**壊れ方の形が増えただけで、報告する仕組みは同じでよい。** 新しい札を足すと、「同じ原因・同じ
結果を2つの名前で報告する」という ADR 0011 が避けた形になる。

**この変更が影響しない範囲**: 両側が正しく相互参照を持つ `contested` ペア（`markContested` が
作る形）は、この分岐を一度も通らない——`companion` が解決できる限り、ペアの単位を組む既存の
経路がそのまま使われる。歯（下記）で対照実験として確認した。

## 決定3: 案2（書き込み側の制約）は「採らなかった案」ではなく「提起」として ADR に残す

`docs/autonomy.md` §3.1「技術的に決められるなら決めて、理由を ADR に書く」に従い、**技術的な
選択（読み取り側か書き込み側か）はここで決めた**が、**破壊的変更の実装そのものはオーナーの
承認を要する**（§3）。

案2を実装するなら次が必要になる、という設計メモ（実装はしていない）:

- `updateStatus`/`updateStatusWithEvent` が `status: 'contested'` を対象にした呼び出しを拒否する
  （`contestedWithId` を渡す引数がそもそも無いため、「単独で `contested` にする」呼び出しは
  常に拒否対象になる）。
- 影響範囲: `@mnemora/core` は npm に公開済み（`docs/autonomy.md`）。**第三者 adapter や、
  この2メソッドを直接叩いている呼び出し側コードが今日この呼び出し方に依存していれば壊れる。**
  ADR 0046 の実測では、リポジトリ内に `UPDATE ... SET status='contested'` を伴う本番の呼び出し元は
  無かった（`Runtime` はこの形で呼ばない）が、**第三者コードの利用実態までは確認できない。**
- 案2を採るなら、影響評価と移行方針（例: 次のメジャー版まで警告のみ・現行版では例外化する等）を
  別 ADR として先に立てるべきである。

**⟹ 本 PR はこの設計メモを残すに留め、実装はしない。マネージャーへの報告に明記する。**

---

## 採らなかった案

### 案2そのもの（書き込み側の制約。今回は実装しない）

決定3参照。破壊的変更であり、`docs/autonomy.md` §3 により提起までに留める。

### 対向未解決の `contested` を、専用の新しい `Omission.kind`（例: `contested_without_companion`）で報告する

決定2参照。`unit_assembly_dropped` が既に同じ形（一対一の破れによる単位からの脱落）を報告する
仕組みを持っており、新しい札を増やすと同じ現象を2つの名前で報告することになる。

### 対向未解決の `contested` を、単独のまま `retrievedVia` に印だけ付けて返す

`docs/recall.md` §8 が既に検討し、Phase 1 の既定として却下した案（「その対のペアの片方だけを
『争われている』という印を付けて残す設計も選択肢としてあり得るが、Phase 1 の既定は『両方落とす』
とし…」）と同じ形であり、対向が0件のケースでも同じ理由（争われている主張を争われていない顔で
出す事故を避ける）でこの案を採らない。

---

## 引き受けた負債

- **`contestedWithId` が指す先が存在しない（dangling）場合の扱いは、この PR では区別して測って
  いない。** 決定2の実装は `companion` が解決できない場合を一律に「対向未解決」として扱うため、
  `contestedWithId=null` と「`contestedWithId` はあるが `getMany` が返さなかった」の両方が同じ
  経路で落ちる。後者は Postgres では外部キーにより起こり得ない（ADR 0046 実測）が、
  `InMemoryMemoryStore`/`FakeMemoryStore` は参照整合性を検査しないため、**理論上は作れる。**
  本 PR ではこの区別を歯にしていない——どちらも「単独で出さない」という結論は変わらないため、
  実害は無いと判断したが、**確かめてはいない。**
- **`packages/postgres` には触れていない。** 案1は `packages/core` の recall パイプラインの
  問題であり、`PostgresMemoryStore` 自体は既に `contestedWithId` をそのまま返しているだけで
  変更不要と判断した——ただし、この判断を Postgres に対して実測してはいない（DB 環境が無い、
  「確かめていないこと」参照）。

## これが覆るとしたら

- **オーナーが案2（書き込み側の制約）の実装を承認したとき**——決定3の設計メモを土台に、
  影響評価と移行方針を書いた別 ADR を立てる。
- **`contestedWithId` が指す先の dangling を、`InMemoryMemoryStore`/`FakeMemoryStore` が
  検査するようになったとき**——「引き受けた負債」の区別が要らなくなる、あるいは別の形で
  可視化する余地が生まれる。

---

## 北極星の問いに当てた結果

### 問1: 毎回渡す量を減らす方向に働くか

**間接的に減らす。** 争われている主張を、対向無しに単独の顔で見せていたケースが無くなる——
下流（LLM アプリケーション）が誤って「争われていない事実」として1件だけ受け取るリスクを塞ぐ。
量そのもの（文字数）への影響は、対向未解決の `contested` が実際にどれだけ recall に混入して
いたか次第であり、**今日この状態は `Runtime` からは作れないため、Phase 1 の通常運用では
0件である**（負債・確かめていないこと参照）。

### 問2: 無効にしても Memory Framework として成立するか

**成立する。** この変更は「壊れたデータが来たときの防御」であり、正しいデータ（`markContested`
が作るペア、または `contested` を一度も使わない運用）には一切影響しない。歯の対照実験
（下記）で確認した。

### 問3: この記憶が選ばれた理由を、後から説明できるか

**維持される。** 対向未解決の `contested` が落ちたことは `omitted`（`unit_assembly_dropped`）
に現れる——黙って消えない。ただし、この Omission は「対向が無いから」なのか「一対一が別の形で
破れたから」なのかを区別しない（決定2で意図的に統合した）。**個別の原因まで知りたい場合は
`recall()` の trace だけでは足りず、`MemoryStore` を直接調べる必要がある**——これは
`unit_assembly_dropped` が元々持っていた粒度であり、本 PR で悪化させても改善してもいない。

### 問4: AI の推論と、ユーザーが言った事実を区別しているか

**影響なし。** この変更は `status`/`contestedWithId` だけを見て判断し、`provenance.kind` を
一切参照しない。

### 問5: LLM を呼ばずに済ませられないか

**済ませられる。** この変更は列（`status`/`contestedWithId`）の比較だけで完結する。

---

## 測ったこと

- **出所: 私が実行した。** `packages/core`: `pnpm run typecheck` 緑、`pnpm run test`
  （`vitest run`）623 tests 緑（既存622 + 新規/書き換え後の歯）。
- **歯を変異試験で確認した**（`git checkout` は使わず、`/tmp` への退避コピーから戻した）:
  1. 修正前のコード（`recall-runtime.ts` の新しい分岐を外した状態）で
     `pnpm --filter @mnemora/core run test` を実行 → 新しい歯
     「🔴 contestedWithId が null の contested Memory は recall() に単独で出ない」が
     **実際に落ちる**（`expected [ 'mem-102' ] to not include 'mem-102'`）ことを確認した。
  2. 修正を復元して同じコマンドを再実行 → 623 tests 全緑に戻ることを確認した。
  3. 対照実験（正しく相互参照が張られた `contested` ペアは両方とも出る）が、変異前後どちらでも
     緑であることを確認した——この歯が「`contested` を丸ごと消す」過剰反応になっていないことの
     裏付け。
- **リポジトリ全体の6つの門**を手元で実行した:
  - `pnpm run typecheck` — 全7 workspace projects 緑。
  - `pnpm run lint`（eslint） — 緑（警告・エラー無し）。
  - `pnpm run format:check`（prettier） — 緑。
  - `pnpm run test` — ルート 928 tests 緑 + 各 package 緑。**DB テストは実行していない**
    （`DATABASE_URL` 未設定。「実行していません」と明示的に告知されることを確認した。
    `AGENTS.md`/ADR 0015 の通り、これは「DB 側を見ていない」であって「全部通った」ではない）。
  - `rm -rf packages/*/dist && pnpm run build` — 全7 projects 緑。
  - `pnpm run pack:check` — 緑（6パッケージとも publish 梱包の検査を通過）。

## 確かめていないこと

- **`packages/postgres` に対する実測。** この作業環境には `DATABASE_URL` も docker も無く、
  `PostgresMemoryStore`/CI の `postgres` conformance ジョブに対しては何も実行していない。
  ただし本 PR は `packages/postgres` のコードを変更していない——**変更対象
  （`recall-runtime.ts`）は `packages/core` に閉じており、CI の `postgres` ジョブが赤くなる
  経路がそもそも無いと判断しているが、この判断自体を CI の実行結果で裏取りしてはいない。**
- **dangling な `contestedWithId`（参照先が存在しない）が実際に recall に混入したときの
  挙動を、専用の歯では確認していない。**「引き受けた負債」参照。同じコードパスを通るため
  理論上は同じ結果になるはずだが、専用のテストケースは書いていない。
- **案2（書き込み側の制約）を実装した場合の、第三者 adapter・呼び出し側への実際の影響。**
  提起に留めており、実装も影響調査も行っていない。
