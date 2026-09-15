# ADR 0140: `MemoryStore` の書き込み側で、対向（`contestedWithId`）の無い単独 `contested` を拒否する — ADR 0136 決定3の実装（生成経路も含む）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-15

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ／受け取った前提」を混ぜない。

---

## 結論

**[ADR 0136](./0136-contested-lone-dropped-not-returned-alone.md) 決定3が「提起」に留めていた案2（書き込み側の制約）を、本 PR で実装する。**
`MemoryStore.updateStatus` / `updateStatusWithEvent` は `status: 'contested'` を対象にした
呼び出しを常に拒否し、`createMemory` / `createMemoryWithOutbox` /
`supersedeWithNewMemories`（`news` 側）は `status: 'contested'` かつ `contestedWithId` が
`null`/`undefined` の入力を拒否する。**`status: 'contested'` を正しく書く唯一の口は
`markContestedPair`（[ADR 0134](./0134-mark-contested-explicit-operation.md)）になる。**

**この実装の射程は ADR 0136 決定3が明示した2メソッドだけでなく、`createMemory` 系
（生成の経路）にも及ぶ。** 理由はマネージャーの指摘のとおりである——更新だけ締めて
生成が開いていると、「いま誰も `createMemory` でその形を作っていないから安全」が残る。
**「いま守られている」と「守る設計になっている」は別であり、偶然に依存した安全は、
依存していることに誰も気づかないまま消える。**

**壊れる人がどれだけ居るか（本リポジトリ内で実際に数えた件数）と、「外部の利用実態は
確認できない」は別の主張であり、下の「誰が壊れうるか」で段落を分けて書く。**

---

## §3 の手続きについて（オーナーの決定の記録）

`docs/autonomy.md` §3 の⛔表は「公開 API の破壊的変更」を「`0.x` なので semver 上は
許されるが、提起までにする。ADR を書き、実装は別 PR にして、承認を待つ」と定めている。
本 ADR が実装する変更（`updateStatus`/`updateStatusWithEvent` が `'contested'` を常に拒否、
`createMemory` 系が対向無しの `'contested'` を拒否）はこの条項に該当する。

作業の過程で次の経緯があった（**マネージャー経由で受領した報告であり、書き手が
オーナー本人に直接確認したものではない**）:

1. 当初、マネージャーから「上位（クローン）が実装まで進めてよいと判断した」との指示を
   受けた。根拠として「本番での該当呼び出しが0件・第三者実装の証拠なし」という測定が
   添えられていた。
2. その後、マネージャーから訂正が入った——**この測定は費用の見積もりであって、§3 が
   要求する承認の代わりにはならない。**「外部実装者の証拠が無い」は「居ない」ではない。
3. 続けて、**オーナー本人の回答**が(マネージャー経由で)届いた。逐語:

   > **Aでお願いします。**
   > **ほとんど使われていない(v0.X.X)の段階なので破壊的変更であっても構わず実装してください**

   ⟹ §3 の「公開 API の破壊的変更は提起までにする」条項は、**この件については解けた。**
   これとは別に、「CI が緑になればマージしてよいか」という先行の問いへの回答は
   §3 の「PR のマージはオーナー専権」条項についてのものであり、上の破壊的変更の
   承認とは別の問いに対する別の回答である——**一方の回答をもう一方の許可として
   読まない。**

**⟹ 本 PR は ADR と実装を同一 PR に含める。マージの実行は担い手ではなくマネージャーが行う
（この決定は「§3 の破壊的変更条項」にだけ効くものであり、「担い手が PR をマージしてよい」
という話には広がっていない）。**

**「気にせず実装してよい」は「記録しなくてよい」ではない。** いまの判断は
「壊れる人がまだ居ないから安い」であって「壊してよい」ではない。`v0.x` は永遠には
続かず、`1.0` が近づいたとき「どこを壊してきたか」の記録が移行の資料になる。
記録が無ければ、そのとき誰も追えない。以下の「誰が壊れうるか」「移行の道」は、
その記録として書く。

---

## 問い（[Issue #243](https://github.com/takecchi/mnemora/issues/243) 続き）

ADR 0136 決定3が残した設計メモ:

> - `updateStatus`/`updateStatusWithEvent` が `status: 'contested'` を対象にした呼び出しを
>   拒否する（`contestedWithId` を渡す引数がそもそも無いため、「単独で `contested` にする」
>   呼び出しは常に拒否対象になる）
> - 案2を採るなら、影響評価と移行方針を別 ADR として先に立てるべきである

