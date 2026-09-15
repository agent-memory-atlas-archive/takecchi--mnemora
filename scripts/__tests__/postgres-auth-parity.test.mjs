import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMPARED_ENV_KEYS,
  NON_MATRIX_POSTGRES_JOBS,
  extractCiPostgresService,
  extractComposePostgresService,
  extractJob,
  findPostgresAuthAsymmetry,
} from "../postgres-auth-parity-lib.mjs";

const CI_YML_PATH = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const COMPOSE_PATH = fileURLToPath(new URL("../../docker-compose.yml", import.meta.url));

/**
 * ⭐ この歯が測っているもの(消す前に読むこと)
 *
 * `docker-compose.yml`（手元用、ADR 0130 で新設）が、`.github/workflows/ci.yml` の
 * 非 matrix な Postgres ジョブ群と同じ認証まわりの値（`image` /
 * `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_INITDB_ARGS`）を
 * 持ち続けているかどうか。**どちらか片方だけを変えると、この歯が赤くなる**
 * ——それが Issue #232 が求めた「非対称が再発したら赤くなる歯」である。
 *
 * 合わせて、CI 側の7ジョブが**互いに**同じ値を宣言していることも見る
 * （`crossJobMismatches`）——`docker-compose.yml` が正しくても、CI 側のどれか1本が
 * こっそり値を変えていたら、それも非対称の再発である。
 */
describe("docker-compose.yml と ci.yml の Postgres 認証まわりの値が揃っている（Issue #232 / ADR 0130）", () => {
  const ciYamlText = readFileSync(CI_YML_PATH, "utf8");
  const composeText = readFileSync(COMPOSE_PATH, "utf8");

  it("対象7ジョブが ci.yml に実在する", () => {
    const result = findPostgresAuthAsymmetry({ ciYamlText, composeText });
    expect(result.missingJobs).toEqual([]);
  });

  it("docker-compose.yml に postgres サービスが在る", () => {
    const result = findPostgresAuthAsymmetry({ ciYamlText, composeText });
    expect(result.composeMissing).toBe(false);
  });

  it("docker-compose.yml と ci.yml の値が全ジョブで一致する（image / 認証まわりの env）", () => {
    const result = findPostgresAuthAsymmetry({ ciYamlText, composeText });
    expect(result.mismatches).toEqual([]);
  });

  it("ci.yml の非 matrix な7ジョブが、互いに同じ値を宣言している", () => {
    const result = findPostgresAuthAsymmetry({ ciYamlText, composeText });
    expect(result.crossJobMismatches).toEqual([]);
  });

  it("実際に POSTGRES_PASSWORD が空でないこと（設定されていなければ scram ではなく trust に落ちる）", () => {
    for (const jobId of NON_MATRIX_POSTGRES_JOBS) {
      const jobBlock = extractJob(ciYamlText, jobId);
      const service = extractCiPostgresService(jobBlock ?? "");
      expect(service.env.POSTGRES_PASSWORD, `job ${jobId}`).toBeTruthy();
    }
    const compose = extractComposePostgresService(composeText);
    expect(compose.env.POSTGRES_PASSWORD).toBeTruthy();
  });
});

