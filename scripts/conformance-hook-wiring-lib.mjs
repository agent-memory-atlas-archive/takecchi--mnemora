/**
 * **適合テスト（conformance）の呼び出し側が、任意フックを実際に渡しているか**を
 * ソースから読み取る純関数（Issue #184 の追測）。
 *
 * ## なぜ要るか
 *
 * `packages/testkit/src/tenant-settings-store-conformance.ts` は
 *
 * ```ts
 * if (setDefaultHalfLifeHours) {
 *   it("…", async () => { … });
 * }
 * ```
 *
 * という形で**2本の歯を条件付きで登録する**。⟹ 🔴 **フックを渡さない呼び出し側に
 * 対しては、この2本は `it.skip` にすらならず、登録すらされない。**
 * ⟹ **テストの出力から「無い」ことが1ミリも分からない。**
 *
 * 現在の呼び出し側2つ（`packages/postgres` と `packages/testkit` の in-memory）は
 * どちらも渡しているので、**いまは実測されている**（＝ Issue #184 の A ではない）。
 * この歯が守るのは**将来**である——setter を持たない adapter が来て、フックを省いた
 * 瞬間に**2本が黙って消える**のを赤で捕まえる。
 *
 * ## ⛔ なぜ型を必須にしないのか（この判断の経緯を残す）
 *
 * 本来は `memory-store-conformance.ts` の `supportsSupersedeWithNewMemories`
 * （**必須の `boolean`**。`false` なら `expect(store.supersedeWithNewMemories).toBeUndefined()`
 * を積極的に assert し、⛔ `it.skip` にはしない——`docs/autonomy.md`）と揃えて、
 * `setDefaultHalfLifeHours` も**必須のフラグ**にするのが正しい形である。
 *
 * ⛔ **しかし `@mnemora/testkit` は npm に公開済み**（`private` は立っておらず
 * `publishConfig.access: "public"`、registry の `dist-tags.latest` は `0.1.5`）。
 * ⟹ 必須化は**実在する公開パッケージへの破壊的変更**であり、**版を上げる判断は
 * オーナーの領域**である。
 *
 * ⟹ ⭐ **だからここでは型を1バイトも変えず、「呼び出し側が渡していること」を測る歯で
 * 代替した。**次に版を上げる機会が来た人が、そのとき必須化できる。
 *
 * ## ⚠ この網が扱っていないもの
 *
 * - **`${…}` の中に文字列があり、その文字列が `}` を含む**場合（例:
 *   `` `${s.replace("}", "")}` ``）、補間の終わりを取り違える。いまのソースには無い。
 * - **動的な呼び出し**（`const f = describeX; f({…})`）は見つけられない。
 * - **オブジェクト以外の引数**（変数を1つ渡す `describeX(opts)`）は
 *   「フックの有無が読めない」として**挙げる（赤）**——⛔ 「読めない」を緑で通さない。
 */

/**
 * コメント・文字列リテラル・テンプレートリテラルを**同じ長さの空白へ潰す**
 * （改行は残す）。⟹ 以降の括弧の深さ勘定が、SQL のテンプレートリテラルや
 * 地の文のコメントに撹乱されない。
 *
 * 🔴 **これを通さないと、地の文のコメントがフック名を引用しているだけで
 * 「渡している」と読んでしまう**（PR #161 が `ci.yml` で踏んだのと同じ形の欠陥）。
 *
 * ⚠ `scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs` と
 * `scripts/__tests__/example-chat-local-embedding-cache-dir-wiring.test.mjs` が
 * それぞれ持っている `blankOutComments` と**同じ思想の別実装**である（あちらは文字列を
 * 潰さないので括弧の深さを数えられない）。⛔ **あの2本を書き換えて統合していない**——
 * この PR の範囲外の歯に手を入れることになるため。統合するなら別途。
 *
 * @param {string} source
 * @returns {{ text: string, unhandled: string[] }} `unhandled` は閉じていない
 *   コメント/リテラルの断片。🔴 呼び出し側はこれを無視できない（空回りの検出点）。
 */
export function blankOutCommentsAndLiterals(source) {
  /** @type {string[]} */
  const unhandled = [];
  const out = [];
  let i = 0;
  const n = source.length;
  /** @param {number} from @param {number} to */
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) {
      out.push(source[k] === "\n" ? "\n" : " ");
    }
  };
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      let end = source.indexOf("\n", i);
      if (end === -1) {
        end = n;
      }
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) {
        unhandled.push(source.slice(i, Math.min(n, i + 80)));
        blank(i, n);
        i = n;
        continue;
      }
      blank(i, end + 2);
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = findQuoteEnd(source, i + 1, ch);
      if (end === -1) {
        unhandled.push(source.slice(i, Math.min(n, i + 80)));
        blank(i, n);
        i = n;
        continue;
      }
      out.push(ch);
      blank(i + 1, end);
      out.push(ch);
      i = end + 1;
      continue;
    }
    if (ch === "`") {
      const end = findTemplateEnd(source, i + 1);
      if (end === -1) {
        unhandled.push(source.slice(i, Math.min(n, i + 80)));
        blank(i, n);
        i = n;
        continue;
      }
      out.push("`");
      blank(i + 1, end);
      out.push("`");
      i = end + 1;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return { text: out.join(""), unhandled };
}

/**
 * @param {string} s @param {number} from @param {string} quote
 * @returns {number} 閉じ引用符の位置。無ければ -1
 */
function findQuoteEnd(s, from, quote) {
  for (let i = from; i < s.length; i += 1) {
    if (s[i] === "\\") {
      i += 1;
      continue;
    }
    if (s[i] === quote) {
      return i;
    }
    if (s[i] === "\n") {
      return -1;
    }
  }
  return -1;
}

