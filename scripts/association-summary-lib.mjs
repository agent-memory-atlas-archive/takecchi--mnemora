/**
 * `scripts/association-summary.mjs`(CI の Job Summary に載せる Markdown を組み立てる
 * CLI)の純関数の側。ファイル I/O・`process.argv`・`process.exit` を一切持たない
 * ——`scripts/identifier-probe-summary-lib.mjs`/`scripts/retrieval-quality-summary-lib.mjs`
 * と同じ分担・同じ理由(Issue #109 で確立し、Issue #291 でも踏襲する)。
 *
 * `examples/chat` の `association-probes` サブコマンド(`MNEMORA_ASSOCIATION_JSON` が
 * 吐く JSON)を Markdown へ変換する。`recall()` の連想枠(`RecallQuery.association`、
 * ADR 0151 / Issue #200)が想起の質を動かすかを、4本の arm
 * (`off: 連想枠なし（既定の recall）` / `on: 連想枠あり（maxCount=3）` /
 * `on: 連想枠あり（maxCount=5）` / `on: 連想枠あり（maxCount=10）`)で比べる(Issue #291。
 * `maxCount=10` は、CI 実測(commit `4362333`)で `returnedCount` が全 probe で
 * 「10 + maxCount」ちょうど(枠が常に満杯)だった一方 gold は12件中5件しか居なかった
 * ことを受けたフォローアップ——「gold は枠のすぐ下に居るのか、届いていないのか」を
 * `maxCount` を伸ばして切り分ける)。
 *
 * ## ⛔ 門にしない。非0になるのは入力そのものが壊れているときだけ
 *
 * このファイルの関数(そして `association-summary.mjs` の exit code)は、実測値が
 * 基準値と相違していても non-zero を返さない。probe は12件(カテゴリ3種×4件)で
 * あり、[ADR 0033](../docs/decisions/0033-what-decided-the-rank-in-the-retrieval-bench.md)
 * §3 の規律(標本7件からは失敗率も成功率も統計的に主張しない)に照らして、
 * 閾値判定の門を置くには足りない標本である——`identifier-probes`/`retrieval-quality`
 * と同じ判断(ADR 0088 §3)。
 *
 * **非0になるのは、JSON が読めない・parse できない・必須項目が無い・型が違う・
 * 参照整合性が壊れている(例: `deltas[].baselineArmLabel` が `arms[].armLabel` の
 * どれとも一致しない)ときだけである。**
 *
 * ## ⚠ この repo にはまだ基準値ファイルが無い(2026-09-16 時点)
 *
 * `examples/chat/association-baseline.json` はまだ作っていない——このベンチは
 * CI で1度も実測されていないため、数字をでっち上げずに置く基準値が無い。
 * `--baseline` は任意であり、省略すれば基準値なしで動く(`buildSummaryMarkdown` の
 * `baseline` は optional)。基準値が用意できたら、この関数の `validateBaseline` を
 * 通る形で `examples/chat/association-baseline.json` を作り、`ci.yml` の summary
 * ステップに `--baseline` を足すこと。
 *
 * ## 🔴 hit@10 は連想枠の効果を測れない(表の下に必ず注記する)
 *
 * 連想枠が拾った候補(`retrievedVia: "association"`)は、`recall()` 本体の
 * `limit`件の**後ろへ連結**されて返る(`examples/chat/src/association-probe-set.ts`
 * の docstring、ADR 0151)。⟹ 連想由来の gold は11位以降にしか現れず、`hit@10`
 * (上位10件に gold が入ったか)は連想枠が効いているかどうかを原理的に判定できない。
 * この事実は `buildSummaryMarkdown` が**必ず**注記として出す
 * (`HIT10_CAVEAT_NOTE`)——読む人が「hit@10 が動いていない＝連想枠が効いていない」
 * と読み違えるのを防ぐため。
 *
 * ## ⚠ 基準値との同一性は `armLabel` では取らない(実装を読んで訂正した点)
 *
 * 当初はタスク仕様の「`armLabel` は3本の固定文字列」を鵜呑みにし、`armLabel` を
 * そのまま同一性の鍵にしていた。**しかし実装
 * (`examples/chat/src/cli.ts` の `runAssociationProbes`)を読むと、実際の
 * `armLabel` は `` `off: 連想枠なし（既定の recall）(llm=${llmMode}, ` +
 * `embedding=${embeddingMode}/${model}/${dimensions}次元)` `` のように、
 * **埋め込みモデルの条件を文字列に埋めた形**で組み立てられている——
 * これはまさに `identifier-probe-summary-lib.mjs` が「`label` を鍵にしない」と
 * 名指しした理由(条件が変わると `label` ごと変わり、鍵にすると「何が変わったか」が
 * 読めなくなる)がそのまま当てはまる形である。
 *
 * ⟹ ここでは `armLabel` を**表示にだけ**使い、同一性の鍵には
 * `armShortKey(arm)`(`associationEnabled`/`associationMaxCount` という構造化
 * フィールドから導く、`"off"`/`"on(max=3)"`/`"on(max=5)"`)を使う——
 * `identifier-probe-summary-lib.mjs` の「群の名前」に相当するものを、この bench では
 * 別フィールドとして持たせる代わりに、既存の2フィールドの組から導出する。
 */

