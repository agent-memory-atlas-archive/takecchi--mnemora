/**
 * `.github/workflows/ci.yml` の各ジョブが宣言する Postgres の認証まわりの値
 * （`services.postgres.image` / `POSTGRES_USER` / `POSTGRES_PASSWORD` /
 * `POSTGRES_DB` / `POSTGRES_INITDB_ARGS`）と、手元用の `docker-compose.yml` の
 * 値が**揃っているか**を判定する純関数の側（Issue #232 / ADR 0130）。
 *
 * ## なぜ要るか
 *
 * ADR 0017 が「手元の門は、既定では CI と同じ認証方式を測っていない」と自ら
 * 名指しした残債（Issue #232）。CI の service container は `POSTGRES_PASSWORD` を
 * 設定しており、これは公式 postgres イメージの host 認証を既定で `scram-sha-256`
 * にする。手元でパスワード無し（`trust`）の Postgres を使っていると、この非対称は
 * 再発しても手元では一切検出できない——実際に ADR 0017 の歯4はこの形で1度、
 * 手元では緑・CI でだけ赤くなった。
 *
 * この repo に手元用の Postgres 起動手順は無かった（`docker-compose*.yml` も
 * `scripts/` にも存在しない——Issue #232 着手前に確認済み）。ADR 0130 は
 * `docker-compose.yml` を新設し、CI の非 matrix なジョブ（`postgres` ジョブの
 * `server_encoding` matrix は対象外——Issue #155/ADR 0105 の関心とは別）が使う
 * 値と揃えることにした。**揃え続けることをこの歯で固定する**——どちらか片方だけを
 * 変えると、この歯が番号を挙げて赤くなる。
 *
 * ## ⛔ 依存を足していない
 *
 * `docs/autonomy.md` / ADR 0014・0061 で依存追加はオーナー専権。既存の wiring 歯
 * （`initdb-args-lib.mjs` 等）と同じく、YAML パーサ（js-yaml 等）は使わず、
 * 正規表現とインデント幅だけで必要な値を切り出す。**この repo の `ci.yml` /
 * `docker-compose.yml` はどちらも `key: value` の平坦な形しか使っていないため、
 * コメント剥がし（`workflow-comment-blank-lib.mjs`）ほどの一般性は要らない**——
 * 対象の行が `#` を含む値を持つことは無い（`AGENTS.md` の運用上、環境変数の値に
 * `#` を書く理由が無い）。
 *
 * ## 対象ジョブ
 *
 * `NON_MATRIX_POSTGRES_JOBS` に列挙した8ジョブ。`postgres` ジョブ（matrix）は
 * 除外する——`POSTGRES_INITDB_ARGS` が `${{ matrix.initdbArgs }}` という式であり、
 * 脚によって `SQL_ASCII` になるため、他ジョブと単純比較すると誤って赤くなる
 * （この歯の関心は encoding regime ではなく認証方式であり、`POSTGRES_PASSWORD`/
 * `POSTGRES_USER`/`image` は `postgres` ジョブでも他ジョブと同じ値だが、
 * `POSTGRES_INITDB_ARGS` まで巻き込むと無関係な理由で赤くなる）。
 */

/** ci.yml でこの歯が揃っていることを要求する非 matrix ジョブ。 */
export const NON_MATRIX_POSTGRES_JOBS = Object.freeze([
  "root-gate-db-stage",
  "example-chat",
  "retrieval-quality",
  "identifier-probes",
  "consolidation-cost",
  "archive-sweep-cost",
  "time-term",
  "association-probes",
]);

/** 比較する env キー。`POSTGRES_INITDB_ARGS` も含む——非 matrix ジョブ同士は全員 `--encoding=UTF8` で揃っているはずである。 */
export const COMPARED_ENV_KEYS = Object.freeze([
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "POSTGRES_INITDB_ARGS",
]);

