/**
 * `initdbArgs`(`--encoding=` / `--locale=`)が**自己無矛盾**かどうかを判定する純関数
 * (Issue #162 E)。
 *
 * ## 何を測るか
 *
 * `.github/workflows/ci.yml` の `postgres` ジョブは `server_encoding` の matrix
 * (`UTF8` / `SQL_ASCII`)を持ち、各脚は `initdbArgs` に `--encoding=` と(要る脚だけ)
 * `--locale=` を書く。`ci.yml` のコメント(SQL_ASCII 脚のすぐ上)が述べる通り、
 * **initdb は「選んだ encoding」と「ロケールが含意する encoding」の整合を検査する**
 * ——食い違うとコンテナの起動ごと落ちる。
 *
 * `scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs` の既存の (c) は
 * `--encoding=` の値と `leg.serverEncoding` の一致だけを見ており、`--locale=` の値は
 * どの歯も検査していなかった(Issue #162 E)。⟹ `--locale=C` を落としても・
 * 他のロケールへ挿げ替えても・UTF8 脚に足しても、既存の歯は気づかない。
 *
 * ## ✅ 検算した(Issue #395 / ADR 0196)
 *
 * **かつてここには「下の表は initdb を実行して確かめたものではない」と書いてあった。**
 * ADR 0183 で手元に `initdb` が在る器が見つかったので、**実際に走らせて検算した。**
 *
 * 【実測】2026-09-17、PostgreSQL 17.11 (Debian 17.11-0+deb13u1)、既定ロケール `POSIX`:
 *
 * | 引数 | exit |
 * |---|---|
 * | `--locale=C --encoding=` {`UTF8`,`SQL_ASCII`,`EUC_JP`,`LATIN1`} | すべて `0` |
 * | `--locale=POSIX --encoding=` {`UTF8`,`SQL_ASCII`,`EUC_JP`} | すべて `0` |
 * | `--locale=C.utf8 --encoding=UTF8` | `0` |
 * | `--locale=C.utf8 --encoding=EUC_JP` | `1`(`initdb: error: encoding mismatch`) |
 * | `--locale=C.utf8 --encoding=LATIN1` | `1`(同上) |
 *
 * ⟹ **`C` / `POSIX` はどの encoding とも両立する。**かつての表は `C: "SQL_ASCII"` と
 * 書いており、**それは誤りだった**(Issue #395)。
 *
 * ⭐ **一方、この関数の前提そのものは生きている**——`C` 系**以外**のロケールでは、
 * initdb は本当に整合を検査して落ちる(上の `C.utf8` × `EUC_JP`/`LATIN1`)。逐語:
 *
 * ```
 * initdb: error: encoding mismatch
 * initdb: detail: The encoding you selected (EUC_JP) and the encoding that the
 *   selected locale uses (UTF8) do not match.
 * ```
 *
 * ## ⚠ それでも確かめていないこと
 *
 * - **`DEFAULT_LOCALE_IMPLIED_ENCODING = "UTF8"` は検算していない。**その根拠は
 *   「CI のコンテナの既定ロケールが `en_US.utf8`」であり、**上の実測をした器の既定
 *   ロケールは `POSIX`(CI のコンテナと違う)**。⟹ **ここで `--locale=` 無しを測っても、
 *   CI のコンテナについて何も言っていない。**⛔ この行を「ついでに」動かさないこと。
 * - **PostgreSQL 17.11 以外の版で測っていない。**
 * - **`--no-locale` / `--lc-collate=` / `--lc-ctype=` は測っていない**(下の「扱って
 *   いない書き方」)。
 * - **`en_US.utf8` は測れていない**——実測した器にそのロケールが無く、initdb が
 *   `invalid locale name` で落ちる【実測】。⟹ 下の表に足していない。
 *
 * ## ⛔ 「選んだ encoding が SQL_ASCII なら常に通る」はモデル化していない
 *
 * 【実測】`--locale=C.utf8 --encoding=SQL_ASCII` は exit `0` である——**`C.utf8` が
 * UTF8 を含意するにもかかわらず通る。**⟹ initdb は「選んだ encoding が SQL_ASCII で
 * ある」場合にも整合検査を免除している。
 *
 * **この関数はそれを意図的に取り込んでいない。**取り込むと、未知のロケール +
 * `SQL_ASCII` の脚が挙がらなくなり、下の「未知のロケールは安全側に倒す」が崩れる。
 * ⟹ **その分だけこの歯は過剰に挙げる(＝安全側)。**ADR 0196「引き受けた負債」。
 *
 * ## ⛔ `--locale=C` を無条件に要求しない
 *
 * UTF8 脚には `--locale=` が無いのが正しい(既定ロケールが UTF8 を含意するため)。
 * この関数は「`--locale=` が有ることを要求する」のではなく、**「脚が自己無矛盾で
 * あること」だけを見る**(既存の (c) と同じ向き)。
 *
 * ## ⚠ 扱っていない書き方(いずれも**安全側＝赤**に倒れる)
 *
 * `--locale=` **以外**でロケールを決める書き方は解釈していない。いま `ci.yml` が
 * 使っているのが `--locale=` だけだからである:
 *
 * - `--no-locale`(= `--locale=C` と同義) ⟹ この関数は「ロケール指定なし」と読み、
 *   `UTF8` を含意すると判定する。⟹ SQL_ASCII 脚に付けると**誤って赤くなる**。
 * - `--lc-collate=` / `--lc-ctype=` を `--locale=` の代わりに使う書き方 ⟹ 同上。
 *
 * ⛔ **誤って緑になる向きの取りこぼしではない**(どちらも赤に倒れる)。`ci.yml` が
 * これらを使い始めたら、**実測してから**この関数を広げること(⛔ 歯を消さないこと)。
 *
 * ## ⛔ 未知のロケールは「わかったことにして通す」より安全側(=挙げる)に倒す
 *
 * `KNOWN_LOCALE_IMPLIED_ENCODING` に無いロケールが出てきたら、含意する encoding が
 * わからない。「わからない」を緑で通すと、誰かが新しいロケールを足したときに実測
 * せず素通りしてしまう。⟹ **未知のロケールは挙げる(赤)**——表に実測を足してから
 * 緑にすること。
 */