**本 ADR がこれに足すこと**: `createMemory` 系（`createMemory` / `createMemoryWithOutbox` /
`supersedeWithNewMemories` の `news` 側）も同じ形で締める。`NewMemory` は
`status`/`contestedWithId` を任意項目として持つため（`packages/core/src/memory.ts`）、
これらの入口から `status: 'contested'`・`contestedWithId: null`（または省略）の
Memory を作ることは、今日も公開 interface だけで可能である
（[ADR 0046](./0046-contested-pair-invariant-tooth.md) が実測した表の #1〜#4）。

---

## `MemoryStore` interface の実際の入口を数え上げた

**出所: 私が実行した**（`packages/core/src/interfaces/memory-store.ts` を自分で読んだ。
`git grep` で `status`/`contestedWithId` を書ける口を数え直した）。

`status: 'contested'` を書ける、または `contestedWithId` を書ける公開メソッドは次の6個
だけである:

| # | メソッド | `status: 'contested'` を書けるか | `contestedWithId` を書けるか |
|---|---|---|---|
| 1 | `createMemory` | 書ける（`NewMemory.status` 任意項目） | 書ける（`NewMemory.contestedWithId` 任意項目） |
| 2 | `createMemoryWithOutbox` | 同上 | 同上 |
| 3 | `supersedeWithNewMemories?`（`news[].input`） | 同上（`NewMemory` をそのまま使う） | 同上 |
| 4 | `updateStatus` | 書ける（`status` 引数） | **引数が無い**（`opts` は `supersededById`/`expectedStatus` のみ） |
| 5 | `updateStatusWithEvent` | 同上 | 同上（引数が無い） |
| 6 | `markContestedPair?` | 書ける（内部で固定的に両側へ設定） | 書ける（内部で相互に設定。CAS が `status==='active'` を要求し、両側原子的） |

**4・5 は `contestedWithId` を渡す引数がそもそも無いため、この2つが `status: 'contested'`
を書く呼び出しは、区別の余地なく常に「単独」である。** 1・2・3 は `contestedWithId` を
渡せるため、`null`/`undefined` のときにだけ「単独」と判定する——対向を明示した作成
（既存 Memory を指す `contestedWithId` 付き）は本 ADR でも塞がない（下記「開いている穴」
参照）。6 は ADR 0134 が導入した、両側 CAS・相互参照・同一トランザクションの専用口であり、
本 ADR の制約を一切受けない（この口だけが、これからも `status: 'contested'` を正しく
作れる）。

---

## 誰が壊れうるか

### 本リポジトリ内で実際に数えた件数（私が実行した）

`git grep` で「単独の `contested` 書き込み」に該当する呼び出しを、production（`__tests__`
以外の `src`）とテストに分けて数えた。

**production コード（`packages/*/src`、`__tests__` を除く）**:

```
grep -rn "status:\s*[\"']contested[\"']" --include=*.ts packages/*/src examples/*/src \
  | grep -v "/__tests__/\|\.test\.ts\|memory-store-conformance.ts"
grep -rn "updateStatus(.*contested\|updateStatusWithEvent(.*contested" --include=*.ts .
```

- `status: 'contested'` を書く production コードは **0件**。
- `updateStatus`/`updateStatusWithEvent` を `"contested"` で呼ぶ production コードも **0件**
  （ヒットしたのはすべてコメント・doc コメントであり、実際の呼び出しではない）。
- `Runtime` 自身も `contested` を書かない（ADR 0046 が実測済み。`markContested` の CAS
  経路を除く）。

**テストコード**（この PR で修正する前の時点、旧 main の状態）:

| 経路 | 箇所 | 使っている store |
|---|---|---|
| `updateStatus(ctx, id, "contested")` | `packages/core/src/__tests__/runtime.test.ts:1137` | `FakeMemoryStore`（1件） |
| `createMemory`/fixture ヘルパで `status: "contested"` かつ `contestedWithId` 無し | `packages/core/src/__tests__/recall-pipeline.test.ts` の6箇所（432, 469, 510, 699, 752, 850行——いずれも ADR 0136 自身が読み取り側の防御を検査するために作った「壊れた」fixture） | `FakeMemoryStore`（6件） |
| 同上 | `packages/testkit/src/memory-store-conformance.ts` の4箇所（`aggregateScope`/`archiveDecayed`/`purgeMemory`/`markContestedPair` の各歯が、主題と無関係に `status: "contested"` の fixture を添え物として使っていた） | `PostgresMemoryStore` **と** `InMemoryMemoryStore` 双方に対して実行される共有適合スイート（4件） |
| 同上 | `packages/postgres/src/__tests__/recall.postgres.test.ts:445` | `PostgresMemoryStore`（1件） |
| 同上 | `packages/postgres/src/__tests__/recall-gate-index.test.ts` の `insertManyMemories`（4000行中、5分の1が `status: "contested"`） | `PostgresMemoryStore`（1件。**手元の grep では見つけられず、CI の DB ジョブが実際に落ちて初めて見つかった**——下の「CI で見つかった、手元では見つけきれなかった影響」参照） |

**ベンチ**（`packages/postgres/src/bench/scale-bench.ts:388`）は `INSERT INTO memories (...)`
を生 SQL で直接発行しており、**`MemoryStore` の公開メソッドを一切経由しない**——本 ADR の
制約はこのベンチに構造的に及ばない（そもそも対象外）。

**⟹ 実際に壊れたのは4本の共有適合テスト（Postgres・InMemory 双方）・1本の Postgres 統合
テスト・1本の Postgres 索引テストであり、いずれも本 PR で修正済みである（下記「測ったこと」
参照）。`FakeMemoryStore` を使う7件は無傷のまま残る（下記「決定」参照——`FakeMemoryStore`
は本 ADR の対象外）。**

### 外部の利用実態（別段落・未検証であることを明記する）

**上の件数は、あくまで本リポジトリの中で私が数えたものである。** `@mnemora/core` /
`@mnemora/postgres` / `@mnemora/testkit` は npm に公開済みであり（`docs/autonomy.md`
「いまの状態」）、**この3パッケージを消費する外部のコードが、`updateStatus(id,
"contested")` や `createMemory({ status: "contested" })` を直接呼んでいる可能性を、
本リポジトリから確認する手段は無い。** 「見つからなかった」は「居ない」の証拠ではない
——この点は測定ではなく、確認できないことの明記である。

---

## 決定1: 案2（書き込み側の制約）を実装する。射程は `createMemory` 系まで広げる

決定の中身は上の「結論」節に書いたとおり。判定関数 `isContestedWithoutCompanion(status,
contestedWithId)` を `packages/core/src/interfaces/memory-store.ts` に1つだけ置き、
`packages/postgres`（`PostgresMemoryStore`）・`packages/testkit`
（`InMemoryMemoryStore`）の両実装がこれを呼ぶ。専用の例外型
`ContestedWithoutCompanionError` を新設し、`instanceof` で判別できるようにする
（`MemoryStatusConflictError`/`MemoryPurgeConflictError` と同じ形）。

## 決定2: `FakeMemoryStore`（`packages/core/src/__tests__/runtime-fakes.ts`）は本ガードの対象外とする

**理由**: `FakeMemoryStore` は `@mnemora/core` から export されず、npm にも公開されない
——`packages/core/src/__tests__/` 配下にのみ存在する、`packages/core` 自身の単体テスト用の
私的なテストダブルである。**ADR 0136 自身の読み取り側の防御（`recall-runtime.ts` の
「対向未解決の `contested` は単位を組まない」分岐）の回帰テストは、まさに本 ADR が
塞ごうとしている壊れた状態（`contestedWithId` 無しの `contested`）を `FakeMemoryStore`
経由で構成できることに依存している**（`recall-pipeline.test.ts` の `seedBrokenChain`
等、6箇所）。ここにも同じガードを課すと、ADR 0136 の回帰カバレッジを失うか、
`FakeMemoryStore` に「検査を経由しない seed 専用の裏口」を新設する必要が生じる——
後者は「テストダブルが実装契約に違反した状態を意図的に作れる」という同じ性質を
別の形で持ち込むだけであり、複雑さに見合わないと判断した。

**⟹ この判断が生む「開いている穴」は次節で明記する。**

## 決定3: 移行方針は「段階的な警告」を置かず、現行 `0.x` 系で即座に例外化する

ADR 0136 決定3は移行方針の例として「次のメジャー版まで警告のみ・現行版では例外化する」を
挙げていたが、**本 ADR は即座の例外化を採る。**

**理由**:

