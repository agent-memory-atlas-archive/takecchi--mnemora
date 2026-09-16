# ADR 0196: `--locale=C` はどの encoding とも両立する — 表の誤りを実測で正し、`ANY_ENCODING` を入れる（Issue #395）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0132 / 0137 / 0179 / 0192 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `initdb`/`vitest` 等を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

**`scripts/initdb-args-lib.mjs` の `KNOWN_LOCALE_IMPLIED_ENCODING` は、`initdb` が実際に要求していることを記述しているか。**

【現物】この ADR の直前まで、表はこう書いていた:

```js
const KNOWN_LOCALE_IMPLIED_ENCODING = {
  C: "SQL_ASCII",
};
```

**そして同じファイルの docstring が、自分でその根拠の弱さを書いていた**（逐語）:

> **下の `KNOWN_LOCALE_IMPLIED_ENCODING` 表は、実際に `initdb` を実行して確かめたものではない。**この器には docker/podman/initdb が無く（`DATABASE_URL` も未設定）、ここで実行して検算することはできなかった。

⟹ **[ADR 0183](./0183-local-postgres-makes-postgres-mutation-testing-possible.md) で「手元に `initdb` が在る器」という前提が得られた。⟹ 検算できるようになったので、検算した。**

## 🔴 実測 — 表は誤っていた

【実測】2026-09-17。器: PostgreSQL **17.11** (Debian 17.11-0+deb13u1)、既定ロケール `POSIX`（`LC_CTYPE="POSIX"`）。
すべて `initdb -D <tmp> -U worker --auth=trust` に下の引数を足して実行し、exit code を見た。

| 引数                                                      | exit       |
| --------------------------------------------------------- | ---------- |
| `--locale=C --encoding=UTF8`                              | `0`        |
| `--locale=C --encoding=SQL_ASCII`                         | `0`        |
| `--locale=C --encoding=EUC_JP`                            | `0`        |
| `--locale=C --encoding=LATIN1`                            | `0`        |
| `--locale=POSIX --encoding=UTF8` / `SQL_ASCII` / `EUC_JP` | すべて `0` |

⟹ **`--locale=C` は encoding を1つも選んでいない。**`C: "SQL_ASCII"` は、`initdb` の要求の記述として**誤りである。**

⭐ **`POSIX` も同じだった**——Issue #395 本文は `POSIX` を測っていない。この ADR で足した。

### ⭐ ただし、この関数の前提そのものは生きている

**「`initdb` は encoding とロケールの整合を検査する」という docstring の前提は、`C` 系**以外**のロケールでは本当に成り立つ。**【実測】:

| 引数                                 | exit |
| ------------------------------------ | ---- |
| `--locale=C.utf8 --encoding=UTF8`    | `0`  |
| `--locale=C.utf8 --encoding=EUC_JP`  | `1`  |
| `--locale=C.utf8 --encoding=LATIN1`  | `1`  |
| `--locale=C.UTF-8 --encoding=EUC_JP` | `1`  |

落ちたときの出力（逐語）:

```
initdb: error: encoding mismatch
initdb: detail: The encoding you selected (EUC_JP) and the encoding that the selected locale uses (UTF8) do not match. This would lead to misbehavior in various character string processing functions.
initdb: hint: Rerun initdb and either do not specify an encoding explicitly, or choose a matching combination.
```

⟹ **壊れていたのは表の `C` の行だけであり、`findInconsistentLegs` という歯そのものではない。**⟹ **歯を消す判断にはならない。**

### ⚠ いま CI は1つも落ちていない

**この誤りは安全側（＝誤って赤）に倒れる。**【現物】いまの `.github/workflows/ci.yml` の `postgres` ジョブ matrix は2脚で、**どちらも変更の前後で通る**:

| 脚        | `initdbArgs`                      | 変更前                               | 変更後                 |
| --------- | --------------------------------- | ------------------------------------ | ---------------------- |
| UTF8      | `--encoding=UTF8`                 | 通る（既定ロケール → `UTF8` を含意） | 同じ                   |
| SQL_ASCII | `--encoding=SQL_ASCII --locale=C` | 通る（表どおり `SQL_ASCII`）         | 通る（`ANY_ENCODING`） |

