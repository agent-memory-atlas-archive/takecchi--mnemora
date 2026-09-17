/**
 * PR タイトル／本文が、**このブランチ自身が名乗って、このブランチ自身が捨てた** ADR 番号を
 * 名指ししていないかを判定する純関数群。
 *
 * ## 何を塞ぐか
 *
 * `scripts/adr-renumber.mjs`（ADR 0179）はマージ直前に ADR の番号衝突を解消し、
 * ファイル名・見出し・このブランチが追加した行の参照を機械的に書き換える。だが
 * **GitHub 側の状態（PR タイトルと PR 本文）は書き換えられない**。
 * `scripts/adr-renumber-lib.mjs` の `renumberedReferenceWarning()` は、付け替えが
 * 起きたときに「タイトルと本文の両方を直せ」と促す——が、それは**人が読んで動く**
 * ことに依拠した警告であり、機械の門ではない（この repo は
 * `squash_merge_commit_title=PR_TITLE` / `squash_merge_commit_message=PR_BODY` の
 * ため、直し忘れた番号はそのまま squash commit のタイトル・本文として `main` の履歴に
 * 永久に残る）。この lib は、その「人が読み飛ばした」を CI が検出するための判定を持つ。
 *
 * ## 判定の芯
 *
 * - **`abandonedNumbers`** = 「このブランチが `docs/decisions/` 配下で一度でも
 *   名乗った ADR 番号」から「いま `origin/main` に対してこのブランチが追加している
 *   ADR 番号」を引いたもの。
 * - PR の**タイトル**または**本文**が、`abandonedNumbers` のいずれかを
 *   `ADR <番号>` か `<番号>-<slug>`（ファイル名・URL の形）で含んでいたら違反。
 *
 * ### ⚠ この規則は偽陽性を出さない
 *
 * [ADR 0200](../docs/decisions/0200-adr-renumber-warns-when-titles-need-fixing.md) が
 * 検算した通り、「PR タイトルに `ADR NNNN` が出現するか」を素朴に repo 全体・全履歴に
 * 対して検査すると、偽陽性率は約87%になる（既存 ADR を根拠として文中で引用している
 * だけの言及を、大量に「紛れ」と誤検出する）。**この lib はその轍を踏まない**——
 * 見るのは「**このブランチが自分で名乗って、自分で捨てた**番号」だけである。他の ADR
 * （このブランチが一度も `docs/decisions/` 配下で名乗ったことのない番号）への言及は、
 * それがどれだけ本文中に出現しても `abandonedNumbers` に入らないので、一切引っかから
 * ない。**この対象範囲の絞り方そのものが、既存 ADR への正当な参照を誤検出しない
 * 根拠である**——`adr-renumber-lib.mjs` の docstring が「repo 全体を grep すると
 * 正当な言及が多数見つかる」と書いているのと同じ問題意識に対する、この lib の答え。
 *
 * ## この lib が扱わないこと（呼び出し側の責務）
 *
 * この lib は git を一切呼ばない。「このブランチが名乗った ADR 番号」「いま追加して
 * いる ADR 番号」は、どちらも呼び出し側（`scripts/check-pr-adr-reference.mjs`）が
 * `git log` / `git diff` の出力を `docs/decisions/*.md` のファイル名から4桁番号へ
 * 分解して渡す（`scripts/adr-renumber.mjs` の `adrNumbersFromRef` /
 * `loadAddedAdrFiles` と同じ分解を使う——`generate-adr-index-lib.mjs` の
 * `isAdrFilename` と `adr-renumber-lib.mjs` の `parseAdrFilename` を再利用する）。
 */

/**
 * 「このブランチが一度でも名乗った ADR 番号」から「いま追加している ADR 番号」を
 * 引いた差分を返す——**このブランチが自分で名乗って、自分で捨てた番号**の集合。
 *
 * 入力・出力とも4桁ゼロ埋めの番号文字列（例: `"0199"`）。重複は除き、`claimedNumbers`
 * に現れた順序を保つ。
 *
 * @param {Iterable<string>} claimedNumbers このブランチのコミット履歴が
 *   `docs/decisions/` 配下で**削除した**ADR ファイルの番号（重複可・順不同可）。
 *   🔴 **「触った」ではない**——既存の ADR に追記するだけの PR は何も手放していないので、
 *   ここには1件も入らない（2026-09-17 の訂正。ADR 0211 の追記。集め方は
 *   `scripts/check-pr-adr-reference.mjs` の `loadRelinquishedNumbers()`）。
 * @param {Iterable<string>} addedNumbers いま `origin/main` に対してこのブランチが
 *   追加している ADR ファイルの番号
 * @returns {string[]}
 */
