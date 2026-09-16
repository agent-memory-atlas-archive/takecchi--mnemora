# ADR 0172: 連想枠（段3.5）にも忘却ゲートと `validAt` ゲートを通す — ゲートの欄を1箇所に集め、述語は段1と共有する（Issue #347）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

**⚠ 各主張の出所を分ける**（ADR 0167 / 0170 の体裁を踏む）。

- **【実測】** — この ADR の書き手が、自分の手で走らせて確かめた。DB を要する測定は、
  他エージェントが使用中の既存クラスタ（port 5433 の `/home/worker/pgdata`、
  port 5544 の `/home/worker/b5/pgdata`）には触れず、**port 5470 で
  `/home/worker/n347/pgdata` に自分専用の独立クラスタを新設**して行った
  （PostgreSQL 17.11 + pgvector 0.8.0、ADR 0167 / 0170 と同じ方法）。
- **【現物】** — この repo のコード・文書・git 履歴を、書き手が自分の手で読んで確かめた。
- **【受】** — Issue #347 本文（v1.0 最終監査 PR #346 の副産物）。書き手は下記のとおり
  自分の手で検算した。

---

## 結論（先に）

**`recall()` の段3.5（連想枠、ADR 0151）だけが、忘却ゲート（ADR 0153 / 0165）と
`validAt` ゲート（ADR 0164）のどちらも通っていなかった。**
⟹ **完全に減衰しきった記憶と、期限切れ／未発効の記憶が、連想枠から黙って返っていた。**

**直し方は「連想枠にもゲートを足す」ではなく、「ゲートの欄と述語を1箇所に集めて
両方から使う」にした。**——足すだけでは、次にゲートが増えたときに同じ形でまた漏れる。

- 押し下げ側: `gateVectorFilterFields`（`packages/core/src/recall-runtime.ts`）という
  `VectorFilter` の**断片を1つだけ作り**、段1の ANN と段3.5 の連想がその同じ断片を
  spread して撒く。
- 後置側: 段1が使っていた `survivesDecayGate()` と、新設の `survivesValidityGate()`
  （段1のインラインの述語をそのまま関数にしたもの）を、**両段が同じ関数として呼ぶ。**

⭕ **`status`（`superseded` を返さない）は壊れていなかった**（連想用 filter は最初から
`status: ["active","contested"]` を渡していた）。**今回そこは触っていない**——回帰の歯で
固定した。

⭐ **北極星の物差し（`compare` の `mnemoraShareOfNaiveChars`）は動かなかった**【実測】。
12行すべてが基準値と**バイト単位で一致**した（下記「⭐門の実測」）。
⟹ **`examples/chat/compare-baseline.json` の更新は要らない。**

---

## 1. 【現物】何が起きていたか

`main = 0e0a4c1` 時点の `packages/core/src/recall-runtime.ts`:

1. **`:1049-1064` の連想用 `vectorStore.search()` の filter が5欄しか持たない**
   （`tenantId` / `status` / `subjectId` / `excludeProvenanceKinds` / `occurredAfter` /
   `occurredBefore`）——`decayFloorAtAfter` / `decayFloorSeqAfter` / `decayFloorAnyAxis` /
   `validAt` が無い。段1の ANN は `:486-498` で渡していた。
2. **`:1106-1118` の後置ループが `survivesDecayGate()` を呼ばず、`validAt` も見ない。**
   両ゲートの後置は `:663-683` に在るが、**そこは段1の候補（`candidates`）だけを回る
   ループ**であり、連想候補（`associationUnits`）は一度も通らない。
3. **`:1044-1047` のコメントが「境界は段1のANN検索と同一にする」と書きながら、
   列挙は5つで止まっていた。**⟹ 意図的な除外ではなく、**散文で数え直した列挙が、
   後から足ったゲートに追随できていなかった**形である。

---

## 2. 【現物】なぜ段3.5 だけが漏れたのか