/**
 * YAML の値の前後を囲う二重引用符を剥がす（`"--encoding=UTF8"` → `--encoding=UTF8`）。
 * `ci.yml` は `POSTGRES_INITDB_ARGS` を引用符付きで書き、`POSTGRES_USER` 等は
 * 引用符無しで書く——**書き方の揺れであって値の違いではない**ため、比較の前に
 * 両方とも剥がして揃える（ci 側・compose 側の両方の抽出関数がこれを使う）。
 *
 * @param {string} value
 * @returns {string}
 */
function stripSurroundingQuotes(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * `jobs:` の下の1ジョブ（`  <id>:` から、次の同じ深さの `  <id>:` まで）を切り出す
 * （`ci-yml-postgres-regime-wiring.test.mjs` の `extractJob` と同じ形）。
 *
 * @param {string} yaml
 * @param {string} jobId
 * @returns {string | undefined} 見つからなければ `undefined`
 */
export function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    return undefined;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * ジョブ本文（`extractJob` の戻り値）から `services.postgres` の直下（`image:` /
 * `env:` の中身）を切り出す。`ci.yml` の実物は次の形（インデント幅固定）:
 *
 * ```yaml
 *     services:
 *       postgres:
 *         image: pgvector/pgvector:pg17
 *         env:
 *           POSTGRES_USER: postgres
 *           …
 *         ports:
 *           - 5432:5432
 * ```
 *
 * @param {string} jobBlock
 * @returns {{ image: string | undefined, env: Record<string, string> }}
 */
export function extractCiPostgresService(jobBlock) {
  const lines = jobBlock.split("\n");
  const serviceStart = lines.findIndex((line) => line === "      postgres:");
  if (serviceStart === -1) {
    return { image: undefined, env: {} };
  }
  let serviceEnd = lines.length;
  for (let i = serviceStart + 1; i < lines.length; i += 1) {
    if (/^ {0,6}\S/.test(lines[i])) {
      serviceEnd = i;
      break;
    }
  }
  const serviceLines = lines.slice(serviceStart + 1, serviceEnd);

  let image;
  const imageLine = serviceLines.find((line) => /^ {8}image: /.test(line));
  if (imageLine !== undefined) {
    image = imageLine.slice("        image: ".length).trim();
  }

  const envStart = serviceLines.findIndex((line) => line === "        env:");
  /** @type {Record<string, string>} */
  const env = {};
  if (envStart !== -1) {
    for (let i = envStart + 1; i < serviceLines.length; i += 1) {
      const line = serviceLines[i];
      // `ci.yml` は各 env キーの直前にコメント行を挟むことが多い（宣言の意図を
      // 説明する注釈）。**コメント行・空行は読み飛ばす**——キーではない行が
      // 出た時点で打ち切ると、コメントを挟んだ実物の env ブロックで
      // `POSTGRES_INITDB_ARGS` を取りこぼす（実測して見つけた欠陥）。
      if (line.trim() === "" || /^ {10}#/.test(line)) {
        continue;
      }
      const matched = /^ {10}([A-Za-z_][A-Za-z0-9_]*): (.*)$/.exec(line);
      if (!matched) {
        break;
      }
      env[matched[1]] = stripSurroundingQuotes(matched[2].trim());
    }
  }
  return { image, env };
}

/**
 * `docker-compose.yml`（この repo が新設した手元用の1本、`services.postgres` のみ
 * 持つ）から `image` / `environment` を切り出す。実物の形（インデント幅固定）:
 *
 * ```yaml
 * services:
 *   postgres:
 *     image: pgvector/pgvector:pg17
 *     environment:
 *       POSTGRES_USER: postgres
 *       …
 *     ports:
 *       - "5432:5432"
 * ```
 *
 * @param {string} composeText
 * @returns {{ image: string | undefined, env: Record<string, string> }}
 */
export function extractComposePostgresService(composeText) {
  const lines = composeText.split("\n");
  const serviceStart = lines.findIndex((line) => line === "  postgres:");
  if (serviceStart === -1) {
    return { image: undefined, env: {} };
  }
  let serviceEnd = lines.length;
  for (let i = serviceStart + 1; i < lines.length; i += 1) {
    if (/^ {0,2}\S/.test(lines[i])) {
      serviceEnd = i;
      break;
    }
  }
  const serviceLines = lines.slice(serviceStart + 1, serviceEnd);

  let image;
  const imageLine = serviceLines.find((line) => /^ {4}image: /.test(line));
  if (imageLine !== undefined) {
    image = imageLine.slice("    image: ".length).trim();
  }

  const envStart = serviceLines.findIndex((line) => line === "    environment:");
  /** @type {Record<string, string>} */
  const env = {};
  if (envStart !== -1) {
    for (let i = envStart + 1; i < serviceLines.length; i += 1) {
      const line = serviceLines[i];
      if (line.trim() === "" || /^ {6}#/.test(line)) {
        continue;
      }
      const matched = /^ {6}([A-Za-z_][A-Za-z0-9_]*): (.*)$/.exec(line);
      if (!matched) {
        break;
      }
      env[matched[1]] = stripSurroundingQuotes(matched[2].trim());
    }
  }
  return { image, env };
}

/**
 * 手元用 `docker-compose.yml` と、CI の非 matrix な Postgres ジョブ群との
 * 非対称を検出する。
 *
 * @param {{ ciYamlText: string, composeText: string }} input
 * @returns {{
 *   missingJobs: string[],
 *   composeMissing: boolean,
 *   mismatches: { job: string, key: string, ciValue: string | undefined, composeValue: string | undefined }[],
 *   crossJobMismatches: { job: string, key: string, value: string | undefined, referenceJob: string, referenceValue: string | undefined }[],
 * }}
 */
export function findPostgresAuthAsymmetry({ ciYamlText, composeText }) {
  const compose = extractComposePostgresService(composeText);
  const composeMissing = compose.image === undefined;

  /** @type {string[]} */
  const missingJobs = [];
  /** @type {{ job: string, key: string, ciValue: string | undefined, composeValue: string | undefined }[]} */
  const mismatches = [];
  /** @type {{ job: string, key: string, value: string | undefined, referenceJob: string, referenceValue: string | undefined }[]} */
  const crossJobMismatches = [];

  /** @type {{ job: string, image: string | undefined, env: Record<string, string> }[]} */
  const ciServices = [];

  for (const jobId of NON_MATRIX_POSTGRES_JOBS) {
    const jobBlock = extractJob(ciYamlText, jobId);
    if (jobBlock === undefined) {
      missingJobs.push(jobId);
      continue;
    }
    const service = extractCiPostgresService(jobBlock);
    ciServices.push({ job: jobId, ...service });
  }

  const reference = ciServices[0];

  for (const service of ciServices) {
    if (!composeMissing) {
      if (service.image !== compose.image) {
        mismatches.push({
          job: service.job,
          key: "image",
          ciValue: service.image,
          composeValue: compose.image,
        });
      }
      for (const key of COMPARED_ENV_KEYS) {
        if (service.env[key] !== compose.env[key]) {
          mismatches.push({
            job: service.job,
            key,
            ciValue: service.env[key],
            composeValue: compose.env[key],
          });
        }
      }
    }

    if (reference !== undefined && service.job !== reference.job) {
      if (service.image !== reference.image) {
        crossJobMismatches.push({
          job: service.job,
          key: "image",
          value: service.image,
          referenceJob: reference.job,
          referenceValue: reference.image,
        });
      }
      for (const key of COMPARED_ENV_KEYS) {
        if (service.env[key] !== reference.env[key]) {
          crossJobMismatches.push({
            job: service.job,
            key,
            value: service.env[key],
            referenceJob: reference.job,
            referenceValue: reference.env[key],
          });
        }
      }
    }
  }

  return { missingJobs, composeMissing, mismatches, crossJobMismatches };
}
