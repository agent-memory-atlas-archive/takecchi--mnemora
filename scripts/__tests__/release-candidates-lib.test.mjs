import { describe, expect, it } from "vitest";
import {
  classifyCommit,
  classifyCommits,
  computeSignals,
  extractChangelogBaseSha,
  groupByType,
  hasBreakingBodyMention,
  isPackageSrcPath,
  isPublicApiSnapshotPath,
  parseCommitSubject,
  splitBySignal,
} from "../release-candidates-lib.mjs";

/**
 * `scripts/release-candidates-lib.mjs`（リリース候補を分類する純関数の側）の歯。
 *
 * ⚠ このファイルは `git`/`gh` を1度も呼ばない。commit は合成した入力で表現する
 * ——`ci-green-check-lib.test.mjs` が check-runs を合成するのと同じ役割分担。
 */

describe("parseCommitSubject", () => {
  it("`feat(core)!: x (#1)` を type=feat, scope=core, bang=true, pr=1 にパースする", () => {
    const result = parseCommitSubject("feat(core)!: x (#1)");
    expect(result.type).toBe("feat");
    expect(result.scope).toBe("core");
    expect(result.bang).toBe(true);
    expect(result.prNumber).toBe(1);
  });

  it("scope が無い形（`fix: x (#2)`）も正しくパースする", () => {
    const result = parseCommitSubject("fix: x (#2)");
    expect(result.type).toBe("fix");
    expect(result.scope).toBeNull();
    expect(result.bang).toBe(false);
    expect(result.prNumber).toBe(2);
  });

  it("複数 scope（カンマ区切り）をそのまま1つの scope 文字列として保つ", () => {
    const result = parseCommitSubject("feat(core,testkit,docs): x (#3)");
    expect(result.scope).toBe("core,testkit,docs");
  });

  it("パースできない subject を例外にせず、type: null として捨てずに残す", () => {
    // この repo の実履歴に実在する形（conventional の prefix を持たない）:
    // `PRタイトル/本文が…（Issue #405の後始末・本文側 / ADR 0211） (#466)`
    const subject =
      "PRタイトル/本文が付け替え後の古いADR番号を名指ししていないかをCIで検査する（Issue #405の後始末・本文側 / ADR 0211） (#466)";
    const result = parseCommitSubject(subject);
    expect(result.type).toBeNull();
    expect(result.scope).toBeNull();
    expect(result.bang).toBe(false);
    // ⭐ 捨てずに残す: description に元の subject が丸ごと入っている
    expect(result.description).toBe(subject);
    // PR 番号は conventional の形が崩れていても独立に読み取れる
    expect(result.prNumber).toBe(466);
  });

  it("PR 番号が無い subject は prNumber: null（例外にしない）", () => {
    const result = parseCommitSubject("docs(readme): 誤字を直す");
    expect(result.prNumber).toBeNull();
  });
});

describe("isPublicApiSnapshotPath / isPackageSrcPath", () => {
  it("`scripts/__snapshots__/public-api/` 配下を public-api パスとして認識する", () => {
    expect(isPublicApiSnapshotPath("scripts/__snapshots__/public-api/core.d.ts")).toBe(true);
    expect(isPublicApiSnapshotPath("packages/core/src/recall.ts")).toBe(false);
  });

  it("`packages/*/src/` を src パスとして認識するが、テストは除く", () => {
    expect(isPackageSrcPath("packages/core/src/recall.ts")).toBe(true);
    expect(isPackageSrcPath("packages/core/src/__tests__/recall.test.ts")).toBe(false);
    expect(isPackageSrcPath("docs/recall.md")).toBe(false);
    expect(isPackageSrcPath("packages/core/README.md")).toBe(false);
  });
});

describe("hasBreakingBodyMention", () => {
  it("「破壊的」を検知する", () => {
    expect(hasBreakingBodyMention("これは破壊的変更である")).toBe(true);
  });

  it("大小無視で BREAKING を検知する", () => {
    expect(hasBreakingBodyMention("BREAKING CHANGE: foo")).toBe(true);
    expect(hasBreakingBodyMention("breaking change: foo")).toBe(true);
  });

  it("どちらも含まない本文は false。本文が無くても例外にしない", () => {
    expect(hasBreakingBodyMention("ただの説明文")).toBe(false);
    expect(hasBreakingBodyMention(undefined)).toBe(false);
    expect(hasBreakingBodyMention("")).toBe(false);
  });
});