/** 現在の仕様(Issue #291)で固定されている arm の本数。 */
const ARM_COUNT = 4;
/** 現在の仕様で固定されている delta の本数(いずれも baseline=off との対比)。 */
const DELTA_COUNT = 3;
/** probe のカテゴリ(ブリッジ語の字種)。3種×4件。 */
const CATEGORIES = ["ascii-id", "proper-noun", "common-noun"];

const TOP_STRING_FIELDS = ["measuredAt", "llmMode"];
const TOP_NUMBER_FIELDS = ["schemaVersion", "probeCount", "haystackSize", "recallLimit"];

const ARM_STRING_FIELDS = ["armLabel"];
const ARM_NUMBER_FIELDS = [
  "probeCount",
  "ingestedCount",
  "goldReturnedCount",
  "hit1Count",
  "hit10Count",
  "goldViaAssociationCount",
  "mrr",
  "returnedMemoryTotal",
  "memoryCharsTotal",
  "associationCharsTotal",
  // ⭐ Issue #291 フォローアップ: 同じストア・同じクエリで recall() を引き直したときの
  // 一致件数(`examples/chat/src/association-arm.ts` の `AssociationArmReport` 参照)。
  "repeatFrameIdenticalCount",
  "repeatGoldRankSameCount",
];
const ARM_BOOLEAN_FIELDS = ["associationEnabled"];

const PROBE_STRING_FIELDS = ["probeId"];
const PROBE_NUMBER_FIELDS = ["returnedCount", "memoryChars", "associationChars", "reciprocalRank"];
const PROBE_BOOLEAN_FIELDS = [
  "hit1",
  "hit10",
  "goldReturned",
  "goldAnchoredOnProbeAnchor",
  // ⭐ Issue #291 フォローアップ: 同じストア・同じクエリでの recall() 引き直しが
  // 一致したか(probe 単位。`AssociationProbeOutcome` 参照)。
  "repeatFrameIdentical",
  "repeatGoldRankSame",
];

/** `AssociationFrameEntry.role`(`examples/chat/src/association-arm.ts`)の既知の値。 */
const ASSOCIATION_FRAME_ROLE_VALUES = [
  "own-gold",
  "own-anchor",
  "own-distractor",
  "other-probe",
  "haystack",
  "unknown",
];

const DELTA_STRING_FIELDS = ["baselineArmLabel", "againstArmLabel"];
const DELTA_NUMBER_FIELDS = [
  "goldReturnedCount",
  "goldViaAssociationCount",
  "mrr",
  "hit10Count",
  "memoryCharsTotal",
];

/**
 * 共通の「文字列/数値/真偽値フィールドが揃っているか」を見る。
 *
 * @param {unknown} obj
 * @param {string} path エラーメッセージ用のラベル(例: `arms[0]`)
 * @param {{ stringFields?: string[], numberFields?: string[], booleanFields?: string[] }} spec
 * @returns {string[]}
 */
function findScalarFieldProblems(obj, path, spec) {
  if (typeof obj !== "object" || obj === null) {
    return [`${path} がオブジェクトでない`];
  }
  const problems = [];
  for (const field of spec.stringFields ?? []) {
    if (typeof obj[field] !== "string" || obj[field] === "") {
      problems.push(`${path}.${field} が文字列でない、または空`);
    }
  }
  for (const field of spec.numberFields ?? []) {
    if (typeof obj[field] !== "number" || Number.isNaN(obj[field])) {
      problems.push(`${path}.${field} が数値でない`);
    }
  }
  for (const field of spec.booleanFields ?? []) {
    if (typeof obj[field] !== "boolean") {
      problems.push(`${path}.${field} が真偽値でない`);
    }
  }
  return problems;
}

/**
 * arm の同一性の鍵(表示用の `armLabel` ではなく、こちらを使う——冒頭 docstring
 * 「⚠ 基準値との同一性は armLabel では取らない」参照)。`associationEnabled`/
 * `associationMaxCount` という構造化フィールドから直接導く——実装
 * (`examples/chat/src/cli.ts`)の `armLabel` は埋め込みモデルの条件を文字列に
 * 埋めており、条件が変われば `armLabel` ごと変わるため、鍵には使えない。
 *
 * @param {{ associationEnabled: boolean, associationMaxCount: number | null }} arm
 */
function armShortKey(arm) {
  return arm.associationEnabled ? `on(max=${arm.associationMaxCount})` : "off";
}

/** `null` または期待した型のどちらか、を見る。 */
function isStringOrNull(value) {
  return value === null || typeof value === "string";
}
function isNumberOrNull(value) {
  return value === null || (typeof value === "number" && !Number.isNaN(value));
}

const PROBE_CATEGORY_VALUES = CATEGORIES;

/**
 * 1件の `associationFrame` エントリ(`{ externalId, rank, role, anchorExternalId }`)の
 * 形を検査する。⚠ ここも門にはしない(呼び出し側の `validateMeasured` と同じ姿勢)
 * ——形が壊れていなければ ok、内容(role が期待通りか等)は問わない。
 *
 * @param {unknown} entry
 * @param {string} path
 * @returns {string[]}
 */