1. **`0.x` は semver 上、破壊的変更を許容する**（`docs/autonomy.md` §3 の前提そのもの）。
   段階的な警告は `1.0` 以降の semver 契約に対する礼儀であって、`0.x` の間の必須事項
   ではない。
2. **これは他の不変条件の締め方と同じ形である。** CAS（`updateStatus` の
   `expectedStatus`、ADR 0030）・参照整合性相当（`contestedWithId`/`supersededById`
   の存在検査、ADR 0047）・値域（`strength`/`halfLifeHours`、ADR 0078/0125）は、
   いずれも「壊れたデータ状態を作らせない」ための締め付けであり、**このリポジトリでは
   段階的な警告を経ずに即座に例外化されてきた。** 今回だけ警告期間を挟むと、
   同種の変更の間で扱いが割れる。
3. **本リポジトリ内で数えた影響は、production コードに対しては0件だった**（上記
   「誰が壊れうるか」）。
4. **外部の利用実態は不明である**（上記、別段落で明記）。**この不明であることを、
   「即座に例外化してよい」の理由には使わない**——理由は 1・2・3 であり、4 は
   単に「読者が誤って"安全だから即座でよい"と早合点しないための注記」である。
   もし外部に依存者がいた場合の安全弁は、**サイレントな壊れ方ではなく、型で
   `instanceof` 判別できる専用の例外を投げること**そのものである——呼び出し元は
   黙って壊れたデータを書き込む代わりに、その場で分かる失敗を受け取る。
5. **オーナー本人が、この具体的な変更について「破壊的変更であっても構わず実装して
   よい」と判断した**（上の「§3 の手続きについて」参照）。これは 1〜4 の代わりでは
   なく、1〜4 を前提として実装まで進めてよいという追加の許可である。

---

## 開いている穴（塞げなかった・塞がなかった入口を明記する）

1. **`FakeMemoryStore` は無傷。** `packages/core` の単体テストがこのクラスを直接
   インスタンス化して使う限り、`status: 'contested'` を対向無しで書くことは
   引き続き可能である（決定2）。**これは非公開のテストダブルに限られる**——
   `@mnemora/core` の公開 API（`FakeMemoryStore` を export していない）を消費する
   側からは到達できない。
2. **対向を明示した、しかし一方向的な `contested` 作成は塞いでいない。** `createMemory`
   に `status: 'contested'`・`contestedWithId: <既存 Memory の id>` を渡す呼び出しは、
   本 ADR の後も成功する。これは相互ペアを構成しない（ADR 0046「一対一が要求する状態を、
   今日どの経路でも作れない」がそのまま残る）——**本 ADR が閉じるのは「対向が一切無い」
   状態だけであり、「対向はあるが一方向」の状態は ADR 0136/0046 が既に引き受けた負債の
   ままである。**
3. **サードパーティの `MemoryStore` 実装には、型システム上の強制力が無い。** 本 ADR の
   ガードは `PostgresMemoryStore`/`InMemoryMemoryStore` という具体的な実装クラスの
   コードに書かれた振る舞いであり、`MemoryStore` interface 自体は TypeScript の
   型としてこの制約を強制できない（メソッドの中身の振る舞いは型に現れない）。
   独自に `MemoryStore` を実装する第三者が、この ADR のドキュメントを読まずに
   ガードを実装しなければ、その実装では引き続き単独の `contested` を書ける。
   **これはこのリポジトリの他の「契約」（例: 同一トランザクションで書くこと）と
   同じ限界であり、本 ADR が新しく生む穴ではない。**
4. **`markContestedPair` は任意メソッドである**（ADR 0134）。これを実装しない adapter
   は、正しい相互ペアを作る手段を持たない——ただし対向を明示した一方向的な `contested`
   （上記2）は引き続き作れるため、「一切 `contested` を作れなくなる」わけではない。

---

## 採らなかった案

### 段階的な警告（次のメジャー版まで warn のみ、現行版では黙って通す）

決定3参照。`0.x` の間は即座の例外化が一貫しており、オーナーもこの具体的な変更について
即座の実装を承認した。

### `createMemory` 系で「対向を明示しない `contested`」も含め、`contested` の作成そのものを
### `markContestedPair` 経由に完全に一本化する

