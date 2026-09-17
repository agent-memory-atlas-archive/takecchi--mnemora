/**
 * `scripts/release-candidates.mjs`（リリースノート／CHANGELOG に載せる候補を出す CLI）の
 * 純関数の側。ファイル I/O・`git`/`gh` の起動・`process.argv`・`process.exit` を一切持たない
 * ——`scripts/ci-green-check-lib.mjs` と同じ分担・同じ理由。
 *
 * ## この repo は破壊的変更を機械的に見分けられない（この関数群の存在理由）
 *
 * `v0.2.0..origin/main`（70 commit、2026-09-17 時点）を実測したところ、確定的な
 * 破壊的変更は4件あるが、印の付き方はバラバラだった:
 *
 * | sha | `!` | 本文に「破壊的」/BREAKING | 公開API snapshot を触る |
 * |---|---|---|---|
 * | `c4a3dc7` | ✗ | ✗ | ✗ |
 * | `2097a72` | ✗ | ✓ | ✗ |
 * | `855286a` | ✗ | ✓ | ✓ |
 * | `b84f120` | ✓ | ✗ | ✓ |
 *
 * **`c4a3dc7` はどの信号にも掛からない**——それでいて `CHANGELOG.md` の
 * `### 変更（破壊的）` 節には載っている。**⟹ 「信号なし」は「候補ではない」を意味しない。**
 * だから、ここに置く関数は「これは破壊的変更である」という判定を一切返さない。
 * 返すのは、機械的に読み取れる**信号の有無**と、**信号を持たない commit を含む母集合**である。
 * 母集合から信号なし commit を後段が黙って落とすと、`c4a3dc7` の族を再び見失う。
 */

/**
 * conventional commit 風の subject をパースする形（`type(scope)!: description`）。
 *
 * **パースできない subject を例外にせず、`type: null` として返す**——この repo の履歴には
 * この形に従わない subject が実在する（例:
 * `PRタイトル/本文が付け替え後の古いADR番号を名指ししていないかをCIで検査する（Issue #405の後始末・
 * 本文側 / ADR 0211） (#466)`）。**`type: null` の commit も、呼び出し側の母集合から
 * 消えてはならない**——`ADR 0169`（CHANGELOG は手で書く）決定1が定める「利用者に見える変更」の
 * 判定は commit prefix だけでは機械的に下せないと明言しており、prefix を持たない commit を
 * 弾く根拠はどこにも無い。
 *
 * PR 番号（subject 末尾の `(#123)`）は、conventional の形が壊れていても独立に取り出す
 * ——`type: null` でも PR 番号だけは読み取れることが多いため。
 *
 * @param {string} subject
 * @returns {{ type: string | null, scope: string | null, bang: boolean, description: string, prNumber: number | null }}
 */