function findAssociationFrameEntryProblems(entry, path) {
  if (typeof entry !== "object" || entry === null) {
    return [`${path} がオブジェクトでない`];
  }
  const problems = [];
  if (typeof entry.externalId !== "string" || entry.externalId === "") {
    problems.push(`${path}.externalId が文字列でない、または空`);
  }
  if (typeof entry.rank !== "number" || Number.isNaN(entry.rank)) {
    problems.push(`${path}.rank が数値でない`);
  }
  if (!ASSOCIATION_FRAME_ROLE_VALUES.includes(entry.role)) {
    problems.push(
      `${path}.role が ${ASSOCIATION_FRAME_ROLE_VALUES.join("/")} のいずれでもない` +
        `(実際: ${JSON.stringify(entry.role)})`,
    );
  }
  if (!isStringOrNull(entry.anchorExternalId)) {
    problems.push(`${path}.anchorExternalId が文字列でも null でもない`);
  }
  return problems;
}

/**
 * @param {unknown} probe
 * @param {string} path
 * @returns {string[]}
 */
function findProbeFieldProblems(probe, path) {
  const problems = findScalarFieldProblems(probe, path, {
    stringFields: PROBE_STRING_FIELDS,
    numberFields: PROBE_NUMBER_FIELDS,
    booleanFields: PROBE_BOOLEAN_FIELDS,
  });
  if (typeof probe !== "object" || probe === null) {
    return problems;
  }
  if (!PROBE_CATEGORY_VALUES.includes(probe.category)) {
    problems.push(
      `${path}.category が ${PROBE_CATEGORY_VALUES.join("/")} のいずれでもない` +
        `(実際: ${JSON.stringify(probe.category)})`,
    );
  }
  if (!isNumberOrNull(probe.goldRank)) {
    problems.push(`${path}.goldRank が数値でも null でもない`);
  }
  if (!isNumberOrNull(probe.anchorRank)) {
    problems.push(`${path}.anchorRank が数値でも null でもない`);
  }
  if (!isNumberOrNull(probe.distractorRank)) {
    problems.push(`${path}.distractorRank が数値でも null でもない`);
  }
  if (!isStringOrNull(probe.goldRetrievedVia)) {
    problems.push(`${path}.goldRetrievedVia が文字列でも null でもない`);
  }
  if (!isStringOrNull(probe.goldAssociationOf)) {
    problems.push(`${path}.goldAssociationOf が文字列でも null でもない`);
  }
  if (!isStringOrNull(probe.stageSkipped)) {
    problems.push(`${path}.stageSkipped が文字列でも null でもない`);
  }
  if (!Array.isArray(probe.associationFrame)) {
    problems.push(`${path}.associationFrame が配列でない`);
  } else {
    probe.associationFrame.forEach((entry, i) => {
      problems.push(...findAssociationFrameEntryProblems(entry, `${path}.associationFrame[${i}]`));
    });
  }
  return problems;
}

/**
 * 1本の arm(`off`/`on: maxCount=3`/`on: maxCount=5`)の必須項目を検査する。
 *
 * @param {unknown} arm
 * @param {string} path
 * @param {number} topProbeCount 実測 JSON トップレベルの `probeCount`(arm 間で揃っているはず)
 * @returns {string[]}
 */
function findArmFieldProblems(arm, path, topProbeCount) {
  const problems = findScalarFieldProblems(arm, path, {
    stringFields: ARM_STRING_FIELDS,
    numberFields: ARM_NUMBER_FIELDS,
    booleanFields: ARM_BOOLEAN_FIELDS,
  });
  if (typeof arm !== "object" || arm === null) {
    return problems;
  }
  if (!isNumberOrNull(arm.associationMaxCount)) {
    problems.push(`${path}.associationMaxCount が数値でも null でもない`);
  }
  if (
    typeof arm.stageSkippedReasons !== "object" ||
    arm.stageSkippedReasons === null ||
    Array.isArray(arm.stageSkippedReasons)
  ) {
    problems.push(`${path}.stageSkippedReasons がオブジェクトでない`);
  } else {
    for (const [reason, count] of Object.entries(arm.stageSkippedReasons)) {
      if (typeof count !== "number" || Number.isNaN(count)) {
        problems.push(`${path}.stageSkippedReasons.${reason} が数値でない`);
      }
    }
  }
  if (
    typeof arm.associationFrameRoles !== "object" ||
    arm.associationFrameRoles === null ||
    Array.isArray(arm.associationFrameRoles)
  ) {
    problems.push(`${path}.associationFrameRoles がオブジェクトでない`);
  } else {
    for (const [role, count] of Object.entries(arm.associationFrameRoles)) {
      if (typeof count !== "number" || Number.isNaN(count)) {
        problems.push(`${path}.associationFrameRoles.${role} が数値でない`);
      }
    }
  }
  if (!Array.isArray(arm.probes)) {
    problems.push(`${path}.probes が配列でない`);
    return problems;
  }
  // 🔴 件数をここに書き写さない。arm 自身の probeCount、そしてトップレベルの
  // probeCount と、実際の probes 配列長が一致していることを見る(書き写した数字が
  // probe を増やした後も古いまま緑になる、という取り違えを避けるため)。
  if (typeof arm.probeCount === "number" && arm.probes.length !== arm.probeCount) {
    problems.push(
      `${path}.probes の長さ(${arm.probes.length})が ${path}.probeCount(${arm.probeCount})と一致しない`,
    );
  }
  if (typeof arm.probeCount === "number" && arm.probeCount !== topProbeCount) {
    problems.push(
      `${path}.probeCount(${arm.probeCount})がトップレベルの probeCount(${topProbeCount})と一致しない`,
    );
  }
  arm.probes.forEach((probe, i) => {
    problems.push(...findProbeFieldProblems(probe, `${path}.probes[${i}]`));
  });
  return problems;
}