対向を明示した一方向的な作成（開いている穴2）まで塞ぐ案。ADR 0136 決定3・本 ADR の
問いは「単独（対向が一切無い）」を締めることであり、「対向はあるが一方向」を締める
ことは射程外——射程を広げると ADR 0046 が引き受けた別の負債（一対一の相互性）にまで
踏み込むことになり、1 PR = 1 ADR の原則（`docs/autonomy.md` §2）を超える。

### `FakeMemoryStore` にも同じガードを課す

決定2参照。ADR 0136 の回帰テストの書き直し（`seedBrokenChain` 等の裏口が要る）という
コストに見合わないと判断した。

---

## これが覆るとしたら

- **`createMemory` 系で真の相互ペアを1回の呼び出しで構成できるようになったとき**
  （現状 ADR 0046 により不可能——対向先は作成時に既に存在していなければならない）。
  ⟹ 開いている穴2が別の形で塞げるかもしれない。
- **`FakeMemoryStore` にもガードが必要だと判断されたとき**——ADR 0136 の回帰テストを
  裏口経由で書き直す必要がある。
- **オーナーが「即座の例外化」ではなく「段階的な警告」を望むと後から判断したとき**——
  本 ADR の決定3を差し替える別 ADR が要る。

---

## 北極星の問いに当てた結果

ADR 0136 と同じ結論をたどる（本 ADR は同じ不変条件を書き込み側から補強するだけであり、
recall の出力そのものを変えない）。

### 問1: 毎回渡す量を減らす方向に働くか

**間接的に減らす。** 対向の無い `contested` が recall に混入する経路を、読み取り側
（ADR 0136）に加えて書き込み側でも塞ぐ。production では今日この状態を作る経路が
無かったため、量そのものへの影響は0——**将来この経路を使うコードが書かれたときに、
その場で失敗させる**という予防に留まる。

### 問2: 無効にしても Memory Framework として成立するか

**成立する。** 正しいデータ（`markContestedPair` が作るペア、`contested` を一度も
使わない運用）には一切影響しない。

### 問3: この記憶が選ばれた理由を、後から説明できるか

**影響なし。** 本 ADR は書き込みの可否を変えるだけで、recall の出力・trace には
関与しない。

### 問4: AI の推論と、ユーザーが言った事実を区別しているか

**影響なし。** `status`/`contestedWithId` のみを見る。

### 問5: LLM を呼ばずに済ませられないか

**済ませられる。** 列の比較だけで完結する。

---

## 測ったこと

**出所: 私がこの作業環境で実行した。**

- `pnpm --filter @mnemora/core run typecheck` / `pnpm --filter @mnemora/testkit run
  typecheck` / `pnpm --filter @mnemora/postgres run typecheck` — 個別に緑を確認した後、
  ルートの `pnpm run typecheck`（全7 workspace projects）も緑。
- `pnpm run lint`（eslint、リポジトリ全体） — 緑。
- `pnpm run format:check`（prettier、リポジトリ全体） — 緑（新設テストファイルは
  `prettier --write` 後に緑）。
- `rm -rf packages/*/dist && pnpm run build` — 全7 projects 緑。
- `pnpm run pack:check` — 緑（6パッケージとも publish 梱包の検査を通過）。
- `pnpm run test`（ルート） — `vitest run` 943 tests 緑 + 各 package 緑
  （`@mnemora/core` 623・`@mnemora/testkit` 256・他パッケージも全緑）。**`packages/postgres`
  と `examples/chat` の DB テストは実行していない**（`DATABASE_URL` 未設定。
  「DB テストは実行していません」と明示的に告知されることを確認した。ADR 0015 の通り、
  これは「DB 側を見ていない」であって「全部通った」ではない）。

### 変異試験（`packages/core`/`packages/testkit` は DB を要さないため、実際に実行した）

**手順**: 変異の前に対象ファイルを `/tmp/mnemora-backup/` へ退避コピーしてから、
その場でコードを直接書き換えて赤を確認し、退避コピーから `cp` で戻して緑を確認した
（`git checkout` は使っていない——`docs/autonomy.md` §4 が指摘する「未コミットの編集も
消える」穴を踏まないため）。