⟹ **この ADR は「壊れているものを直す」ではない。**「**誰かが `--encoding=UTF8 --locale=C` の脚を足そうとしたとき、この歯が誤って赤くする**」を塞ぐものである。

## 決定

1. **`C` / `POSIX` を、「どの encoding とも両立する」を表す番兵 `ANY_ENCODING`（Symbol）にする。**
   `impliedEncodingForLocale("C")` は `"SQL_ASCII"` ではなく `ANY_ENCODING` を返す。
   `findInconsistentLegs` は `ANY_ENCODING` の脚を**挙げない。**
2. **番兵を encoding 名の文字列にしない。** `"ANY"` のような文字列にすると「その名の encoding を含意する」と区別がつかない。**Symbol なら衝突しようがない。**
3. **`KNOWN_LOCALE_IMPLIED_ENCODING` には `C.utf8` / `C.UTF-8` → `UTF8` を入れる。**
   上の実測（`initdb` 自身が `the encoding that the selected locale uses (UTF8)` と名指しし、`--encoding=UTF8` なら exit `0`）で確かめた値だけを入れる。
4. **docstring の「⚠ 確かめていないこと」を「✅ 検算した」に書き換え、実測の表を載せる。**
   ⛔ **実測した結果を、確かめていないままにしない**（Issue #395 の「やってほしいこと 3」が名指しした規律）。
5. **⛔ `.github/workflows/ci.yml` を1バイトも変えない。** Issue #395 が「`ci.yml` の matrix を変えるかどうかとは分けて決めること」と書いている。上の表のとおり、**変えなくても両脚は通る。**
6. **⛔ `DEFAULT_LOCALE_IMPLIED_ENCODING = "UTF8"` を動かさない。**

## 採らなかった案

- **案A: 表の意味を「`ci.yml` の脚として意図した encoding」へ読み替え、docstring のほうを直す**（Issue #395 の「やってほしいこと 2」）。
  ⛔ 採らない。**そう読み替えると、関数名（`impliedEncodingForLocale`）と返す値の意味が食い違う。**そして「意図した encoding」は `ci.yml` の `serverEncoding` 欄そのものであり、**同じ情報を2箇所に持つことになる。**
- **案B: 何もせず docstring だけ直す**（同「やってほしいこと 3」）。
  ⛔ 採らない。**誤った表を残す理由が無い。**実測で正しい値が分かっている。
- **案C: `DEFAULT_LOCALE_IMPLIED_ENCODING` も一緒に検算して直す。**
  ⛔ 採らない。**測った器の既定ロケールは `POSIX` で、CI のコンテナ（`en_US.utf8` とされる）と違う。**⟹ **ここで測っても CI のコンテナについて何も言っていない。**⚠ `en_US.utf8` はこの器に存在せず、`initdb` が `invalid locale name "en_US.utf8"` で落ちる【実測】ので、**この器では測りようがない。**
- **案D: 「選んだ encoding が `SQL_ASCII` なら常に通る」もモデル化する。**
  ⛔ 採らない。理由は下の「引き受けた負債」。

## 引き受けた負債

### (a) Issue #162 E3 相当の変異が、この歯では挙がらなくなる

【現物】既存のテストは「UTF8 脚に `--locale=C` を足す」を **挙げるべき変異**（`MUTATED_E3`）として置いていた。**この ADR でそれは挙がらなくなる。**

**理由は「歯を緩めたから」ではなく、その変異が実際には `initdb` を落とさないからである**【実測】（`--locale=C --encoding=UTF8` → exit `0`）。⟹ **挙げるのは偽陽性であり、この関数が宣言している契約（「脚が自己無矛盾か」＝ コンテナの起動ごと落ちるか）の外である。**

⚠ **ただし `--locale=C` は collation を変える。**【現物】`ci.yml` は「⛔ ロケール（LANG / LC_COLLATE / LC_CTYPE）は宣言しない。**まだ測っていない**からである」と自分で明記している。⟹ **collation の regime はいまどの歯も見ていない。**この ADR はそこを広げない——**広げるなら、測ってから別の歯を立てること。**

### (b) 「`SQL_ASCII` は常に通る」を取り込んでいない