/**
 * **どの encoding とも両立するロケール**を表す番兵(Issue #395 / ADR 0196)。
 *
 * ⛔ **encoding 名の文字列にしない**——`"SQL_ASCII"` のような値にすると、
 * 「`SQL_ASCII` を含意する」と区別がつかなくなる。Symbol なら衝突しようがない。
 */
export const ANY_ENCODING = Symbol("ANY_ENCODING");

/**
 * **initdb が整合検査を掛けないロケール**(＝ どの encoding とも両立する)。
 * 【実測】2026-09-17。docstring の「検算した」表を見ること。
 *
 * @type {Set<string>}
 */
const ENCODING_AGNOSTIC_LOCALES = new Set(["C", "POSIX"]);

/**
 * 既知のロケール文字列 → initdb が要求する encoding。網羅ではない
 * (docstring の「それでも確かめていないこと」を見ること)。
 *
 * ⚠ **ここに載るのは「特定の encoding を含意する」ロケールだけである。**
 * `C` / `POSIX` が無いのは表から漏れているのではなく、**含意しない**からである
 * (上の `ENCODING_AGNOSTIC_LOCALES` 側に在る)。
 *
 * 【実測】`C.utf8` / `C.UTF-8` が UTF8 を含意することは、initdb 自身のエラー本文
 * (`the encoding that the selected locale uses (UTF8)`)と、`--encoding=UTF8` を
 * 渡したときの exit `0` の両方で確かめた。
 *
 * @type {Record<string, string>}
 */
const KNOWN_LOCALE_IMPLIED_ENCODING = {
  "C.utf8": "UTF8",
  "C.UTF-8": "UTF8",
};

/** `--locale=` が無い(既定ロケール)ときに含意される encoding。 */
const DEFAULT_LOCALE_IMPLIED_ENCODING = "UTF8";

/**
 * `initdbArgs` 文字列から `--encoding=` / `--locale=` の値を取り出す。
 *
 * @param {string} initdbArgs 例: `"--encoding=SQL_ASCII --locale=C"`
 * @returns {{ encoding: string | undefined, locale: string | undefined }}
 */
export function parseInitdbArgs(initdbArgs) {
  const encodingMatch = /--encoding=([^\s"]+)/.exec(initdbArgs);
  const localeMatch = /--locale=([^\s"]+)/.exec(initdbArgs);
  return {
    encoding: encodingMatch?.[1],
    locale: localeMatch?.[1],
  };
}

/**
 * ロケール指定(`--locale=` の値。無ければ `undefined`)から、initdb が要求する
 * encoding を返す。
 *
 * - **どの encoding とも両立するロケール**(`C` / `POSIX`)は `ANY_ENCODING` を返す
 *   (Issue #395。【実測】docstring の「検算した」表)。
 * - **未知のロケールは `undefined`(「わからない」)を返す**——「わかったことにして
 *   通す」より安全な側に倒すため。
 *
 * @param {string | undefined} locale
 * @returns {string | typeof ANY_ENCODING | undefined}
 */
export function impliedEncodingForLocale(locale) {
  if (locale === undefined) {
    return DEFAULT_LOCALE_IMPLIED_ENCODING;
  }
  if (ENCODING_AGNOSTIC_LOCALES.has(locale)) {
    return ANY_ENCODING;
  }
  return KNOWN_LOCALE_IMPLIED_ENCODING[locale];
}

/**
 * matrix の脚のうち、`--locale=` が含意する encoding と `serverEncoding` が
 * 食い違っている(=自己矛盾している)ものを挙げる。ロケールが未知で含意する
 * encoding がわからない脚も挙げる。
 *
 * @param {{ serverEncoding: string, initdbArgs: string }[]} legs
 * @returns {{ serverEncoding: string, initdbArgs: string, reason: string }[]}
 */
export function findInconsistentLegs(legs) {
  /** @type {{ serverEncoding: string, initdbArgs: string, reason: string }[]} */
  const flagged = [];
  for (const leg of legs) {
    const { locale } = parseInitdbArgs(leg.initdbArgs);
    const implied = impliedEncodingForLocale(locale);
    if (implied === ANY_ENCODING) {
      // どの encoding とも両立するロケール(`C` / `POSIX`)。initdb は整合検査を
      // 掛けない【実測】⟹ この脚は自己矛盾しえない(Issue #395 / ADR 0196)。
      continue;
    }
    if (implied === undefined) {
      flagged.push({
        ...leg,
        reason:
          `--locale=${locale} が何の encoding を含意するか、この歯には分からない` +
          "(KNOWN_LOCALE_IMPLIED_ENCODING に無いロケール)。新しいロケールを足したなら、" +
          "initdb を実測してから上の表に加えること。",
      });
      continue;
    }
    if (implied !== leg.serverEncoding) {
      flagged.push({
        ...leg,
        reason:
          `--locale=${locale ?? "(無し・既定ロケール)"} は encoding=${implied} を含意するが、` +
          `この脚の serverEncoding は ${leg.serverEncoding} である。initdb は encoding と` +
          "ロケールの整合を検査するため、この脚は実際の CI でコンテナの起動ごと落ちうる。",
      });
    }
  }
  return flagged;
}