export function parseCommitSubject(subject) {
  const prMatch = /\(#(\d+)\)\s*$/.exec(subject.trimEnd());
  const prNumber = prMatch ? Number(prMatch[1]) : null;

  const match =
    /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s*(?<description>.*)$/.exec(subject);
  if (!match || !match.groups) {
    return { type: null, scope: null, bang: false, description: subject, prNumber };
  }
  return {
    type: match.groups.type,
    scope: match.groups.scope ?? null,
    bang: match.groups.bang === "!",
    description: match.groups.description,
    prNumber,
  };
}

/** `scripts/__snapshots__/public-api/` 配下のパスか（ADR 0178 の公開 API snapshot）。 */
export function isPublicApiSnapshotPath(path) {
  return path.startsWith("scripts/__snapshots__/public-api/");
}

/**
 * `packages/*\/src/` を触っているか（テストを除く）。
 *
 * **この repo の実際のテスト配置**（`packages/<name>/src/__tests__/*.test.ts`）に合わせ、
 * パスに `__tests__/` を含むものは「テスト」として除外する。この判定は
 * `packages/<name>/src/__tests__/foo.test.ts` を正しく除外するが、`__tests__/` を
 * 経由しない命名のテストファイルが将来増えた場合は取りこぼしうる
 * ——その場合はこの関数を直すこと（歯 `release-candidates-lib.test.mjs` を先に赤くしてから）。
 */
export function isPackageSrcPath(path) {
  return /^packages\/[^/]+\/src\//.test(path) && !/__tests__\//.test(path);
}

/** 本文に「破壊的」または大小無視の「breaking」が含まれるか。 */
export function hasBreakingBodyMention(body) {
  return /(破壊的|breaking)/i.test(body ?? "");
}

/**
 * 1 commit から、機械的に読み取れる信号の配列を返す。複数同時に立ちうる。
 *
 * - `bang` …… subject に `!`（`type(scope)!: ...` の形）
 * - `body-breaking` …… 本文に「破壊的」または「BREAKING」（大小無視）
 * - `public-api` …… `scripts/__snapshots__/public-api/` 配下を変更している
 * - `src` …… `packages/*\/src/` を変更している（テストを除く）
 *
 * @param {{ subject: string, body?: string, files?: string[] }} commit
 * @returns {string[]}
 */
export function computeSignals({ subject, body, files }) {
  const parsed = parseCommitSubject(subject);
  const signals = [];
  if (parsed.bang) signals.push("bang");
  if (hasBreakingBodyMention(body)) signals.push("body-breaking");
  if ((files ?? []).some(isPublicApiSnapshotPath)) signals.push("public-api");
  if ((files ?? []).some(isPackageSrcPath)) signals.push("src");
  return signals;
}

/**
 * 1 commit を、表示・分類に要る形へ落とす。**「これは破壊的変更である」という判定は
 * 一切返さない**——返すのは信号の有無だけである（このファイル冒頭の doc コメント参照）。
 *
 * @param {{ sha: string, subject: string, body?: string, files?: string[] }} commit
 */
export function classifyCommit({ sha, subject, body, files }) {
  const parsed = parseCommitSubject(subject);
  return {
    sha,
    subject,
    type: parsed.type,
    scope: parsed.scope,
    bang: parsed.bang,
    prNumber: parsed.prNumber,
    signals: computeSignals({ subject, body, files }),
  };
}

/**
 * commit の配列をまとめて分類する。**母集合の要素数を変えない**
 * （信号が0個の commit も1件としてそのまま残る）。
 *
 * @param {{ sha: string, subject: string, body?: string, files?: string[] }[]} rawCommits
 */
export function classifyCommits(rawCommits) {
  return rawCommits.map(classifyCommit);
}

/**
 * 分類済み commit を「信号が付いた」「付かなかった」に分ける。
 * **元の配列の要素数の合計は保たれる**——`withSignals.length + withoutSignals.length ===
 * classifiedCommits.length` が常に成り立つ。⭐ `c4a3dc7` の族（信号ゼロ）は
 * `withoutSignals` 側に必ず現れる。ここで捨てると、`AGENTS.md` が要求する
 * 「候補の一覧」ではなく「判定」に戻ってしまう。
 *
 * @param {ReturnType<typeof classifyCommit>[]} classifiedCommits
 */
export function splitBySignal(classifiedCommits) {
  return {
    withSignals: classifiedCommits.filter((c) => c.signals.length > 0),
    withoutSignals: classifiedCommits.filter((c) => c.signals.length === 0),
  };
}

/**
 * 分類済み commit を `type`（`null` を含む）でグループ化する。
 * 「信号が付かなかった commit の一覧」を type 別にまとめて表示するために使う。
 *
 * @param {ReturnType<typeof classifyCommit>[]} classifiedCommits
 * @returns {Map<string, ReturnType<typeof classifyCommit>[]>} キーは type、無ければ `"(type無し)"`
 */
export function groupByType(classifiedCommits) {
  const groups = new Map();
  for (const commit of classifiedCommits) {
    const key = commit.type ?? "(type無し)";
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(commit);
    } else {
      groups.set(key, [commit]);
    }
  }
  return groups;
}

/**
 * `CHANGELOG.md` 本文から、「この節の数字は … の範囲を数えたものである」という文が
 * 名指しする基準 sha を読み取る。**読み取れなくても例外にせず `null` を返す**
 * ——CHANGELOG.md の文言は人が手で書いており（ADR 0169）、この文自体が将来書き換わったり
 * 消えたりしうる。
 *
 * 探すのは、直近の一致（ファイル中で最初に見つかった「の範囲を数えたものである」の直前
 * ウィンドウ）にある、バッククォートで囲われた7〜40桁の16進数文字列。
 * `` `v0.2.0` `` のような tag 名は16進数として拾われない（`v` や `.` が16進数字ではないため）。
 *
 * @param {string} changelogText
 * @returns {string | null}
 */
export function extractChangelogBaseSha(changelogText) {
  const marker = "の範囲を数えたものである";
  const idx = changelogText.indexOf(marker);
  if (idx === -1) return null;
  const windowStart = Math.max(0, idx - 400);
  const window = changelogText.slice(windowStart, idx);
  const hexMatches = [...window.matchAll(/`([0-9a-f]{7,40})`/gi)];
  if (hexMatches.length === 0) return null;
  return hexMatches[hexMatches.length - 1][1];
}