- **`packages/testkit`（`InMemoryMemoryStore`、共有適合スイート経由）**:
  1. `createMemoryIdempotent` のガード（`if (isContestedWithoutCompanion(...))`）を
     `if (false)` に変異 → 新設した2つの歯（`createMemory`/`createMemoryWithOutbox` の
     拒否）が実際に赤くなる（`ContestedWithoutCompanionError` が投げられず、代わりに
     作成された Memory のスナップショットが出力される）ことを確認した。元に戻すと
     256 tests 全緑に戻ることを確認した。
  2. `updateStatus` のガード（`if (status === "contested")`）を `if (false)` に変異 →
     新設した歯が赤くなることを確認。元に戻して緑に戻ることを確認した。
  3. `supersedeWithNewMemories` の事前検査（1c）を `if (false)` に変異 → **1回目は
     赤くならなかった**（`createMemoryIdempotent` 内の同じガードが、事前検査の代わりに
     `news` ループの途中で発火し、例外の型としては正しく見えた）。これは歯の弱さを
     示していた——「事前に全件検査してから書き込みを始める」という性質（部分書き込み
     防止）を、この歯は検出できていなかった。**歯を強化した**（`news[0]` に有効な
     Memory を1件追加し、違反する要素を `news[1]` に置いた）うえで同じ変異を再実行 →
     `totalInScope` が `1`（期待）ではなく `2`（`news[0]` が部分的に書き込まれた
     証拠）になり、正しく赤くなることを確認した。元に戻して緑に戻ることを確認した。
  4. 上記の過程で、この PR より前から存在した3本の共有適合テスト
     （`archiveDecayed`/`purgeMemory`/`markContestedPair` の各1本）が、主題と無関係に
     対向無しの `contested` fixture を使っていたために新設ガードで赤くなることを
     発見した——companion を足す形で修正し、緑に戻したことを確認した
     （このリポジトリで実際に走らせて確認した回帰。下の「CI で見つかった、手元では
     見つけきれなかった影響」に、同じ形で見つかったもう1件を記録する）。
- **`packages/postgres`（`PostgresMemoryStore`）**: 本物の DB は無いが、**ガード自体は
  `this.db.execute`/`this.db.transaction` を呼ぶ前に判定する純粋な分岐**であるため、
  実接続を持たない `Db` 型のスタブ（`{} as unknown as Db`）で `PostgresMemoryStore` を
  構築し、ガードだけを対象にした専用テストファイル
  （`packages/postgres/src/__tests__/memory-store-contested-write-guard.test.ts`、
  10 tests）を新設した。`pnpm --filter @mnemora/postgres exec vitest run
  src/__tests__/memory-store-contested-write-guard.test.ts` で実行し、**5箇所すべての
  ガード**（`createMemory`/`createMemoryWithOutbox`/`updateStatus`/
  `updateStatusWithEvent`/`supersedeWithNewMemories`）を個別に `if (false)` へ変異させて
  赤くなることを確認し、都度 `/tmp/mnemora-backup/postgres/memory-store.ts` から
  `cp` で戻して緑に戻ることを確認した。**この歯は package.json のスクリプト
  （`test:db`）経由では DB 有りの他ファイルと合流して初めて走る**が、このファイル
  単体は DB を必要としない——手元でDB無しに実行するときは vitest にこのファイルを
  名指しで渡すこと（テスト冒頭の doc コメントに明記した）。
- また、既存の `packages/postgres/src/__tests__/recall.postgres.test.ts` の
  「段3/段4」の歯を、`createMemory` での直接的な lone-contested 生成から
  `markContestedPair` 経由の正しい相互ペア構成へ書き換えた——**この歯自体は DB を
  要するため、この作業環境では実行して確認していない**（下記「確かめていないこと」）。

### CI で見つかった、手元では見つけきれなかった影響

**出所: マネージャーが CI（PR #260、sha `2d30865`）のログから実測して報告し、
私がそれを受けて直した。**

`packages/postgres/src/__tests__/recall-gate-index.test.ts` の `insertManyMemories`
ヘルパが、`["active", "contested", "superseded", "archived", "forgotten"]` を
順に回して `store.createMemory(ctx, buildNewMemoryFixture({ ..., status }))` を
4000行ぶん呼んでおり、`status === "contested"` の行を `contestedWithId` 無しで
作っていた。この歯の主題は段1のゲート述語（`status IN ('active','contested')`）が
どの status を拾うかであって `contested` の一対一ではないため、companion を1件
足す形で修正した（`packages/postgres/src/__tests__/recall-gate-index.test.ts` の
`insertManyMemories`）。