/**
 * @param {unknown} delta
 * @param {string} path
 * @returns {string[]}
 */
function findDeltaFieldProblems(delta, path) {
  const problems = findScalarFieldProblems(delta, path, {
    stringFields: DELTA_STRING_FIELDS,
    numberFields: DELTA_NUMBER_FIELDS,
  });
  if (typeof delta !== "object" || delta === null) {
    return problems;
  }
  if (!isNumberOrNull(delta.charsPerAdditionalGold)) {
    problems.push(`${path}.charsPerAdditionalGold が数値でも null でもない`);
  }
  return problems;
}

/**
 * `embedding`(`{ provider, model, dimensions }`)の必須項目を検査する。
 *
 * @param {unknown} embedding
 * @param {string} path
 * @returns {string[]}
 */
function findEmbeddingFieldProblems(embedding, path) {
  if (typeof embedding !== "object" || embedding === null) {
    return [`${path} がオブジェクトでない`];
  }
  const problems = [];
  for (const field of ["provider", "model"]) {
    if (typeof embedding[field] !== "string" || embedding[field] === "") {
      problems.push(`${path}.${field} が文字列でない、または空`);
    }
  }
  if (typeof embedding.dimensions !== "number") {
    problems.push(`${path}.dimensions が数値でない`);
  }
  return problems;
}