export function abandonedNumbers(claimedNumbers, addedNumbers) {
  const added = new Set(addedNumbers);
  const seen = new Set();
  const result = [];
  for (const n of claimedNumbers) {
    if (added.has(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    result.push(n);
  }
  return result;
}

/**
 * 1つのテキスト（PR タイトルまたは本文）の中に、`abandonedNumberList` のいずれかへの
 * 参照が含まれているかを探す。探す形は2つ（`rewriteReferencesInText` が書き換える形と
 * 同じ2形を、書き換えではなく検出のために使う）:
 *
 * 1. `ADR <番号>` — 見出し・本文中の言及（直後が数字でないことを確認）
 * 2. `<番号>-<slug 相当の文字列>` — ファイル名・URL の形。書き換え側
 *    （`rewriteReferencesInText`）と違い、**具体的な旧 slug を知らなくても検出できる
 *    よう、slug 部分は「英小文字・数字・ハイフンの並び」であれば何でもマッチする**
 *    ——`abandonedNumbers` の絞り込み自体が誤検出を防いでいるので、slug の厳密一致は
 *    不要（誤って別件の `NNNN-何か` を拾う確率は、番号がこのブランチの「捨てた番号」に
 *    一致するという時点で無視できるほど低い）。
 *
 * 裸の4桁数字（上記どちらの形にもマッチしないもの）は一切拾わない。
 *
 * @param {string | undefined | null} text
 * @param {Iterable<string>} abandonedNumberList
 * @returns {{ number: string, form: "adr-mention" | "stem", count: number, sample: string }[]}
 */
export function findAbandonedReferences(text, abandonedNumberList) {
  const haystack = text ?? "";
  const found = [];
  for (const n of abandonedNumberList) {
    const adrRe = new RegExp(`ADR ${n}(?!\\d)`, "g");
    const adrMatches = haystack.match(adrRe);
    if (adrMatches && adrMatches.length > 0) {
      found.push({
        number: n,
        form: "adr-mention",
        count: adrMatches.length,
        sample: adrMatches[0],
      });
    }

    const stemRe = new RegExp(`(?<!\\d)${n}-[a-z0-9][a-z0-9-]*`, "g");
    const stemMatches = haystack.match(stemRe);
    if (stemMatches && stemMatches.length > 0) {
      found.push({ number: n, form: "stem", count: stemMatches.length, sample: stemMatches[0] });
    }
  }
  return found;
}

/**
 * この lib の芯——「捨てた番号」を求め、PR タイトル・本文それぞれの中にその番号への
 * 参照が無いかを探し、まとめて返す。副作用（git 呼び出し・`process.exit` 等）は
 * 一切持たない。CLI としての入口は `scripts/check-pr-adr-reference.mjs`。
 *
 * @param {{
 *   claimedNumbers: Iterable<string>,
 *   addedNumbers: Iterable<string>,
 *   prTitle: string | undefined | null,
 *   prBody: string | undefined | null,
 * }} params
 * @returns {{
 *   abandonedNumbers: string[],
 *   violations: { location: "title" | "body", number: string, form: "adr-mention" | "stem", count: number, sample: string }[],
 * }}
 */
export function decidePrAdrReferenceCheck({ claimedNumbers, addedNumbers, prTitle, prBody }) {
  const abandoned = abandonedNumbers(claimedNumbers, addedNumbers);
  const titleFindings = findAbandonedReferences(prTitle, abandoned).map((f) => ({
    ...f,
    location: /** @type {const} */ ("title"),
  }));
  const bodyFindings = findAbandonedReferences(prBody, abandoned).map((f) => ({
    ...f,
    location: /** @type {const} */ ("body"),
  }));
  return { abandonedNumbers: abandoned, violations: [...titleFindings, ...bodyFindings] };
}