【実測】`--locale=C.utf8 --encoding=SQL_ASCII` は exit `0` である——**`C.utf8` が UTF8 を含意するにもかかわらず通る。**⟹ `initdb` は「選んだ encoding が `SQL_ASCII`」の場合にも整合検査を免除している。

**取り込まない。**取り込むと、**未知のロケール + `SQL_ASCII` の脚が挙がらなくなり**、同ファイルが明記する「⛔ 未知のロケールは『わかったことにして通す』より安全側（＝挙げる）に倒す」が崩れる。⟹ **その分だけこの歯は過剰に挙げる（＝安全側）。**⛔ **誤って緑になる向きの取りこぼしではない。**

## 歯が噛むことを示した（変異試験）

【実測】2026-09-17、`npx vitest run scripts/__tests__/initdb-args-lib.test.mjs scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs`（無変異で 44 tests / 2 files すべて緑）。
**変異は `cp` で退避・`cp` で戻した**（`AGENTS.md`「⛔ 変異を戻すのに `git checkout` を使わない」）。

| 変異                                                                                 | 結果                                                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| M1: `ANY_ENCODING` の枝を消し、表を `C: "SQL_ASCII"` へ戻す（＝この ADR 以前の挙動） | **3 tests 赤**                                                                              |
| M2: `findInconsistentLegs` が `ANY_ENCODING` を「未知」として挙げる                  | **3 tests 赤**（⭐ `ci.yml` を実際に読む側の歯も赤くなる＝**本物の SQL_ASCII 脚が挙がる**） |
| M3: `POSIX` を `ENCODING_AGNOSTIC_LOCALES` から落とす                                | **2 tests 赤**                                                                              |
| M4: `C.utf8` の行を表から落とす                                                      | **1 test 赤**                                                                               |
| 4つとも `cp` で戻す                                                                  | **44 tests 緑に戻る**、`git status --porcelain` が変異を含まないことを確認                  |

## これが覆るとしたら、何が起きたとき

- **`initdb` の整合検査の規則が版で変わったとき。**【実測】は PostgreSQL 17.11 の1版だけである。⟹ **他の版で `--locale=C --encoding=UTF8` が落ちるなら、決定1 は覆る。**
- **`ci.yml` が collation の regime を宣言・測定し始めたとき。**負債 (a) がそのまま「この歯では守れない」という形で表に出る。⟹ **別の歯が要る。**
- **`ci.yml` が `--no-locale` / `--lc-collate=` / `--lc-ctype=` を使い始めたとき。**同ファイルが「扱っていない書き方」として既に挙げている（いずれも安全側＝赤に倒れる）。⟹ **実測してから広げること。**

## 確かめていないこと

- **`DEFAULT_LOCALE_IMPLIED_ENCODING = "UTF8"` は検算していない**（案C）。
- **PostgreSQL 17.11 以外の版で測っていない。**
- **`--no-locale` / `--lc-collate=` / `--lc-ctype=` は測っていない。**
- **`en_US.utf8` の含意する encoding は測れていない**（この器にそのロケールが無い【実測】）。⟹ 表に足していない＝いまも「未知」として挙がる。
- **`--locale=C` が実際の CI コンテナ（`pgvector/pgvector:pg17`）でも同じ挙動をするかは測っていない。**上の実測は Debian 13 の `postgresql-17` パッケージに対するものである。
- **`C` / `POSIX` 以外に `ANY_ENCODING` 扱いすべきロケールが在るかは調べていない。**

## 参照

- [Issue #395](https://github.com/takecchi/mnemora/issues/395) — この ADR の出所
- [ADR 0183](./0183-local-postgres-makes-postgres-mutation-testing-possible.md) — 手元に `initdb` が在る器が見つかった記録。検算できるようになった理由
- [ADR 0105](./0105-postgres-regime-matrix.md) / [ADR 0106](./0106-ci-declares-the-regime-it-measures.md) — `server_encoding` の matrix と SQL_ASCII サポートの決定
- Issue #162 — `initdb-args-lib.mjs` を足した経緯（E1 / E2 / E3 の変異）
- [Issue #247](https://github.com/takecchi/mnemora/issues/247) — 「器に道具が無くて確かめられない」の族