/**
 * `MNEMORA_ASSOCIATION_JSON` が吐いた JSON(パース済み)の形を検査する。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "実測 JSON がオブジェクトでない" };
  }
  const problems = findScalarFieldProblems(data, "測定結果", {
    stringFields: TOP_STRING_FIELDS,
    numberFields: TOP_NUMBER_FIELDS,
  });
  if (!isStringOrNull(/** @type {any} */ (data).commit)) {
    problems.push("測定結果.commit が文字列でも null でもない");
  }
  problems.push(
    ...findEmbeddingFieldProblems(/** @type {any} */ (data).embedding, "測定結果.embedding"),
  );

  const warmup = /** @type {any} */ (data).warmup;
  if (typeof warmup !== "object" || warmup === null) {
    problems.push("測定結果.warmup がオブジェクトでない");
  } else {
    if (typeof warmup.ok !== "boolean") {
      problems.push("測定結果.warmup.ok が真偽値でない");
    }
    if (!isStringOrNull(warmup.detail)) {
      problems.push("測定結果.warmup.detail が文字列でも null でもない");
    }
  }

  const topProbeCount = /** @type {any} */ (data).probeCount;
  const arms = /** @type {any} */ (data).arms;
  /** @type {string[]} */
  const armLabels = [];
  if (!Array.isArray(arms)) {
    problems.push("測定結果.arms が配列でない");
  } else {
    if (arms.length !== ARM_COUNT) {
      problems.push(`測定結果.arms の本数が ${ARM_COUNT} でない(実際: ${arms.length})`);
    }
    const seenLabels = new Set();
    const seenArmKeys = new Set();
    arms.forEach((arm, i) => {
      problems.push(...findArmFieldProblems(arm, `測定結果.arms[${i}]`, topProbeCount));
      const label = /** @type {any} */ (arm)?.armLabel;
      if (typeof label === "string" && label !== "") {
        if (seenLabels.has(label)) {
          problems.push(`測定結果.arms に armLabel「${label}」が2件以上ある`);
        }
        seenLabels.add(label);
        armLabels.push(label);
      }
      // 🔴 同一性の本当の鍵(associationEnabled/associationMaxCount)でも重複を見る
      // ——armLabel は埋め込み条件を埋めた表示用文字列であり、それだけでは
      // 「同じ arm が2件」を見落とす場合がある(冒頭 docstring 参照)。
      if (typeof arm === "object" && arm !== null && typeof arm.associationEnabled === "boolean") {
        const armKey = armShortKey(arm);
        if (seenArmKeys.has(armKey)) {
          problems.push(
            `測定結果.arms に arm「${armKey}」(associationEnabled/associationMaxCount)が2件以上ある`,
          );
        }
        seenArmKeys.add(armKey);
      }
    });
  }

  const deltas = /** @type {any} */ (data).deltas;
  if (!Array.isArray(deltas)) {
    problems.push("測定結果.deltas が配列でない");
  } else {
    if (deltas.length !== DELTA_COUNT) {
      problems.push(`測定結果.deltas の本数が ${DELTA_COUNT} でない(実際: ${deltas.length})`);
    }
    deltas.forEach((delta, i) => {
      problems.push(...findDeltaFieldProblems(delta, `測定結果.deltas[${i}]`));
      if (typeof delta === "object" && delta !== null) {
        // 🔴 参照整合性: delta が指す arm が、実在する arm の armLabel でなければならない。
        // 順番ではなく名前で突き合わせる(識別子誤字を検出するため)。
        for (const field of ["baselineArmLabel", "againstArmLabel"]) {
          const label = delta[field];
          if (typeof label === "string" && label !== "" && !armLabels.includes(label)) {
            problems.push(
              `測定結果.deltas[${i}].${field}(${JSON.stringify(label)})が arms のどの armLabel とも一致しない`,
            );
          }
        }
      }
    });
  }

  if (problems.length > 0) {
    return { ok: false, error: `実測 JSON が使えない: ${problems.join("; ")}` };
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

/**
 * 基準値ファイル(`examples/chat/association-baseline.json`。まだ存在しない——
 * 冒頭 docstring 参照)の形を検査する。arm レベルの数値だけを要求し、
 * `probes`/`stageSkippedReasons` は要求しない(基準値と比べるのは arm 別まとめの
 * 行だけであり、probe 明細までは比べない仕様のため)。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: { embedding: Record<string, unknown>, llmMode: string, arms: Record<string, unknown>[] } } | { ok: false, error: string }}
 */
export function validateBaseline(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "基準値 JSON がオブジェクトでない" };
  }
  const problems = [];
  problems.push(
    ...findEmbeddingFieldProblems(/** @type {any} */ (data).embedding, "基準値.embedding"),
  );
  if (
    typeof (/** @type {any} */ (data).llmMode) !== "string" ||
    /** @type {any} */ (data).llmMode === ""
  ) {
    problems.push("基準値.llmMode が文字列でない、または空");
  }
  const arms = /** @type {any} */ (data).arms;
  if (!Array.isArray(arms)) {
    problems.push("基準値.arms が配列でない");
  } else {
    const seenLabels = new Set();
    const seenArmKeys = new Set();
    arms.forEach((arm, i) => {
      const path = `基準値.arms[${i}]`;
      const armProblems = findScalarFieldProblems(arm, path, {
        stringFields: ARM_STRING_FIELDS,
        numberFields: ARM_NUMBER_FIELDS,
        booleanFields: ARM_BOOLEAN_FIELDS,
      });
      problems.push(...armProblems);
      if (typeof arm === "object" && arm !== null && !isNumberOrNull(arm.associationMaxCount)) {
        problems.push(`${path}.associationMaxCount が数値でも null でもない`);
      }
      const label = /** @type {any} */ (arm)?.armLabel;
      if (typeof label === "string" && label !== "") {
        if (seenLabels.has(label)) {
          problems.push(`基準値.arms に armLabel「${label}」が2件以上ある`);
        }
        seenLabels.add(label);
      }
      // 🔴 同一性の本当の鍵でも重複を見る(冒頭 docstring 参照。measured 側と同じ理由)。
      if (typeof arm === "object" && arm !== null && typeof arm.associationEnabled === "boolean") {
        const armKey = armShortKey(arm);
        if (seenArmKeys.has(armKey)) {
          problems.push(
            `基準値.arms に arm「${armKey}」(associationEnabled/associationMaxCount)が2件以上ある`,
          );
        }
        seenArmKeys.add(armKey);
      }
    });
  }
  if (problems.length > 0) {
    return { ok: false, error: `基準値 JSON が使えない: ${problems.join("; ")}` };
  }
  return {
    ok: true,
    value:
      /** @type {{ embedding: Record<string, unknown>, llmMode: string, arms: Record<string, unknown>[] }} */ (
        data
      ),
  };
}

// ---------------------------------------------------------------------------
// Markdown の組み立て
// ---------------------------------------------------------------------------

function formatMrr(value) {
  return Number(value).toFixed(3);
}

function formatFraction(count, total) {
  return `${count}/${total}`;
}

/** 差分を符号付きの整数として表示する(0 は符号無し)。 */
function formatSignedInt(diff) {
  return diff > 0 ? `+${diff}` : `${diff}`;
}

/** 差分を符号付きの小数(3桁)として表示する(0 は符号無し)。 */
function formatSignedMrr(diff) {
  const fixed = Math.abs(diff).toFixed(3);
  if (diff > 0) return `+${fixed}`;
  if (diff < 0) return `-${fixed}`;
  return fixed;
}

/** `(provider, model, dimensions)` を1つの文字列にする。 */
function formatEmbeddingSpace(embedding) {
  return `${embedding.provider}/${embedding.model}/${embedding.dimensions}次元`;
}

/**
 * ⭐ **`hit@10` は連想枠の効果を測れない、という注記。**
 *
 * 連想枠が拾った候補は `recall()` 本体の `limit` 件の後ろへ連結されて返る
 * (`examples/chat/src/association-probe-set.ts` の docstring、ADR 0151)。
 * ⟹ 連想由来の gold は11位以降にしか現れず、`hit@10` は連想枠が効いているかを
 * 原理的に判定できない。**この関数は毎回同じ文言を返す**——表の下に必ず出すため
 * (毎回計算し直すと、いつか条件分岐で消えることがある)。
 */
function hit10CaveatNote() {
  return (
    "⚠ **`hit@10` は連想枠の効果を測れない。**連想枠が拾った候補は recall() 本体の" +
    " limit 件の後ろへ連結されて返るため(ADR 0151)、連想由来の gold は11位以降にしか" +
    "現れない。`hit@10` が動いていないことを「連想枠が効いていない」と読み違えないこと" +
    "——見るべきは goldReturnedCount / goldRank / mrr である。"
  );
}