describe("postgres-auth-parity-lib の純関数（合成入力）", () => {
  const SAMPLE_CI_YAML = [
    "jobs:",
    "  root-gate-db-stage:",
    "    services:",
    "      postgres:",
    "        image: pgvector/pgvector:pg17",
    "        env:",
    "          POSTGRES_USER: postgres",
    "          POSTGRES_PASSWORD: postgres",
    "          POSTGRES_DB: mnemora_ci",
    '          POSTGRES_INITDB_ARGS: "--encoding=UTF8"',
    "        ports:",
    "          - 5432:5432",
    "  example-chat:",
    "    services:",
    "      postgres:",
    "        image: pgvector/pgvector:pg17",
    "        env:",
    "          POSTGRES_USER: postgres",
    "          POSTGRES_PASSWORD: postgres",
    "          POSTGRES_DB: mnemora_ci",
    '          POSTGRES_INITDB_ARGS: "--encoding=UTF8"',
    "        ports:",
    "          - 5432:5432",
    "",
  ].join("\n");

  const SAMPLE_COMPOSE = [
    "services:",
    "  postgres:",
    "    image: pgvector/pgvector:pg17",
    "    environment:",
    "      POSTGRES_USER: postgres",
    "      POSTGRES_PASSWORD: postgres",
    "      POSTGRES_DB: mnemora_ci",
    '      POSTGRES_INITDB_ARGS: "--encoding=UTF8"',
    "    ports:",
    '      - "5432:5432"',
    "",
  ].join("\n");

  it("extractJob: 存在するジョブを切り出す", () => {
    const block = extractJob(SAMPLE_CI_YAML, "root-gate-db-stage");
    expect(block).toContain("POSTGRES_PASSWORD: postgres");
    expect(block).not.toContain("example-chat");
  });

  it("extractJob: 存在しないジョブは undefined", () => {
    expect(extractJob(SAMPLE_CI_YAML, "no-such-job")).toBeUndefined();
  });

  it("extractCiPostgresService: env の中にコメント行を挟んでいても、以降のキーを取りこぼさない（実物の ci.yml がこの形）", () => {
    const withComment = [
      "jobs:",
      "  root-gate-db-stage:",
      "    services:",
      "      postgres:",
      "        image: pgvector/pgvector:pg17",
      "        env:",
      "          POSTGRES_USER: postgres",
      "          POSTGRES_PASSWORD: postgres",
      "          POSTGRES_DB: mnemora_ci",
      "          # 🔴 この CI がどの regime で測っているかを宣言する。",
      "          # ⛔ ロケールは宣言しない。",
      '          POSTGRES_INITDB_ARGS: "--encoding=UTF8"',
      "        ports:",
      "          - 5432:5432",
      "",
    ].join("\n");
    const block = extractJob(withComment, "root-gate-db-stage");
    const service = extractCiPostgresService(block);
    expect(service.env.POSTGRES_INITDB_ARGS).toBe("--encoding=UTF8");
  });

  it("extractCiPostgresService: image と env を取れる", () => {
    const block = extractJob(SAMPLE_CI_YAML, "root-gate-db-stage");
    const service = extractCiPostgresService(block);
    expect(service.image).toBe("pgvector/pgvector:pg17");
    expect(service.env).toEqual({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "mnemora_ci",
      POSTGRES_INITDB_ARGS: "--encoding=UTF8",
    });
  });

  it("extractComposePostgresService: 引用符を剥がして値を取れる", () => {
    const service = extractComposePostgresService(SAMPLE_COMPOSE);
    expect(service.image).toBe("pgvector/pgvector:pg17");
    expect(service.env.POSTGRES_INITDB_ARGS).toBe("--encoding=UTF8");
  });

  it("findPostgresAuthAsymmetry: 揃っていれば全部空（ci.yml 側の引用符付き POSTGRES_INITDB_ARGS も剥がして比較される）", () => {
    const result = findPostgresAuthAsymmetry({
      ciYamlText: SAMPLE_CI_YAML,
      composeText: SAMPLE_COMPOSE,
    });
    expect(result).toEqual({
      missingJobs: [
        "retrieval-quality",
        "identifier-probes",
        "consolidation-cost",
        "archive-sweep-cost",
        "time-term",
      ],
      composeMissing: false,
      mismatches: [],
      crossJobMismatches: [],
    });
  });

  it("findPostgresAuthAsymmetry: compose 側の POSTGRES_PASSWORD が抜けると mismatch を挙げる（変異試験・退化A）", () => {
    const brokenCompose = SAMPLE_COMPOSE.replace("      POSTGRES_PASSWORD: postgres\n", "");
    const result = findPostgresAuthAsymmetry({
      ciYamlText: SAMPLE_CI_YAML,
      composeText: brokenCompose,
    });
    const passwordMismatches = result.mismatches.filter((m) => m.key === "POSTGRES_PASSWORD");
    expect(passwordMismatches).toEqual([
      {
        job: "root-gate-db-stage",
        key: "POSTGRES_PASSWORD",
        ciValue: "postgres",
        composeValue: undefined,
      },
      {
        job: "example-chat",
        key: "POSTGRES_PASSWORD",
        ciValue: "postgres",
        composeValue: undefined,
      },
    ]);
  });

  it("findPostgresAuthAsymmetry: CI 側の1ジョブだけ image が変わると cross-job mismatch を挙げる（変異試験・退化B）", () => {
    const brokenCiYaml = SAMPLE_CI_YAML.replace(
      "  example-chat:\n    services:\n      postgres:\n        image: pgvector/pgvector:pg17",
      "  example-chat:\n    services:\n      postgres:\n        image: pgvector/pgvector:pg16",
    );
    const result = findPostgresAuthAsymmetry({
      ciYamlText: brokenCiYaml,
      composeText: SAMPLE_COMPOSE,
    });
    const imageCrossMismatches = result.crossJobMismatches.filter((m) => m.key === "image");
    expect(imageCrossMismatches).toEqual([
      {
        job: "example-chat",
        key: "image",
        value: "pgvector/pgvector:pg16",
        referenceJob: "root-gate-db-stage",
        referenceValue: "pgvector/pgvector:pg17",
      },
    ]);
  });

  it("findPostgresAuthAsymmetry: docker-compose.yml が丸ごと無い（postgres サービスが無い）と composeMissing が true", () => {
    const result = findPostgresAuthAsymmetry({
      ciYamlText: SAMPLE_CI_YAML,
      composeText: "services:\n  other:\n    image: something\n",
    });
    expect(result.composeMissing).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it("COMPARED_ENV_KEYS / NON_MATRIX_POSTGRES_JOBS は空でない（歯の対象が消えていない）", () => {
    expect(COMPARED_ENV_KEYS.length).toBeGreaterThan(0);
    expect(NON_MATRIX_POSTGRES_JOBS.length).toBe(7);
  });
});
