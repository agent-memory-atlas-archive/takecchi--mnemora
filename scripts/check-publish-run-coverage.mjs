#!/usr/bin/env node
/**
 * publish run の段14（`npm publish（依存の向きの順に、tarball を上げる）`）のログを読み、
 * 「実際に publish の経路を通った本数」を `PUBLISH_TARGETS`（`scripts/publish-targets.mjs`）
 * と突き合わせて pass / fail /判定不能 を出す CLI。
 *
 * ## なぜこれが要るか（ADR 0207「引き受けた負債」）
 *
 * [ADR 0207](../docs/decisions/0207-dry-run-reads-existence-and-coverage-degrades-silently.md)
 * が実測した通り、`workflow_dispatch` の予行は「木の版が registry に既に在るパッケージ」を
 * 冪等の分岐へ黙って短絡する——run の `conclusion` は `success` のまま、段の
 * `success`/`skipped` にも劣化は現れない。ADR 0207 が置いた歯止めは
 * 「段14 のログを `::group::` ごとに1本ずつ人が読むこと」であり、**それを機械が
 * 強制していないこと**を「引き受けた負債」として残していた。このスクリプトはその歯である。
 *
 * ⛔ **このスクリプトは `.github/workflows/publish.yml` の挙動を1行も変えない。**
 * 読むだけである。
 *
 * ## 何を数えているか、何を数えていないか
 *
 * 判定そのもの（文言の切り出し・分類・突き合わせ）は `./publish-run-coverage-lib.mjs` の
 * 純関数が持つ。ここでは
 *
 * 1. `--run <id>` が渡されたら、`gh run view` で run の `status`/`conclusion`/`event`と
 *    job 一覧（`steps` 込み）を取り、`--log-file <path>` が渡されたらそのファイルを
 *    そのままログとして読む（`gh` を一切呼ばない——テストはこの経路を突く）。
 * 2. **段は step 番号ではなく、`publish.yml` の step 名で見つける**——GitHub の
 *    Checks UI の段番号は「Set up job」を数えるかどうかで揺れる（`docs/release-v1.md`
 *    §1.2 の表は同じ段を12番と呼んでいる）。この CLI は、手元の
 *    `.github/workflows/publish.yml`（このスクリプトと同じ木にあるもの）を読み、
 *    `findPublishStepName()` で「`::group::npm publish` を出している step の名前」を
 *    逆算し、その名前を持つ step を含む job のログを取りに行く。
 * 3. `evaluatePublishRunCoverage()` へログとテキストを渡し、判定を受け取る。
 * 4. 人が読める形で印字し、終了コードを返す。
 *
 * **このスクリプトが確かめていないこと**: ログに印字された文言を読んでいるだけであり、
 * `npm publish` が実際に registry へ何を送ったか・registry が何を受け取ったかは
 * 一切見ていない（`publish-run-coverage-lib.mjs` の docstring と同じ注記）。
 * 文言と実体がずれていないことは、このスクリプトの外側（ADR 0207 の「測ったこと2」の
 * ような、`npm view` との突き合わせ）でしか確かめられない。
 *
 * ## 使い方
 *
 * ```
 * node scripts/check-publish-run-coverage.mjs --run 35169553262
 * node scripts/check-publish-run-coverage.mjs --run 35169553262 --repo takecchi/mnemora
 * node scripts/check-publish-run-coverage.mjs --log-file /path/to/job.log
 * node scripts/check-publish-run-coverage.mjs --run 35169553262 --json
 * ```
 *
 * 終了コード:
 * - `0` = pass（`PUBLISH_TARGETS` の全本が publish 経路を通った）
 * - `1` = fail（1本以上が飛ばした/失敗した/ログに無い、またはログに余分な名前が在る）
 * - `2` = 判定不能（ログが期限切れ等で取れない・publish 段/job が見つからない・
 *   run がまだ走っている・本文が既知の3文言のどれにも一致しない、等）。
 *   ⛔ **判定不能を pass に倒さない**——`process.exit(0)` はしない。
 * - `3` = 実行時エラー（引数の誤り・`--log-file` が読めない・`gh` の呼び出し自体が
 *   失敗した（認証切れ等）・手元の `publish.yml` から段の目印が見つからない、等。
 *   これらは「run の状態が読めない」のではなく「この CLI 自身が使えない状態」である）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePublishRunCoverage, findPublishStepName } from "./publish-run-coverage-lib.mjs";
import { PUBLISH_TARGETS } from "./publish-targets.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run") args.run = argv[++i];
    else if (a === "--log-file") args.logFile = argv[++i];
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--json") args.json = true;
    else {
      console.error(`不明な引数: ${a}`);
      process.exit(3);
    }
  }
  return args;
}

function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
  if (result.status !== 0) {
    const err = new Error(
      `${cmd} ${cmdArgs.join(" ")} が失敗した (exit ${result.status}): ${result.stderr}`,
    );
    err.stderr = result.stderr;
    throw err;
  }
  return result.stdout;
}

function resolveRepo(explicitRepo) {
  if (explicitRepo) return explicitRepo;
  return run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
}

/**
 * 手元の `.github/workflows/publish.yml` から、publish 段の step 名を読む。
 * 見つからなければ `null`（呼び出し側が実行時エラーとして扱う——この CLI 自身が
 * 何を探せばいいか分からない状態であり、run の状態の話ではない）。
 */