/** 基準値の arms を `armShortKey`(同一性の鍵。armLabel ではない)で引けるようにする。 */
function indexBaselineArms(baseline) {
  const byKey = new Map();
  for (const arm of baseline?.arms ?? []) {
    byKey.set(armShortKey(arm), arm);
  }
  return byKey;
}

function buildConditionsLine(measured) {
  return (
    `embedding: ${formatEmbeddingSpace(measured.embedding)} ・ llmMode: ${measured.llmMode} ・ ` +
    `probeCount: ${measured.probeCount} ・ haystackSize: ${measured.haystackSize} ・ ` +
    `recallLimit: ${measured.recallLimit} ・ measuredAt: ${measured.measuredAt} ・ ` +
    `commit: ${measured.commit ?? "(なし)"}`
  );
}

function buildWarmupWarningLines(measured) {
  if (measured.warmup.ok) {
    return [];
  }
  return [
    "",
    "## 🔴 warmup に失敗している——以下の値は測定として成立していない",
    "",
    "`warmup.ok` が `false` だった。ローカル埋め込みモデルの前準備(重みの取得・初回" +
      "推論)に失敗した可能性があり、下の全ての表の数字を実測値として読まないこと。",
    "",
    "detail:",
    "",
    "```",
    measured.warmup.detail ?? "(detail なし)",
    "```",
  ];
}

/** 基準値との差分を短い文字列にまとめる(1セル分)。 */
function formatArmBaselineDiff(arm, baselineArm) {
  if (!baselineArm) {
    return "基準値なし";
  }
  const goldDiff = arm.goldReturnedCount - baselineArm.goldReturnedCount;
  const hit1Diff = arm.hit1Count - baselineArm.hit1Count;
  const hit10Diff = arm.hit10Count - baselineArm.hit10Count;
  const mrrDiff = arm.mrr - baselineArm.mrr;
  return (
    `gold${formatSignedInt(goldDiff)} / hit1${formatSignedInt(hit1Diff)} / ` +
    `hit10${formatSignedInt(hit10Diff)} / MRR${formatSignedMrr(mrrDiff)}`
  );
}