describe("computeSignals — 4つの信号がそれぞれ立つ・複数同時に立つ", () => {
  it("bang だけが立つ", () => {
    const signals = computeSignals({ subject: "feat(core)!: x", body: "", files: ["README.md"] });
    expect(signals).toEqual(["bang"]);
  });

  it("body-breaking だけが立つ", () => {
    const signals = computeSignals({
      subject: "fix(core): x",
      body: "これは破壊的変更である",
      files: ["README.md"],
    });
    expect(signals).toEqual(["body-breaking"]);
  });

  it("public-api だけが立つ", () => {
    const signals = computeSignals({
      subject: "fix(core): x",
      body: "",
      files: ["scripts/__snapshots__/public-api/core.d.ts"],
    });
    expect(signals).toEqual(["public-api"]);
  });

  it("src だけが立つ（テストファイルだけを触っても立たない）", () => {
    const signals = computeSignals({
      subject: "fix(core): x",
      body: "",
      files: ["packages/core/src/recall.ts"],
    });
    expect(signals).toEqual(["src"]);

    const testOnlySignals = computeSignals({
      subject: "test(core): x",
      body: "",
      files: ["packages/core/src/__tests__/recall.test.ts"],
    });
    expect(testOnlySignals).toEqual([]);
  });

  it("4つ全部が同時に立つ（実在の b84f120 と同じ形: bang + public-api + src。ここでは body-breaking も加えて全4種を確認する）", () => {
    const signals = computeSignals({
      subject: "feat(local-embedding)!: LocalEmbeddingPipeline を必須 interface にする (#446)",
      body: "これは破壊的変更である",
      files: [
        "packages/local-embedding/src/pipeline.ts",
        "scripts/__snapshots__/public-api/local-embedding.d.ts",
      ],
    });
    expect(signals).toEqual(expect.arrayContaining(["bang", "body-breaking", "public-api", "src"]));
    expect(signals).toHaveLength(4);
  });
});

describe("classifyCommit / classifyCommits", () => {
  it("sha・subject・type・scope・bang・prNumber・signals を1つのオブジェクトにまとめる", () => {
    const result = classifyCommit({
      sha: "b84f1208da9436ece770bae62f6cc3d55c7688ce",
      subject: "feat(local-embedding)!: x (#446)",
      body: "",
      files: ["packages/local-embedding/src/pipeline.ts"],
    });
    expect(result).toEqual({
      sha: "b84f1208da9436ece770bae62f6cc3d55c7688ce",
      subject: "feat(local-embedding)!: x (#446)",
      type: "feat",
      scope: "local-embedding",
      bang: true,
      prNumber: 446,
      signals: ["bang", "src"],
    });
  });

  it("classifyCommits は母集合の件数を変えない（写像であって filter ではない）", () => {
    const commits = [
      { sha: "a", subject: "feat(core): x (#1)", body: "", files: ["packages/core/src/a.ts"] },
      { sha: "b", subject: "docs(readme): y (#2)", body: "", files: ["README.md"] },
    ];
    expect(classifyCommits(commits)).toHaveLength(2);
  });
});