function resolvePublishStepName() {
  const workflowPath = join(repoRoot, ".github", "workflows", "publish.yml");
  const text = readFileSync(workflowPath, "utf8");
  return findPublishStepName(text);
}

function printResult(result) {
  console.log(`判定: ${result.verdict}`);
  console.log(`理由: ${result.reason}`);
  if (result.isDryRun === null) {
    console.log("予行/本番: 不明（publish 段のログが見つからなかった）");
  } else if (result.isDryRun) {
    console.log("予行/本番: 予行（--dry-run）——registry へは何も上がっていない前提のログである。");
  } else {
    console.log("予行/本番: 本番（release）。");
  }
  console.log(`publish 経路を通った本数: ${result.publishedCount}/${result.totalTargets}`);
  for (const t of result.perTarget) {
    const label =
      t.outcome === "published"
        ? "publish した"
        : t.outcome === "skipped"
          ? "飛ばした（既に registry に在った）"
          : t.outcome === "failed"
            ? "失敗した"
            : t.outcome === "unknown"
              ? "未知の文言（既知の3文言に一致しない）"
              : "ログに無い";
    console.log(`  - ${t.name}: ${label}`);
  }
  if (result.unexpectedNames.length > 0) {
    console.log(`  ⚠ PUBLISH_TARGETS に無い名前がログに在る: ${result.unexpectedNames.join(", ")}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.run && !args.logFile) {
    console.error(
      "使い方: node scripts/check-publish-run-coverage.mjs --run <run id> | --log-file <path> [--repo owner/repo] [--json]",
    );
    process.exit(3);
  }
  if (args.run && args.logFile) {
    console.error("--run と --log-file は同時に渡せない。");
    process.exit(3);
  }

  let logText;
  let meta = {};

  if (args.logFile) {
    try {
      logText = readFileSync(args.logFile, "utf8");
    } catch (err) {
      console.error(`--log-file が読めない: ${String(err.message ?? err)}`);
      process.exit(3);
      return;
    }
  } else {
    let stepName;
    try {
      stepName = resolvePublishStepName();
    } catch (err) {
      console.error(
        `手元の .github/workflows/publish.yml が読めない: ${String(err.message ?? err)}`,
      );
      process.exit(3);
      return;
    }
    if (!stepName) {
      console.error(
        "手元の .github/workflows/publish.yml から、::group::npm publish を出す step 名が" +
          "見つからなかった（findPublishStepName が null を返した）。ワークフローの形が" +
          "変わった可能性がある——この CLI 側の対応が必要。",
      );
      process.exit(3);
      return;
    }

    let repo;
    try {
      repo = resolveRepo(args.repo);
    } catch (err) {
      console.error(String(err.message ?? err));
      process.exit(3);
      return;
    }

    let runInfo;
    try {
      const out = run("gh", [
        "run",
        "view",
        args.run,
        "--repo",
        repo,
        "--json",
        "status,conclusion,event,jobs,url",
      ]);
      runInfo = JSON.parse(out);
    } catch (err) {
      // run 自体が見つからない・gh の認証が切れている等、この CLI の使い方に
      // 起因しうる失敗——「run の状態が読めなかった」という判定不能ではなく、
      // 実行時エラーとして扱う。
      console.error(String(err.message ?? err));
      process.exit(3);
      return;
    }

    console.log(`run: ${runInfo.url ?? args.run}（event=${runInfo.event}）`);

    if (runInfo.status !== "completed") {
      console.log(
        `判定不能: run がまだ走っている（status=${runInfo.status}）。完了してから引き直すこと。`,
      );
      process.exit(2);
      return;
    }

    const job = (runInfo.jobs ?? []).find((j) => (j.steps ?? []).some((s) => s.name === stepName));
    if (!job) {
      console.log(
        `判定不能: publish 段（step 名 "${stepName}"）を持つ job が、この run の中に` +
          "見つからなかった。この run のワークフローが現在の publish.yml と形が違う可能性がある。",
      );
      process.exit(2);
      return;
    }

    meta = { repo, jobId: job.databaseId, jobName: job.name };

    try {
      logText = run("gh", [
        "api",
        `repos/${repo}/actions/jobs/${job.databaseId}/logs`,
        "--allow-escape-sequences",
      ]);
    } catch (err) {
      // ログが期限切れで取れない、等。run 自体は特定できているので、これは
      // 判定不能（run の状態について何も言えない）であって実行時エラりではない。
      console.log(
        `判定不能: job "${job.name}"（id=${job.databaseId}）のログが取得できなかった: ` +
          `${String(err.stderr ?? err.message ?? err)}`,
      );
      process.exit(2);
      return;
    }
  }

  const result = evaluatePublishRunCoverage(logText, PUBLISH_TARGETS);
  printResult(result);

  if (args.json) {
    console.log(JSON.stringify({ ...meta, result }, null, 2));
  }

  if (result.verdict === "pass") process.exit(0);
  if (result.verdict === "fail") process.exit(1);
  process.exit(2);
}

main();
