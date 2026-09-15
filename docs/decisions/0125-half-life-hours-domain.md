# ADR 0125: `halfLifeHours` の値域を `(0, ∞)`（有限の正の実数）に塞ぐ — ADR 0078 が「別 PR」と名指しした残債

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-15

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ」と「人から受け取った前提」を
混ぜない（[AGENTS.md](../../AGENTS.md)）。**この作業環境には Postgres が無く、
`packages/postgres` のマイグレーション・歯は実行できていない**（`DATABASE_URL` 無し）。
DB に関わる主張はすべて「PostgreSQL のドキュメントに基づく推論」または「CI が判定する」
と明記する。

---

## 文脈

[Issue #231](https://github.com/takecchi/mnemora/issues/231) は
[ADR 0078](./0078-strength-value-range.md)（`Memory.strength` の値域を `(0, 1]` に塞いだ ADR）
自身が「別 PR」と名指しした残債である（ADR 0078「この PR が何を*しない*か」節、逐語）:

> **`halfLifeHours` の DB CHECK も足さない。** zod には `positive()` が在るが DB には無い、
> という非対称は残る（実測3 のとおり zod は走らないので、実質どこにも無い）。
> **別の PR の話である。**

`decay`/`freshness` は `total = affinity × decay × tagMatch × freshness × strength`
（`packages/core/src/strategies/scoring.ts`）に直接掛かる項であり、
[ADR 0109](./0109-which-score-terms-actually-rank.md) が実測したとおり
**`total` は210行すべてで `similarity × decay²` にビット単位で一致する**。
⟹ `decay` が壊れれば、想起の順位がそのまま壊れる。

### 🔴 issue 本文の記述を、まず現物で検算した（訂正が1つ出た）

issue は「`halfLifeHours` が `0` または `NaN` だと `decay = +Infinity` になる」と書いている。
**私が `packages/core/src/strategies/decay.ts` の式をそのまま node で評価したところ、
`0` については不正確だった。**

`strengthAt(now, params) = strength * 0.5 ** (elapsedHours / halfLifeHours)`
（`elapsedHours = (now - base) / 1時間`。`recall()` の通常経路では `base`
＝`lastReinforcedAt ?? recordedAt` は過去なので `elapsedHours >= 0`）。

**【実測】（`node -e` で式をそのまま評価した。`strengthAt(elapsed, halfLifeHours)` として）:**

| `halfLifeHours` | `strengthAt(elapsed=100h)` | `strengthAt(elapsed=0h)` |
|---|---|---|
| `0`（+0） | `0` | `NaN` |
| `-0` | `+Infinity` | `NaN` |
| `-1e-300` | `+Infinity` | `1` |
| `-1` | `+Infinity`（実測値 `1.2676506002282294e+30`） | `1` |
| `NaN` | `NaN` | `NaN` |
| `Infinity` | `1`（発散しない） | `1` |
| `-Infinity` | `1`（発散しない） | `1` |

⟹ **`halfLifeHours = 0`（通常の +0）は `elapsed > 0` のとき `decay = 0` に、
`elapsed = 0`（recall がその Memory の作成と同時刻）のとき `decay = NaN` になる。
`+Infinity` に発散するのは負の `halfLifeHours`（`-0` を含む）のときである。**
**`NaN` は式全体を `NaN` に伝播させるだけで、`+Infinity` にはならない。**

**この訂正は、issue が求めている是正の方向を変えない。** `0`・負・`NaN` の**どれも**
`decay` を「順位を正しく比較できない値」（`0` は「絶対に選ばれない」側の壊れ方、
`NaN`/`+Infinity` は「必ず1位に来る」側の壊れ方）にする。**すべて拒むべき値である
ことは変わらない。** 個別の壊れ方の違いは、下記「決定」の値域そのものを変えない。

---

## 現物: `halfLifeHours` が流れ込む経路を数えた

### 経路1: `Memory.halfLifeHours`（`memories.half_life_hours`、Postgres 実 `real`、NOT NULL、**CHECK 無し**）

`decay.ts`/`scoring.ts` が実際に読むのはこの列である。書き込み経路:

| # | 経路 | 通る層 |
|---|---|---|
| 1 | `runtime.ts` の3つの生成経路（`observe`/抽出・`consolidate`・`reflect`）が
    `TenantSettingsStore.getDefaultHalfLifeHours()` の戻り値をそのまま `NewMemory.halfLifeHours` に書く | core |
| 2 | `MemoryStore.createMemory`/`createMemoryWithOutbox` を **`Runtime` を通さず直接呼ぶ** 経路 | store → DB |
| 3 | `InMemoryMemoryStore.createMemory`/`createMemoryWithOutbox` | store（in-memory） |
| 4 | `packages/testkit/src/test-data.ts` の `buildNewMemoryFixture`（ひな型。既定 720、上書き可） | テスト専用 |
| 5 | 🔴 `packages/postgres/src/bench/scale-bench.ts` の `INSERT ... SELECT`（生 SQL、リテラル `720`） | **DB だけ** |

**5 は ADR 0078 が数えた「経路8」と同じ形**——`MemoryStore.createMemory` も `NewMemory` 型も
通らない。ただし**現物を見ると、リテラルは常に `720` であり、いま新しい CHECK には
当たらない**（ADR 0078 が `strength` について確認したのと同じ状況）。

### 経路2: `tenant_settings.default_half_life_hours`（Postgres 実 `real`、NOT NULL DEFAULT 720、**CHECK 無し**）

**🔴 現物で確認した重要な事実: `TenantSettingsStore` interface に、この値を書く**本番用の**
メソッドが1つも無い。** `getDefaultHalfLifeHours(ctx): Promise<number>` という読み出し
専用メソッドしか無く（`packages/core/src/interfaces/tenant-settings-store.ts`）、
`setEventRetention` の UPSERT も `default_half_life_hours` 列には触れない
（`PostgresTenantSettingsStore.setEventRetention` のコメント: 「行が無い場合は DB 側の
DEFAULT（720 / 'open'）に任せる」）。

書き込み経路は次の3つだけである:

| # | 経路 | 通る層 | 検査 |
|---|---|---|---|
| 1 | DB の `DEFAULT 720`（行を作るが列を指定しない場合） | DB | 常に妥当な値 |
| 2 | `examples/chat/src/archive-sweep-cost.ts` の生 SQL `INSERT`（bench 専用） | **DB だけ** | `archive-sweep-options.ts` の `parsePositiveFloat`（`Number.isFinite(v) && v > 0` を要求）で既に守られている |
| 3 | 🔴 `InMemoryTenantSettingsStore.setDefaultHalfLifeHours(tenantId, hours)`
    ——**テスト専用フック**（`TenantSettingsStore` interface のメンバーではない）。
    **修正前は検査が一切無かった。** | testkit | **無かった（今回追加）** |

⟹ **DB 以外から `default_half_life_hours` を渡す経路は、テスト専用フック1本だけだった。**
本番コードに、この値を任意に書き込める入口は存在しない（bench の生 SQL を除く）。

### 経路3: zod（`MemorySchema`/`NewMemorySchema`）

`halfLifeHours: z.number().positive()` は既に存在した。**実際に zod で確かめた
（`z.number().positive().safeParse()`、zod v4）:**

| 値 | 結果 |
|---|---|
| `0` | 拒否（`too_small`） |
| `-1` | 拒否（`too_small`） |
| `NaN` | 拒否（`invalid_type`。zod は `NaN` を `typeof === "number"` とは別に判定している） |
| `Infinity` / `-Infinity` | 拒否（`invalid_type`） |
| `5` | 通る |

⟹ **zod の宣言そのものは、値域の観点では既に正しい。** ただし ADR 0078 の実測3と
同じ理由で、**`MemorySchema`/`NewMemorySchema` を `.parse()` している箇所は
リポジトリに0件**（再検算した。定義2行のみ）。`runtime.ts` が実際に `.parse()` する
唯一のスキーマ（`ObserveInputSchema`）は `halfLifeHours` を持たない
——ユーザーは `observe()` 経由でこの値を注入できない。**⟹ zod を締める必要は無い
（既に締まっている）。締めても実行時には何も起きない（実測3の繰り返し）。**

---

## 決定

1. **`halfLifeHours` の値域を `(0, ∞)`（有限の正の実数）とする。**
   `isHalfLifeHoursInRange(value): boolean`（`value > 0 && Number.isFinite(value)`）を
   `packages/core/src/interfaces/tenant-settings-store.ts` に置き、`DEFAULT_HALF_LIFE_HOURS`
   と同じ場所から export する——**この値は `Memory.halfLifeHours` と
   `tenant_settings.default_half_life_hours` の両方で同じ意味を持つため**、1箇所に置く。

2. **0 を含めない。** `halfLifeHours = 0` は「即座に消える」という意味になりうるが、
   それは `strength` を下げる・`status: 'forgotten'` にする、という既存の経路が
   既に表現できる。**同じことを言う道を2つ作らない**（ADR 0078 決定3と同じ論法）。

3. **負を含めない。** half-life は「半分になるまでの時間」であり、負の時間は
   定義されない。実測（上記）のとおり、負の `halfLifeHours` は `decay` を `+Infinity`
   に発散させる経路そのものである。

4. **`Infinity` を含めない（上限は無限大未満、finite のみ）。**
   `halfLifeHours = Infinity` 自体は式の上では発散せず、`decay` を恒久的に `1`
   （「二度と減衰しない」）に固定するだけである——数学的には壊れていない。
   **それでも上限から除いたのは、「半減期」という語が本来有限の時間を指しており、
   無限の半減期という値をいま使う理由が無いためである。**
   **⚠ これは「ある壊れ方を防ぐための決定」ではなく「無限大の半減期を意味のある
   入力として認めない、という決定」である。** ADR 0078 が「迷ったら厳しい側に置く
   （緩めるのは後から非破壊、締めるのは後から破壊的）」と決めた判断をそのまま
   踏襲した。もし「二度と減衰しない Memory」を意図的に作りたい需要が出たら、
   それは本 ADR を見直す理由になる（下記「これが覆るとしたら」）。

5. **強制の責任は store（adapter）の層と DB CHECK に置く。ADR 0078 決定4と同じ論法。**
   - `packages/postgres`: `tenant_settings_default_half_life_range` と
     `memories_half_life_range` の2本の CHECK 制約（マイグレーション `0012`）。
   - `packages/testkit` の in-memory 実装: `InMemoryMemoryStore.createMemory`/
     `createMemoryWithOutbox` に `isHalfLifeHoursInRange(input.halfLifeHours)` の検査を足した。
   - `packages/testkit` の `InMemoryTenantSettingsStore.setDefaultHalfLifeHours`
     （テスト専用フック）にも同じ検査を足した——**修正前はここが唯一の無検査の
     書き込み経路だった**（経路2の表参照）。
   - **適合スイートに歯を2本置いた**（`memory-store-conformance.ts` の
     `createMemory は値域の外の halfLifeHours を拒む`、
     `tenant-settings-store-conformance.ts` の
     `値域の外の default_half_life_hours を拒む`）。これを adapter の契約にする。

6. **`packages/core` の `decay`/`scoring` の計算そのものは変えない。**
   下記「検討して採らなかった案」に理由を書く。

7. **マイグレーションは検証つきで足す（`NOT VALID` にしない）。⛔ 黙って丸めない。**
   既存行が値域の外に在れば、そこで**失敗する。** それは意図した振る舞いである
   ——ADR 0078 決定7と同じ理由。もし CI や利用者の DB に既に違反行が存在した場合、
   **このマイグレーションはそこで止まる。** それは「気づかずに壊れたランキングを
   出し続ける」よりましである、という判断そのものが決定の中身である。

8. **`TenantSettingsStore` interface には触れない。** `default_half_life_hours` を
   書く本番用のメソッド（`setDefaultHalfLifeHours` 相当）を新設しない。
   理由: (a) 現物で確認したとおり、いまこの値を書く本番経路は存在しない
   （経路2の表）。(b) interface に新しい必須メソッドを足すと、外部の
   `TenantSettingsStore` 実装者に対して破壊的になる（`docs/autonomy.md` §3
   「公開 API の破壊的変更は提起までにする」）。**この issue の受け入れ条件は
   「値域を塞ぐ」であって「新しい書き込み口を作る」ではない**——ついでに直さない。

---

## 検討して採らなかった案

- **`decay.ts`（`strengthAt`/`floorAt`）の内部で `halfLifeHours` を検査し、
  例外を投げる。** **却下。** [ADR 0036](./0036-clamp-freshness-at-one.md) が
  `freshness` の上限を `defaultDecayStrategy` の外（`scoring.ts`）に置いた理由と
  同じである——`floorAt` が `strengthAt(now) = threshold` の解析解として導かれ、
  両者が同じ式から機械的に一貫する、という ADR 0010 の性質を壊したくない。
  **加えて、`decay.ts` は「与えられた値をそのまま計算するだけの純関数」であり
  続けるべきで、値の由来（DB から来たのか、テストが直接組み立てたのか）を
  意識しない。値域の強制は「値が書き込まれる場所」に置くほうが、ADR 0078 が
  `strength` について確立した作法と一致する。**
- **`ScoringInput.halfLifeHours` を受け取った `scoring.ts` の側で clamp/検査する。**
  **却下。** `scoring.ts` はテナントごとの `halfLifeHours` を毎回読むだけの
  読み出し専用の消費者であり、ここで検査しても「既に壊れた値が保存されている」
  という事実は変わらない。**書き込みを止めるほうが先である**（ADR 0078 の
  「zod だけを締める」却下と同じ構造の教訓——読み出し側や型を締めても、
  書かれてしまった値は戻らない）。
- **`TenantSettingsStore` に `setDefaultHalfLifeHours` を新設し、そちらでも検査する。**
  **却下（決定8）。** 経路が存在しないものを新設するのは、この issue の受け入れ条件
  （値域を塞ぐ）を超える。**ついでに直さない。**
- **`Infinity` を許容範囲に含める**（「二度と減衰しない」を正式な設定として認める）。
  **却下（決定4）。** 需要を示す記述は `docs/` に見つからなかった
  （ADR 0078 が `strength` の上限を 1 に決めたときと同じ検索の型——
  `grep -rn "half.life\|halfLife" docs/` で「無限」「二度と減衰しない」に該当する
  記述は無かった）。
- **境界に float64 の ε を使う。** **却下。** ADR 0078 の実測（`strength` は `real`
  ＝ float4 であり `1 + Number.EPSILON` は格納時に丸められて CHECK を通る）と
  同じ罠がこの列にもある。適合スイートの歯は float4 でも float64 でも一致する
  値（整数）だけを境界の外側／内側に使った。

---

## 引き受ける負債・覆えていない範囲

- 🔴 **これは adapter の契約の変更である。** 適合スイートに歯が2本増えるため、
  **値域の外を受け入れていた第三者の adapter は、これから conformance に落ちる。**
  `0.x` なので semver 上は許されるが、`docs/autonomy.md` §3 は公開 API の
  破壊的変更を「提起までにする」としている。**⟹ ここに書いて提起する。取り込む
  判断はオーナーのものである。**
- **`scale-bench.ts` の生 SQL 経路は、DB の CHECK だけが守る。** 多層にはなっていない
  （ADR 0078 が `strength` について認めた同じ負債）。いま書いているのはリテラル
  `720` なので当たらないが、規律であって機構ではない。
- **`FakeMemoryStore`（`packages/core` のテスト用、適合スイートの対象外）には
  検査を入れていない。** ADR 0078 が `strength` について残した同じ手薄さが、
  `halfLifeHours` にもそのまま残る。
- 🔴 **DB 側の検証（CHECK が実際に `NaN`/`Infinity`/負/0 を拒み、既存行の走査が
  通ることの実測）は、この作業環境に Postgres が無いため一切できていない。**
  マイグレーション本文の `'Infinity'::real` によるトリックは PostgreSQL の
  ドキュメントに書かれた順序づけの仕様（`NaN` は他のすべての値より大きい）に
  基づく推論であり、**実行して確かめたものではない。CI の `packages/postgres` の
  ジョブが最初の実測の場になる。**
  （ADR 0078 は同じトリックを `strength`（`<= 1` という有限の上限）で使い、
  そちらは実際に PostgreSQL 16.15 で実測済みである。本 ADR の
  `< 'Infinity'::real` は形は同じだが**値そのものは実測していない**、という違いがある。）
- **既存データに違反行が実在するかどうかは確かめていない。** リポジトリ内の
  テスト・bench はすべて妥当な値（720 など）を書いているため、**このリポジトリの
  範囲では**マイグレーションは通るはずだが、**リポジトリ外の利用者の DB については
  確かめていない**（ADR 0078 が `strength` について書いた同じ限定と同じ形）。
- **`packages/testkit` の `setDefaultHalfLifeHours` フックへ検査を足したことで、
  この値を無効な値でテストしていた既存のテストが無いかは、`pnpm run test`
  （手元、DB 無し段）でしか確認できていない。** DB を要する `conformance.postgres.test.ts`
  経由の実行は確かめていない。

---

## これが覆るとしたら

- **オーナーが「二度と減衰しない Memory」を正式な機能として決めたとき。**
  そのときは決定4（`Infinity` を除く）を見直し、`Infinity` を許容範囲に含めるか、
  あるいは専用のフラグ（`decayFloorAt` を `null` にする等、別の表現）を検討する
  必要がある。**`Infinity` を許すほうへ緩める変更は非破壊である**（決定4のとおり
  緩める方向は後からできる）。
- **`TenantSettingsStore` に本番用の `setDefaultHalfLifeHours` 相当が必要になったとき。**
  決定8が対象外にした経路が実際に開くタイミングであり、そのときは
  `isHalfLifeHoursInRange` をそこでも呼ぶ必要がある（この ADR が置いた関数が
  そのまま使える設計にしてある）。
- **CI の `packages/postgres` ジョブが、この作業環境では確かめられなかった
  DB 側の実測（`'Infinity'::real` のトリックが実際に機能するか、既存行の
  走査が通るか）で赤くなったとき。** そのときは「引き受ける負債」節の推論が
  誤っていたことになり、マイグレーションの式を実測に基づいて書き直す。

---

## 確かめていないこと

- **DB 側の実測すべて**（上記「引き受ける負債」参照）。この作業環境に
  `DATABASE_URL` が無く、`packages/postgres` の歯・マイグレーションを実行できない。
- **`packages/core` の歯は実行して確かめた**（下記 PR 本文の「測ったこと」参照）。
  これは確かめていないことの対象外である。