/**
 * テンプレートリテラルの終わり（閉じバッククォート）を探す。`${ … }` の補間は
 * 中身ごと読み飛ばす（波括弧の対応だけを数える。上の「扱っていないもの」参照）。
 *
 * @param {string} s @param {number} from
 * @returns {number} 閉じバッククォートの位置。無ければ -1
 */
function findTemplateEnd(s, from) {
  for (let i = from; i < s.length; i += 1) {
    if (s[i] === "\\") {
      i += 1;
      continue;
    }
    if (s[i] === "`") {
      return i;
    }
    if (s[i] === "$" && s[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === "{") {
          depth += 1;
        } else if (s[i] === "}") {
          depth -= 1;
        }
        i += 1;
      }
      i -= 1;
    }
  }
  return -1;
}

/**
 * `fnName(…)` という**呼び出し**を全部拾い、その引数がオブジェクトリテラルなら
 * **最上位のプロパティ名の集合**を返す。
 *
 * ⛔ `import { fnName } from …` は拾わない（直後が `(` ではないため）。
 * ⛔ `obj.fnName(…)` も拾わない（直前が `.` のため）。
 * ⛔ **宣言そのもの**（`export function fnName(options: …)`）も拾わない——直前の語が
 *    `function` のときは飛ばす。⟹ 定義ファイル自身を「引数が読めない呼び出し」として
 *    誤って挙げない。
 *
 * @param {string} source コメント/リテラルを潰す前の生ソース
 * @param {string} fnName
 * @returns {{ line: number, keys: string[] | undefined }[]}
 *   `keys` が `undefined` なのは「引数がオブジェクトリテラルでない（読めない）」場合。
 */
export function findConformanceCalls(source, fnName) {
  const { text } = blankOutCommentsAndLiterals(source);
  /** @type {{ line: number, keys: string[] | undefined }[]} */
  const calls = [];
  const needle = `${fnName}(`;
  let at = text.indexOf(needle);
  while (at !== -1) {
    const before = at === 0 ? "" : text[at - 1];
    const isDeclaration = /\bfunction\s*$/.test(text.slice(Math.max(0, at - 40), at));
    if (!/[A-Za-z0-9_$.]/.test(before) && !isDeclaration) {
      const open = at + needle.length - 1;
      const close = findMatching(text, open, "(", ")");
      const line = text.slice(0, at).split("\n").length;
      if (close === -1) {
        calls.push({ line, keys: undefined });
      } else {
        calls.push({ line, keys: topLevelObjectKeys(text.slice(open + 1, close)) });
      }
    }
    at = text.indexOf(needle, at + needle.length);
  }
  return calls;
}

/**
 * @param {string} s @param {number} from 開き記号の位置
 * @param {string} openCh @param {string} closeCh
 * @returns {number} 対応する閉じ記号の位置。無ければ -1
 */
function findMatching(s, from, openCh, closeCh) {
  let depth = 0;
  for (let i = from; i < s.length; i += 1) {
    if (s[i] === openCh) {
      depth += 1;
    } else if (s[i] === closeCh) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * 引数テキストが**単一のオブジェクトリテラル**なら、その最上位のプロパティ名を返す。
 * そうでなければ `undefined`（＝「読めない」）。
 *
 * ⭐ **深さ1のキー位置**（`{` の直後、または深さ1の `,` の直後）に現れる識別子だけを
 * 拾う。⟹ 入れ子のオブジェクトの中に同名のキーが在っても「渡している」とは読まない。
 * 省略記法（`{ setDefaultHalfLifeHours }`）も拾う。
 *
 * @param {string} argText
 * @returns {string[] | undefined}
 */
function topLevelObjectKeys(argText) {
  const start = argText.indexOf("{");
  if (start === -1 || argText.slice(0, start).trim() !== "") {
    return undefined;
  }
  const end = findMatching(argText, start, "{", "}");
  if (end === -1 || argText.slice(end + 1).trim() !== "") {
    return undefined;
  }
  const body = argText.slice(start + 1, end);
  /** @type {string[]} */
  const keys = [];
  let depth = 0;
  let atKeyPosition = true;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
      atKeyPosition = false;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && ch === ",") {
      atKeyPosition = true;
      continue;
    }
    if (!atKeyPosition || depth !== 0) {
      continue;
    }
    if (/\s/.test(ch)) {
      continue;
    }
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(i));
    if (match === null) {
      atKeyPosition = false;
      continue;
    }
    keys.push(match[0]);
    atKeyPosition = false;
    i += match[0].length - 1;
  }
  return keys;
}

/**
 * `fnName(…)` の呼び出しのうち、**`hookName` を渡していないもの**を挙げる。
 * 引数が読めないもの（オブジェクトリテラルでない）も挙げる——⛔「読めない」を
 * 緑で通さない。
 *
 * @param {string} source
 * @param {string} fnName
 * @param {string} hookName
 * @returns {{ line: number, reason: string }[]}
 */
export function findCallsMissingHook(source, fnName, hookName) {
  return findConformanceCalls(source, fnName).flatMap((call) => {
    if (call.keys === undefined) {
      return [
        {
          line: call.line,
          reason:
            `${fnName}(…) の引数がオブジェクトリテラルとして読めない` +
            `（変数を渡している等）。⟹ ${hookName} を渡しているか判定できないので挙げている。`,
        },
      ];
    }
    if (call.keys.includes(hookName)) {
      return [];
    }
    return [
      {
        line: call.line,
        reason: `${fnName}(…) が ${hookName} を渡していない（渡しているキー: ${call.keys.join(", ")}）。`,
      },
    ];
  });
}