function buildArmSummaryTable(measured, baseline) {
  const baselineArms = baseline ? indexBaselineArms(baseline) : undefined;
  const header = baseline
    ? "| armLabel | 連想枠 | gold(N/probeCount) | うち連想由来 | hit@1 | hit@10 | MRR | 積んだ文字数 | うち連想枠 | 基準値との差 |"
    : "| armLabel | 連想枠 | gold(N/probeCount) | うち連想由来 | hit@1 | hit@10 | MRR | 積んだ文字数 | うち連想枠 |";
  const divider = baseline
    ? "|---|---|---|---|---|---|---|---|---|---|"
    : "|---|---|---|---|---|---|---|---|---|";
  const lines = [header, divider];
  for (const arm of measured.arms) {
    const assocLabel = arm.associationEnabled ? `on(maxCount=${arm.associationMaxCount})` : "off";
    const cells = [
      arm.armLabel,
      assocLabel,
      formatFraction(arm.goldReturnedCount, arm.probeCount),
      formatFraction(arm.goldViaAssociationCount, arm.goldReturnedCount),
      formatFraction(arm.hit1Count, arm.probeCount),
      formatFraction(arm.hit10Count, arm.probeCount),
      formatMrr(arm.mrr),
      String(arm.memoryCharsTotal),
      String(arm.associationCharsTotal),
    ];
    if (baseline) {
      cells.push(formatArmBaselineDiff(arm, baselineArms.get(armShortKey(arm))));
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function buildDeltaTable(measured) {
  const lines = [
    "| 基準arm | 対象arm | Δgold件数 | Δ連想由来件数 | ΔMRR | Δhit@10件数 | Δ文字数 | 1件多く思い出すのに要した文字数 |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const delta of measured.deltas) {
    const charsPer =
      delta.charsPerAdditionalGold === null ? "-" : delta.charsPerAdditionalGold.toFixed(1);
    lines.push(
      `| ${delta.baselineArmLabel} | ${delta.againstArmLabel} | ` +
        `${formatSignedInt(delta.goldReturnedCount)} | ` +
        `${formatSignedInt(delta.goldViaAssociationCount)} | ` +
        `${formatSignedMrr(delta.mrr)} | ${formatSignedInt(delta.hit10Count)} | ` +
        `${formatSignedInt(delta.memoryCharsTotal)} | ${charsPer} |`,
    );
  }
  return lines.join("\n");
}

function buildCategoryTable(measured) {
  const header = `| カテゴリ | ${measured.arms.map((arm) => arm.armLabel).join(" | ")} |`;
  const divider = `|---|${measured.arms.map(() => "---").join("|")}|`;
  const lines = [header, divider];
  for (const category of CATEGORIES) {
    const cells = measured.arms.map((arm) => {
      const probesInCategory = arm.probes.filter((probe) => probe.category === category);
      const hit = probesInCategory.filter((probe) => probe.goldReturned).length;
      return formatFraction(hit, probesInCategory.length);
    });
    lines.push(`| ${category} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function buildProbeDetailTable(measured) {
  const arms = measured.arms;
  const header = [
    "probeId",
    "category",
    ...arms.flatMap((arm) => {
      const key = armShortKey(arm);
      return [`${key}:goldRank`, `${key}:連想由来`, `${key}:anchor経由`];
    }),
  ];
  const divider = header.map(() => "---");
  const lines = [`| ${header.join(" | ")} |`, `| ${divider.join(" | ")} |`];

  const referenceArm = arms[0];
  for (const referenceProbe of referenceArm.probes) {
    const row = [referenceProbe.probeId, referenceProbe.category];
    for (const arm of arms) {
      const probe = arm.probes.find((p) => p.probeId === referenceProbe.probeId);
      if (!probe) {
        row.push("-", "-", "-");
        continue;
      }
      row.push(
        probe.goldRank === null ? "-" : String(probe.goldRank),
        probe.goldRetrievedVia === "association" ? "○" : "-",
        probe.goldAnchoredOnProbeAnchor ? "○" : "-",
      );
    }
    lines.push(`| ${row.join(" | ")} |`);
  }
  return lines.join("\n");
}

function buildStageSkippedSection(measured) {
  const armsWithReasons = measured.arms.filter(
    (arm) => Object.keys(arm.stageSkippedReasons).length > 0,
  );
  if (armsWithReasons.length === 0) {
    return undefined;
  }
  const lines = ["## stageSkippedReasons の内訳", ""];
  for (const arm of armsWithReasons) {
    lines.push(`### ${arm.armLabel}`, "");
    for (const [reason, count] of Object.entries(arm.stageSkippedReasons)) {
      lines.push(`- ${reason}: ${count}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * ⭐ **arm 別の `associationFrameRoles` の内訳**(「連想枠には何が入ったか」、
 * 北極星の問い3)。role の列は実測に現れたものだけを出す(`ASSOCIATION_FRAME_ROLE_VALUES`
 * を決め打ちで並べない——現れなかった role の列を毎回出すと、role が増減したときに
 * この関数を書き換え忘れても気づけない)。
 */
function buildAssociationFrameRolesTable(measured) {
  const roles = new Set();
  for (const arm of measured.arms) {
    for (const role of Object.keys(arm.associationFrameRoles ?? {})) {
      roles.add(role);
    }
  }
  const roleList = [...roles].sort();
  if (roleList.length === 0) {
    return "(どの arm の連想枠にも候補が入らなかった)";
  }
  const header = `| armLabel | ${roleList.join(" | ")} |`;
  const divider = `|---|${roleList.map(() => "---").join("|")}|`;
  const lines = [header, divider];
  for (const arm of measured.arms) {
    const cells = roleList.map((role) => String(arm.associationFrameRoles?.[role] ?? 0));
    lines.push(`| ${arm.armLabel} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

/**
 * ⭐ **同じストア・同じクエリで `recall()` を引き直したとき、連想枠/goldRank が
 * 一致した probe 数**(Issue #291 フォローアップ)。
 *
 * CI で同一 commit を再実行したところ、12 probe 中 10 件で連想枠の構成員が
 * 入れ替わった(一方 `off` arm は probe 別の値まで完全一致した)。原因の候補は2つ:
 * (甲) ingest ごとの差(CI は毎回まっさらな Postgres へ入れ直すため、memory id・
 * 物理配置・HNSW 索引の構築が毎回違う。近似索引である HNSW の誤差が最も大きい帯を
 * 段3.5(連想枠)は定義上採る)、(乙) **同じストアへの引き直しでも変わる**(こちらなら
 * 北極星の問い3「なぜ思い出したかを説明できるか」に直接刺さる)。
 *
 * この表は(甲)/(乙)を切り分けるための計測であって、CI 再実行間の非決定性そのものは
 * 測っていない——**同じ ingest 結果の中で** 2回 `recall()` を呼んだときの一致率を見る。
 * ここで不一致(`repeatFrameIdenticalCount < probeCount`)が出れば(乙)が確定する。
 * 一致し続けるなら、非決定性は ingest 側(甲)に局在している可能性が高い、と読める
 * (ただし「CI 再実行間でも一致するはず」までは、この表だけでは主張できない)。
 */
function buildRepeatConsistencyTable(measured) {
  const header = "| armLabel | 連想枠 | 枠が一致した probe 数 | goldRank が一致した probe 数 |";
  const divider = "|---|---|---|---|";
  const lines = [header, divider];
  for (const arm of measured.arms) {
    const assocLabel = arm.associationEnabled ? `on(maxCount=${arm.associationMaxCount})` : "off";
    lines.push(
      `| ${arm.armLabel} | ${assocLabel} | ` +
        `${formatFraction(arm.repeatFrameIdenticalCount, arm.probeCount)} | ` +
        `${formatFraction(arm.repeatGoldRankSameCount, arm.probeCount)} |`,
    );
  }
  return lines.join("\n");
}

/** `associationMaxCount` が最大の(連想枠が on の)arm を返す。無ければ undefined。 */
function findMaxAssociationCountArm(measured) {
  let best;
  for (const arm of measured.arms) {
    if (!arm.associationEnabled) {
      continue;
    }
    if (!best || (arm.associationMaxCount ?? -1) > (best.associationMaxCount ?? -1)) {
      best = arm;
    }
  }
  return best;
}

/** `associationFrame` の1件を「順位:role(externalId)」の短い文字列にする。 */
function formatAssociationFrameEntry(entry) {
  return `${entry.rank}:${entry.role}(${entry.externalId})`;
}

/**
 * ⭐ **`maxCount` 最大の arm について、gold が返らなかった probe の `associationFrame`
 * を probe ごとに列挙する。**「その枠には代わりに何が入っていたか」を読めるようにする
 * ことが目的(北極星の問い3)——1 probe につき枠の全件を1行にまとめる(長くなりすぎない
 * ように)。連想枠が on の arm が無ければ節ごと出さない(`off` しか無い実測はここでは
 * 起こらないはずだが、`validateMeasured` は「非0にする門」ではないため、壊れていない
 * 範囲で寛容に振る舞う)。
 */
function buildMissedGoldFrameSection(measured) {
  const arm = findMaxAssociationCountArm(measured);
  if (!arm) {
    return undefined;
  }
  const missed = arm.probes.filter((probe) => !probe.goldReturned);
  const lines = [
    `## maxCount 最大の arm(${arm.armLabel})で gold が返らなかった probe の連想枠`,
    "",
  ];
  if (missed.length === 0) {
    lines.push("(この arm では、gold が返らなかった probe は無い)");
    return lines.join("\n");
  }
  lines.push("| probeId | 連想枠の中身(順位:role(externalId)、返った順) |", "|---|---|");
  for (const probe of missed) {
    const frame =
      probe.associationFrame.length > 0
        ? probe.associationFrame.map(formatAssociationFrameEntry).join(", ")
        : "(連想枠に候補が1件も入らなかった)";
    lines.push(`| ${probe.probeId} | ${frame} |`);
  }
  return lines.join("\n");
}

/**
 * `validateMeasured`/`validateBaseline` を通した値から Markdown を組み立てる。
 * **呼び出し側は必ず validate 済みの値を渡すこと**
 * (`identifier-probe-summary-lib.mjs` と同じ分担)。
 *
 * @param {{ measured: Record<string, any>, baseline?: { embedding: Record<string, unknown>, llmMode: string, arms: Record<string, unknown>[] } }} input
 */
export function buildSummaryMarkdown({ measured, baseline }) {
  const lines = ["# association-probes（連想枠 / ADR 0151・Issue #291）", ""];
  lines.push(buildConditionsLine(measured));
  lines.push(...buildWarmupWarningLines(measured));

  lines.push(
    "",
    "## arm 別まとめ",
    "",
    buildArmSummaryTable(measured, baseline),
    "",
    hit10CaveatNote(),
    "",
    "## 基準 off との差分",
    "",
    buildDeltaTable(measured),
    "",
    "## カテゴリ別(gold が返った件数 / カテゴリ内 probe 数)",
    "",
    buildCategoryTable(measured),
    "",
    "## probe 別の明細",
    "",
    buildProbeDetailTable(measured),
    "",
    "## 連想枠の中身(role 別。北極星の問い3「なぜそれを思い出したのかを説明できるか」)",
    "",
    buildAssociationFrameRolesTable(measured),
    "",
    "## 同一ストアで引き直したとき枠が一致した probe 数(Issue #291 フォローアップ)",
    "",
    "同じ ingest 結果に対して同じクエリで `recall()` をもう一度呼び、連想枠/goldRank が" +
      "一致したかを見る(CI 再実行間の非決定性が、ingest 側(HNSW 索引の構築など)に" +
      "局在するのか、同じストアへの引き直しでも起きるのかを切り分けるための計測)。",
    "",
    buildRepeatConsistencyTable(measured),
  );

  const missedGoldFrameSection = buildMissedGoldFrameSection(measured);
  if (missedGoldFrameSection) {
    lines.push("", missedGoldFrameSection);
  }

  const stageSkippedSection = buildStageSkippedSection(measured);
  if (stageSkippedSection) {
    lines.push("", stageSkippedSection);
  }

  lines.push(
    "",
    `⚠ ADR 0033 §3: 標本${measured.probeCount}件からは失敗率も成功率も統計的に主張しない。` +
      "ここで言えるのは「今回、この母数のうち何件成立したか」までである。",
  );

  if (baseline) {
    if (
      baseline.embedding.provider !== measured.embedding.provider ||
      baseline.embedding.model !== measured.embedding.model ||
      baseline.embedding.dimensions !== measured.embedding.dimensions ||
      baseline.llmMode !== measured.llmMode
    ) {
      lines.push(
        "",
        "⚠ 基準値と実測で embedding/llmMode の条件が違う——数字だけを比べても" +
          `意味がない(基準値: ${formatEmbeddingSpace(baseline.embedding)}/${baseline.llmMode}、` +
          `実測: ${formatEmbeddingSpace(measured.embedding)}/${measured.llmMode})。`,
      );
    }
  } else {
    lines.push(
      "",
      "ℹ️ 基準値ファイルが渡されていない——このベンチはまだ CI で実測していないため、" +
        "`examples/chat/association-baseline.json` はまだ存在しない。",
    );
  }

  return lines.join("\n");
}