**git 履歴で確認した。**連想用 `search()` の filter を含むブロックが最後に変わったのは
**PR #290（ADR 0151、連想枠の実装そのもの）= `21ecce2`** であり、それ以降 `main` では
一度も変更されていない（`git log -S 'excludeProvenanceKinds: validatedQuery.excludeProvenanceKinds' -- packages/core/src/recall-runtime.ts`
が返すのは `21ecce2` / `0a71a57` / `48bdae9` の3本だけで、最新が `21ecce2`）。

**⟹ 段3.5 は、生まれた時点から一度もゲートを通っていない。**
忘却ゲート（ADR 0153）は #290 より前に入っていたのに、である。

**マージ時刻【実測】**（`gh pr view <n> --json mergedAt`）:

| PR | マージ時刻 (UTC) | 何をした |
|---|---|---|
| [#290](https://github.com/takecchi/mnemora/pull/290) | 2026-09-15T18:51:46Z | 連想枠（段3.5）を実装（ADR 0151）。**このとき既に忘却ゲートは在ったが、連想用 filter には入らなかった** |
| [#334](https://github.com/takecchi/mnemora/pull/334) | 2026-09-16T00:32:28Z | `validAt` ゲート（ADR 0164）。段1の ANN と語彙へ押し下げ、`:663-683` に後置を置いた |
| [#336](https://github.com/takecchi/mnemora/pull/336) | 2026-09-16T03:48:51Z | `examples/chat` の想起経路が連想枠を**既定で**使うようにした（ADR 0168） |

**#334 と #336 は同じ日に、3時間16分差で着地している。**

- #334 は「ゲートを足す」PR だった——**既定 off の段3.5 は視野に入っていなかった。**
  当時、連想枠は呼び手が明示しなければ走らない任意機能であり、
  「既定経路の正しさ」の検査対象として見えにくい位置に在った。
- #336 は「連想枠を既定にする」PR だった——**ゲートの列挙を見直す PR ではなかった。**
  この PR によって、段3.5 は「任意機能」から**既定経路**に変わった。

**⟹ どちらのレビューでも相手側が見えていなかった。**片方は「ゲートを足したが、
そのとき既定でない段は見なかった」、もう片方は「既定にしたが、その段が
ゲートを通っているかは見なかった」。**2つの PR の間に落ちた。**

**⚠ これは「レビューが甘かった」という話ではなく、構造の問題である**——
**ゲートを足す側は、ゲートを撒く箇所の一覧を散文（コメント）でしか持っていなかった。**

---

## 3. 【実測】再現した

Issue #347 は「実行して再現していない」と明記していた。**書き手が歯として再現した。**

`packages/core/src/__tests__/recall-association-gates.test.ts` を先に書き、**修正前の
コード（押し下げも後置も無い状態）に対して走らせた**ところ、17本中**8本が赤**になった:

```
× 段1と段3.5の filter の decayFloorAtAfter / decayFloorSeqAfter / decayFloorAnyAxis / validAt が一致する
× includeFullyDecayed / includeOutsideValidity を渡すと、連想用 filter でもゲートが外れる
× 完全に減衰しきった記憶は、連想枠からも返らない
× 'activity' のテナントでは、壁時計が遠い未来でも decayFloorSeq を割った記憶は連想枠から返らない
× 期限切れ（validUntil が過去）の記憶は、連想枠からも返らない
× 未発効（validFrom が未来）の記憶は、連想枠からも返らない
× 減衰しきった記憶は、連想用 search() がゲートを剥がしても返らない
× 期限切れの記憶も、連想用 search() がゲートを剥がしても返らない
```

**⟹ Issue #347 の指摘は、コードの読解だけでなく振る舞いとして実在した。**

**さらに、本物の Postgres + pgvector でも再現した**（後述の
`recall-association-gates.postgres.test.ts` を同じバグの状態に対して走らせると、
7本中3本が赤——減衰・活動時計・期限切れの3つ）。⟹ **擬似物の産物ではない。**

---

## 決定

### 決定1: ゲートの `VectorFilter` 欄を `gateVectorFilterFields` に1箇所だけ置き、段1と段3.5がそれを spread する

`packages/core/src/recall-runtime.ts`:

```ts
const gateVectorFilterFields: Pick<
  VectorFilter,
  "decayFloorAtAfter" | "decayFloorSeqAfter" | "decayFloorAnyAxis" | "validAt"
> = { ... };
```

段1の ANN も段3.5 の連想も `...gateVectorFilterFields` を撒く。
**⟹ 「同じ欄を2箇所で組み立てる」形をコードから消した。**両方に
「ここへ直接足すな、`gateVectorFilterFields` へ足せ」というコメントを置いた。

**なぜ `filter` 全体を共有しなかったか**: 段1と段3.5 は `limit` の使い方・
`status` の由来などは同じでも、**将来「連想枠だけ scope を変える」判断がありうる**
（例: ADR 0151 のアンカー選定の議論）。**ゲートの欄だけを共有し、scope の欄は
各段に残す**ことで、「揃っていなければならないもの」と「意図して分かれうるもの」を
型の上で分けた。

### 決定2: 後置の述語は関数にして両段が呼ぶ（`survivesDecayGate` / `survivesValidityGate`）

`survivesDecayGate()` は既に在った（ADR 0165）。`validAt` 側は段1にインラインで
書かれていたので、**`survivesValidityGate()` として切り出し、段1もそれを呼ぶように
置き換えた**（段1の振る舞いは変わらない——同じ述語・同じ境界である）。
段3.5 の後置ループはこの2つを呼ぶ。

**⟹ 述語を2箇所に書き下さない。**ADR 0165 決めたこと12 が「活動時計の軸を忘れると
語彙チャンネルだけ壁時計のまま残る」と警告した同型の罠を、段3.5 でも閉じた。

### 決定3: `omitted` の数え方は変えない（連想枠の後置で落ちた分は数えない）

**新しい `condition` も `countKind` も作らない。`decayFilteredCount` にも足さない。**

理由:

1. **連想用 `search()` も同じ3欄を押し下げるので、通常この後置は1件も落とさない**
   ——落ちるのは adapter が ADR 0034 の契約を破ったときだけである。
   段1の ANN の押し下げ分が原理的に数えられない（ADR 0011）のと**同じ扱い**である。
2. **[Issue #329](https://github.com/takecchi/mnemora/issues/329)（段1の押し下げ分が
   数えられない問題）と数え方が混ざる。**#329 は別途「塞ぐ方向で進めてよい」と
   決まっており別作業として進行中である——**この PR で先に別の数え方を作ると、
   そちらの設計を縛る。**（マネージャーの方針として受け取り、書き手もこの判断に同意した。）
3. `expired` / `not_yet_valid` の件数は**そもそも段から出ていない**——
   `MemoryStore.aggregateScope` が scope 全体から exact に数える（`:1314` / `:1322`）。
   ⟹ 段3.5 に `validAt` ゲートを足しても、**これらの件数は1も変わらない。**

**⟹ この PR は `omitted` の出力を1バイトも変えない。**その事実自体を歯にした
（「連想用 adapter がゲートを剥がしても `filtered(decayed)` が積まれない」）。

### 決定4: `docs/recall.md` §9.2 手順4 の列挙を、散文で数え直さない形へ書き換える

「段0 と同じ scope の filter で呼ぶ」→「**段1の ANN 検索と同じ filter で**呼ぶ
——scope だけでなく忘却ゲートと `validAt` ゲートも含む。**ここで境界を散文で
数え直さないこと**」とし、実装側の単一の出所（`gateVectorFilterFields`）を名指しした。

---

## 採らなかった案

| 案 | 却下理由 |
|---|---|
| **連想用 filter に3欄を直接書き足すだけ**（最小の差分） | **次にゲートが増えたとき、同じ形でまた漏れる。**今回の原因は「欄が足りない」ことではなく「欄の一覧が2箇所に在り、片方が散文でしか同期されていない」ことである |
| **段1と段3.5 で `filter` オブジェクト全体を共有する** | scope の欄（`subjectId`/`period`）は**意図して分かれうる**（決定1）。全部を1つにすると、その判断が型の上で見えなくなる |
| **連想枠で落ちた分を `filtered(condition:'decayed')` に数える** | 決定3。Issue #329 と数え方が混ざる。**この PR では `omitted` を変えない** |
| **`association` 用の新しい `condition`（例 `'association_decayed'`）を作る** | 同上。`FilteredOmission.condition` の語彙を増やすのは、どう数えるかの設計判断が固まってから |
| **`VectorFilter` を「ゲート欄」と「scope 欄」の2つの型に分け、`search()` の引数を変える** | 公開 interface の破壊的変更になる（ADR 0156 により実装してよい範囲ではあるが）。**今回の欠陥は core 内部の組み立てに閉じており、adapter 側の契約は既に正しい**——interface を動かす理由が無い |
| **型で強制する仕掛け**（ゲートを足したら全ての `search()` 呼び出し箇所が壊れる形） | 下記「引き受けた負債1」。今回は入れなかった |

---

## 置いた歯

### `packages/core/src/__tests__/recall-association-gates.test.ts`（新設、17本）

DB を要さない（`packages/core` 自身の擬似物。`recall-decay-gate.test.ts` と同じ作法で、
`@mnemora/testkit` には依存しない）。

**配置**: Q=[1,0] / アンカー=[0.7071,0.7071]（Q との類似度 0.7071 で段1に入る）/
相方=[0,1]（**Q との類似度は 0 で段1では below_threshold**、アンカーとの類似度は 0.7071）。
⟹ **相方が結果に現れたら、それは段3.5 を通ったということ**である。

1. **配線**（2本）: 段1と段3.5 の filter の4欄が一致すること。`includeFullyDecayed` /
   `includeOutsideValidity` で連想用 filter からもゲートが外れること。
2. **忘却ゲート**（3本）: 減衰しきった記憶が連想枠から返らない／対照（沈んでいなければ
   連想枠から返る）／`includeFullyDecayed: true` の opt-out が連想枠でも効く。
3. **活動時計**（3本）: `'activity'` で壁時計が遠い未来でも `decayFloorSeq` を割れば
   連想枠から返らない／対照（`'wall'` なら返る）／`'either'` は OR で返る。
4. **`validAt` ゲート**（4本）: 期限切れ／未発効が連想枠から返らない（それぞれ
   `omitted` の `expired`/`not_yet_valid` が**従来どおり** `aggregateScope` から
   出ていることも併せて固定）／`includeOutsideValidity: true` の opt-out ／
   **過去の `validAt` を指定すればその時点で真だった記憶が連想枠から返る**
   （ゲートが「常に落とす」ものではなく時刻の述語であることの検算）。
5. **⭕ 回帰**（2本）: `superseded` は連想枠から返らない。`includeFullyDecayed` /
   `includeOutsideValidity` を渡しても返らない（**ゲートの軸が別**であることの検算）。
6. **多層防御**（3本）: `AssociationGateStrippingVectorStore`（**2本目以降の
   `search()` からだけゲート欄を剥がす**——段1の押し下げはそのまま効かせるので、
   「連想用 `search()` だけが ADR 0034 の契約を破った」状況を歯の中で再現できる）
   に対して、減衰・期限切れ・**活動時計で沈んだもの**が返らないこと。
   加えて、**`filtered(decayed)` が積まれない**こと（決定3の歯）。

### `packages/postgres/src/__tests__/recall-association-gates.postgres.test.ts`（新設、7本）

**本物の Postgres + pgvector に対する歯**（マネージャーの指摘により追加）。
配置はユニットの歯と同じ三角形を3次元で作る（`TEST_EMBEDDING_SPACE.dimensions = 3`）:
`Q=[1,0,0]` / アンカー `A=[0.70710678,0.70710678,0]` / 相方 `B=[0,1,0]`
——`cos(Q,B)=0` ちょうどなので `B` は段1では below_threshold、`cos(A,B)≈0.7071` なので
**連想枠でしか届かない。**

| 歯 | 何を測るか |
|---|---|
| 対照 | この配置が本当に段3.5 を通ること（`retrievedVia:'association'` と `associationOf`） |
| (甲) | 減衰しきった記憶が連想枠から返らない |
| (乙) | `includeFullyDecayed: true` で返る（opt-out が実 adapter 経路でも効く） |
| (丙) | `decay_clock:'activity'` のテナントで、壁時計が遠い未来でも `decay_floor_seq` を割った記憶は返らない（**ADR 0165 の2軸目が実 SQL で効くこと**） |
| (丁) | 対照: 同じ記憶を `'wall'` のテナントで引くと返る |
| (戊) | 期限切れ（`valid_until` が過去）が連想枠から返らない |
| (己) | `includeOutsideValidity: true` で返る（opt-out） |

⚠ **`recall-decay-cross-day.postgres.test.ts` には足していない**——そちらは Issue #302 の歯であり、
Issue #329 の作業が同じファイルを触っているため（マネージャーの指示）。

⭐ **ユニットの歯との違いが1つ現れた**: `recall-decay-cross-day.postgres.test.ts` の `(乙)` は
`includeFullyDecayed: true` だけでは戻らず `scoreThreshold: 0` を要したが、**連想枠の (乙) は
要らない**——段3.5 の候補は段2の閾値分割を通らない（`associationUnits` は閾値の後に連結される）。
**この非対称自体が、この歯が段1ではなく段3.5 を測っていることの証拠である。**

### 変異試験【実測】

退避コピー（`/tmp/e347/recall-runtime.ts.bak`）から戻す方式で行った
（`docs/autonomy.md` §4「`git checkout <file>` で変異を戻すと未コミットの編集も消える」）。

| 変異 | 結果 |
|---|---|
| **A**: 連想用 `search()` から `...gateVectorFilterFields` を消す | **2本が赤**（配線の歯）。他15本は緑——**後置の多層防御が実際に救っていることの裏付け**でもある |
| **B**: 連想の後置2行（`survivesValidityGate` / `survivesDecayGate`）を消す | **2本が赤**（多層防御の歯。押し下げが効いているので他は緑） |
| **C**: A と B の両方（= バグの状態そのもの） | **8本が赤**（上記「3. 再現した」） |
| **D**: 連想の後置で `survivesDecayGate` の代わりに `wallAxisAlive` を呼ぶ（活動時計の軸を忘れる） | **最初は17本中0本が赤だった**——押し下げが先に候補を落とすため。⟹ **歯を1本足した**（`'activity'` × ゲート剥がしの組み合わせ）。足した後は**その1本が赤**になる |

**実 Postgres の歯に対しても同じ変異を当てた**【実測】:

| 変異 | 実 Postgres の歯（7本）の結果 |
|---|---|
| **C**（= バグの状態そのもの） | **3本が赤**——(甲) 減衰 / (丙) 活動時計 / (戊) 期限切れ。対照と opt-out の4本は緑 |
| **A**（連想用 `search()` から押し下げだけを剥がす） | **7本とも緑**——後置が救うため。⟹ **この歯は押し下げ単体を切り分けない**（切り分けはユニットの歯が持つ。上記「引き受けた負債3」） |

**⚠ 変異Dは、歯を書いた後の実測で「捕まらない」ことが判明して歯を足した実例である。**
`recall-decay-gate.test.ts` が語彙チャンネルで同じ理屈（押し下げが効く経路では後置の
述語が露出しない）を既に踏んでおり、その先例に倣った。

---

## ⭐門の実測（`compare`）

**動かなかった。**【実測】

- 環境: 自前の PostgreSQL 17.11 + pgvector 0.8.0（port 5470、`/home/worker/n347/pgdata`）。
  provider は `llmMode=recorded` / `embeddingMode=recorded`（CI と同じ層。ADR 0051 / 0133）。
- **DB をまっさらに作り直して3回**実行し、いずれも
  `examples/chat/compare-baseline.json` の `rows`（12行）と
  **`JSON.stringify` でバイト単位に一致**した（`measuredAt` を除く）。
- `node scripts/compare-summary.mjs --measured ... --baseline examples/chat/compare-baseline.json`
  は **exit 0**、出力は「✅ 一致(差分なし)」。

**なぜ動かないか（読み）**: `compare` のシナリオ（`examples/chat/src/scenario.ts`）は
**`validFrom`/`validUntil` を一切設定せず**、ingest したばかりの記憶を同じ run の中で
引く——`decayFloorAt` は遠い未来であり、`decay_clock` は既定の `'wall'` である。
⟹ **落とすべきものが1件も無い。**この修正が減らすのは「減衰しきった／期限切れの記憶」
だけであり、このベンチにはそれが存在しない。

**CI でも一致した**【実測】: この PR の CI run 35056903563（`example-chat` ジョブ）の
artifact `compare` を取得して突き合わせたところ、`rows` は基準値と**バイト単位で一致**
（`measuredAt=2026-09-16T04:48:14.229Z`）。⟹ **手元3回 + CI 1回で一致。**
`compare-summary.mjs` の門も CI 上で緑だった。

**⟹ `examples/chat/compare-baseline.json` は更新しない。**
（Issue #347 本文は「基準値の更新は要る」と書いていたが、**実測では要らなかった**
——これは Issue の「確かめていないこと」節が自ら未検証と断っていた項目である。）

なお `scripts/compare-summary-lib.mjs` の `computeRegressions` が**増加のみを赤とする
片側判定**であることも【現物】で確認した（`measuredShare > baselineShare` のときだけ
`mnemoraShareOfNaiveChars` の退行として積む）——**減る方向なら赤にならない。**
今回は増減そのものが無かったため、この経路は踏んでいない。

---

## 誰が壊れうるか / 引き受けた負債

1. **🔴 「ゲートが増えるたびに段3.5 を直し忘れる」構造は、完全には消えていない。**
   `gateVectorFilterFields` は**押し下げ側の欄**を1箇所に集めたが、
   **新しいゲートを足す人が、そこへ足すとは限らない**——段1の filter へ直接書いても
   TypeScript は通る（コメントで禁じているだけである）。**型や lint による強制は
   入れていない。**
   - **入れなかった理由**: 強制する形（例: 段1の filter を組み立てる関数を1本にして
     `VectorFilter` の生成箇所を1つに絞る）は、`status`/`subjectId`/`period` の
     組み立てまで巻き込み、**語彙チャンネル（`LexicalFilter` は `decayFloorAtAfter` を
     持たない、ADR 0153 マネージャー決定3）との非対称**をどう扱うかという別の設計判断を
     要する。今回の欠陥の修復に対して過剰であり、**別の判断として残した。**
   - **代わりに置いたもの**: (a) 両方の呼び出し箇所のコメント、(b) `docs/recall.md` §9.2 の
     「散文で数え直さないこと」、(c) **配線の歯**——段1と段3.5 の filter の4欄が
     一致することを直接比較する歯であり、**ゲートを段1にだけ足した人はこの歯で赤くなる**
     （4欄に限る。5つ目のゲートが増えたらこの歯自身も更新が要る——ここが残余である）。
2. **連想枠の後置で落ちた分は、どこにも数として現れない**（決定3）。
   adapter が契約を破った場合、**黙って減る。**Issue #329 の対応が入ったら、
   ここも同じ数え方に揃えるべきである。
3. **`packages/testkit` の conformance は、この境界を測れない**（adapter 非依存の歯では
   「core が連想用 `search()` へその欄を渡すか」を表現できない）。⟹ **3層に分けて塞いだ**
   ——(a) adapter 単体は既存の conformance（`decayFloorAtAfter`/`decayFloorSeqAfter`/
   `decayFloorAnyAxis`、ADR 0034 / 0165）、(b) core の配線は新設のユニットの歯、
   (c) **2つを繋いだ既定経路は新設の実 Postgres の歯**。
   **⚠ (c) は押し下げ単体を切り分けない**（後置が救うため）——下記「変異試験」参照。
4. **実 Postgres の歯は `decay_clock: 'either'` を測っていない。**
   `'wall'`（既定）・`'activity'`・`validAt` は測ったが、OR で結ぶ `'either'` は
   ユニットの歯だけである（`decayFloorAnyAxis` の adapter 側の挙動自体は conformance が
   別に測っている）。

## これが覆るとしたら

1. **Issue #329 の対応が `omitted` の数え方を変えたとき**——決定3（連想枠で落ちた分を
   数えない）を、そちらの新しい数え方へ揃え直すこと。**この ADR の決定3は、
   #329 の設計を縛らないために「今は変えない」と言っているに過ぎない。**
2. **3つ目・4つ目のゲートが足されたとき**——`gateVectorFilterFields` に足すだけで
   段1と段3.5 の両方に効くが、**配線の歯（4欄の一致を見る歯）は手で更新が要る。**
   更新を忘れると、歯は「4欄が一致している」としか言わない。
   ⟹ そのときは、負債1の「型で強制する形」を改めて検討すること。
3. **連想枠が scope を段1と意図的に変える設計になったとき**（例: アンカー周辺だけ
   期間を広げる）——決定1の「ゲート欄だけ共有、scope 欄は各段」という分け方が
   効いてくる。ゲート欄まで分けたくなったら、その理由を ADR に書くこと。
4. **`compare` のシナリオが `validFrom`/`validUntil` や減衰しきった記憶を含むように
   なったとき**——⭐門の数字が動きうる。今回「動かなかった」のは
   **シナリオの性質**であって、この修正が量に影響しないことの証明ではない。

## 確かめていないこと

- ~~**実 Postgres に対して「減衰しきった記憶が連想枠から返る／返らない」を実測していない。**~~
  **⟹ 実測した**（`packages/postgres/src/__tests__/recall-association-gates.postgres.test.ts`、
  7本）。**この ADR の初版は「実 Postgres の歯は既存の作法に無いので足さない」と書いていたが、
  その前提が事実と違った**——`recall-decay-cross-day.postgres.test.ts`（Issue #302 / PR #324）が
  忘却ゲートを実 Postgres で既に測っている。⟹ **作法は「core のユニットだけ」ではない。**
  連想枠は PR #336 以降 `examples/chat` の既定経路であり、**実 Postgres で一度も測られて
  いないゲート経路**を残さないために足した（マネージャーの指摘による訂正）。
- **実 Postgres の歯は、押し下げ（`VectorFilter`）と後置フィルタを切り分けない。**【実測】
  連想用 `search()` から押し下げだけを剥がす変異では、**7本とも緑のまま**だった
  ——後置が救うためである（それ自体は多層防御が働いている証拠でもある）。
  ⟹ **押し下げ単体・後置単体の切り分けは、`packages/core` のユニットの歯の側が持つ。**
- **`examples/chat` の `association-probes` ベンチ（ADR 0158 / 0167、`local` 埋め込み）を
  走らせていない。**このベンチの probe set は減衰も有効期限も持たないため影響は無い
  **はず**だが、**確かめていない。**
- ~~**⭐門の3回の一致は、すべて同一マシン・同一クラスタでの再実行である。**
  CI で同じ値になることは、この PR の CI が出るまで確かめていない。~~
  **⟹ 確かめた**【実測】: この PR の CI run 35056903563（`example-chat` ジョブ、
  `pgvector/pgvector:pg17` の service container）が生成した artifact `compare` を
  `gh run download` で取得し、`rows`（12行）が基準値と `JSON.stringify` で
  **バイト単位に一致**することを確認した（`measuredAt=2026-09-16T04:48:14.229Z`、
  書き手のローカル3回とは別の測定）。⟹ 手元3回 + CI 1回の計4回で一致している。
  **⚠ ただし CI 側は1回だけである**——同一 sha の CI 再実行による突き合わせは
  行っていない（ADR 0133 / 0170 が行った形の裏取りはしていない）。
- **`compare` 以外の5本のベンチ**（`retrieval` / `identifier-probes` /
  `consolidation-cost` / `archive-sweep-cost` / `time-term`）は走らせていない。
- **この修正が、連想枠から返る件数を実運用でどれだけ減らすか**——測っていない
  （減らす方向であることは構造から言えるが、量は測っていない）。

Refs #347