**この箇所は、本 PR がこの作業環境（`DATABASE_URL` 無し）で実行できる層のどこにも
現れなかった。** `packages/core`/`packages/testkit` の変異試験・grep による横断
（本 ADR 執筆時点）のどちらでも見つけられず、**CI の DB ジョブが実際に走って
初めて表面化した**——`packages/postgres (UTF8)`/`packages/postgres (SQL_ASCII)`/
「ルートの test 門の DB 段」の3ジョブが、同じ1箇所を原因に揃って赤くなった。

**⟹ これは Issue #247 の族（この作業環境に DB が無いこと）が実際に効いた記録である。**
手元で確認できる範囲（`packages/core`/`packages/testkit`、および DB を要さない
`packages/postgres` のガード専用テスト）をどれだけ厳密にやっても、**DB に依存する
固定 fixture（`buildNewMemoryFixture` に status を渡すだけの単純なヘルパ関数）の
横断的な洗い出しは、実際にその fixture を使うテストを実行しないと完結しない**——
grep は「`status: "contested"` という字面」までは見つけられるが、それが
`contestedWithId` を伴わずに `store.createMemory` へ渡っているかは、関数呼び出しの
組み立てを追わないと分からず、今回は grep でも見落とした。

同じ横断 grep（`packages/postgres/src/__tests__/*.ts` を対象に `contested` を含む
全ファイルを洗い出す）を、この修正の際に改めて実行し直した——`contested-with-index.test.ts`
/`archive-decayed-index.test.ts`/`lexical-store-index.test.ts`/
`memories-requeue-embed-index.test.ts` は生 SQL の `INSERT ... SELECT ... FROM
generate_series` で直接 `memories` テーブルへ書き込んでおり、`MemoryStore` の
公開メソッドを一切経由しないため本 ADR の制約が構造的に及ばない（対象外）。
`vector-search-subject.test.ts`/`vector-search-provenance.test.ts` は `filter:
{ status: ["active", "contested"] }` という**クエリ側の絞り込み**でのみ
`"contested"` を使っており、`contested` な Memory を作成してはいない。
**⟹ `recall-gate-index.test.ts` 以外に、同種の対向無し `contested` 生成箇所は
見つからなかった**（ただし、この結論も grep と目視によるものであり、DB を伴う
全テストを実行して確認したものではない——次節「確かめていないこと」参照）。

---

## 確かめていないこと

- **`packages/postgres` の DB を伴うテスト全体**（既存の `*.postgres.test.ts`・
  DB 依存の `*.test.ts` を含む）。この作業環境には `DATABASE_URL` も docker も無い
  （`which docker podman psql postgres initdb` は全部何も返さない、実測)。これは
  Issue #247 / alteroid #965 / alteroid #1015 の族として既知の構造的な穴であり、
  **本 ADR ではこの制約下でガード部分（DB に触れる前の分岐）だけを、DB を要さない
  専用テストで検証した。** 実際の `INSERT`/`UPDATE` が Postgres 側の制約
  （外部キー・CHECK 制約）と整合すること自体は、この作業環境では検証していない
  ——ただし本 ADR はどの SQL 文言も変更していないため、既存の SQL 自体への影響は
  無いはずだと判断しているが、**この判断自体を DB の実行結果で裏取りしてはいない。**
- **書き換えた `recall.postgres.test.ts` の歯が実際に通ること。** `markContestedPair`
  経由の構成に書き換えたが、DB が無いためこの作業環境では実行していない。CI の
  `postgres` ジョブで確認する必要がある。
- **書き換えた `recall-gate-index.test.ts`（`insertManyMemories`）の歯が実際に通る
  こと。** companion を足す形に直したが、DB が無いためこの作業環境では実行して
  いない。CI で確認する必要がある。
- **`packages/postgres/src/__tests__/` を横断した grep が、対向無し `contested`
  生成の全箇所を本当に洗い出せているという保証。** grep と目視で「見つからなかった」
  ことを確認したに留まり、DB を伴う全テストを実際に実行して確認したものではない
  ——`recall-gate-index.test.ts` の1件も、まさに「grep では見つかると思っていたが
  実際には見落としていた」ものだった経緯を踏まえると、**同種の見落としが他にも
  残っている可能性を否定できない。**
- **CI 全体の緑**。この PR を出した後、`node scripts/ci-green-check.mjs --pr <番号>`
  で確認する（下記、報告参照）。
- **外部実装者への実際の影響。** 提起した通り、本リポジトリからは確認できない。