describe("母集合の保持 — 信号ゼロの commit を落とさない", () => {
  /**
   * ⭐ なぜこの歯が要るか【実測】: `v0.2.0..origin/main`（70 commit、2026-09-17時点）を
   * `node scripts/release-candidates.mjs --since v0.2.0` で実際に洗ったところ、
   * `c4a3dc7`（`FilteredOmission.scopeRelation` を足した確定的な破壊的変更。
   * `docs/decisions/0174-filtered-omission-scope-relation.md`）は、`bang`/
   * `body-breaking`/`public-api` の3信号のいずれにも掛からなかった——それでいて
   * `CHANGELOG.md` の「変更（破壊的）」節には載っている。
   *
   * ⚠ `c4a3dc7` 自身は `packages/core/src/recall.ts` を直接触るため、この道具の
   * 4つ目の信号 `src` は実際には立つ（実行結果で確認済み。詳細は
   * `scripts/release-candidates.mjs` の doc コメントと、この作業の報告に書く）。
   * ⟹ この歯は「`c4a3dc7` とビット単位で同じ入力」を再現するのではなく、
   * **4つの信号すべてがゼロになりうる commit（docs のみ・test のみで、src も
   * public-api も触らない）が実在しうる**という、`c4a3dc7` が示した現象の一般形
   * ——「狭い信号がゼロの候補が実在し、それを母集合から落としてはいけない」——
   * を検査する。ここで母集合から signal ゼロの commit を落とす変異を入れると、
   * この it が赤くなる（`docs/autonomy.md` §2 の変異試験参照）。
   */
  it("4つの信号がどれも立たない commit も、分類結果の配列と『信号なし』側に残る", () => {
    const commits = [
      {
        sha: "aaa1111",
        subject: "docs(readme): 誤字を直す (#1)",
        body: "特に理由は無い",
        files: ["README.md"],
      },
    ];
    const classified = classifyCommits(commits);
    expect(classified).toHaveLength(1);
    expect(classified[0].signals).toEqual([]);

    const { withSignals, withoutSignals } = splitBySignal(classified);
    expect(withSignals).toHaveLength(0);
    expect(withoutSignals).toHaveLength(1);
    expect(withoutSignals[0].sha).toBe("aaa1111");
  });
});

describe("splitBySignal", () => {
  it("信号の有無で2群に分け、合計件数は元の配列と一致する", () => {
    const classified = classifyCommits([
      { sha: "a", subject: "feat(core)!: x (#1)", body: "", files: [] },
      { sha: "b", subject: "docs(readme): y (#2)", body: "", files: ["README.md"] },
      { sha: "c", subject: "fix(core): z (#3)", body: "", files: ["packages/core/src/z.ts"] },
    ]);
    const { withSignals, withoutSignals } = splitBySignal(classified);
    expect(withSignals.map((c) => c.sha)).toEqual(["a", "c"]);
    expect(withoutSignals.map((c) => c.sha)).toEqual(["b"]);
    expect(withSignals.length + withoutSignals.length).toBe(classified.length);
  });
});

describe("groupByType", () => {
  it("type ごとにグループ化し、type が無いものは「(type無し)」にまとめる", () => {
    const classified = classifyCommits([
      { sha: "a", subject: "feat(core): x (#1)", body: "", files: [] },
      { sha: "b", subject: "feat(postgres): y (#2)", body: "", files: [] },
      { sha: "c", subject: "何も付いていない subject (#3)", body: "", files: [] },
    ]);
    const groups = groupByType(classified);
    expect(groups.get("feat").map((c) => c.sha)).toEqual(["a", "b"]);
    expect(groups.get("(type無し)").map((c) => c.sha)).toEqual(["c"]);
  });
});

describe("extractChangelogBaseSha", () => {
  it("実際の CHANGELOG.md と同じ文言から基準 sha を読み取る", () => {
    const text =
      "⭐ **数えた基準を明記する。**この節の数字は `v0.2.0` … **`4b92134`** の範囲を数えたものである。\n";
    expect(extractChangelogBaseSha(text)).toBe("4b92134");
  });

  it("フル40桁 sha でも読み取れる", () => {
    const text =
      "この節の数字は `309303ab4ee5d0a07f7a094782cd80b6a7840dbe` の範囲を数えたものである。";
    expect(extractChangelogBaseSha(text)).toBe("309303ab4ee5d0a07f7a094782cd80b6a7840dbe");
  });

  it("読み取れないときは例外にせず null を返す（該当する文が無い）", () => {
    expect(extractChangelogBaseSha("この CHANGELOG には基準の記述が無い")).toBeNull();
  });

  it("読み取れないときは例外にせず null を返す（文はあるがバッククォート付き16進数が無い）", () => {
    const text = "この節の数字は v0.2.0 の範囲を数えたものである。";
    expect(extractChangelogBaseSha(text)).toBeNull();
  });

  it("空文字列を渡しても例外にならない", () => {
    expect(extractChangelogBaseSha("")).toBeNull();
  });
});
