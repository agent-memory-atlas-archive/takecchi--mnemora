import type {
  ArchiveSweepCostRunJson,
  ArchiveSweepMeanJson,
  ArchiveSweepPhaseJson,
} from "./archive-sweep-json.js";

/** `status: "measured"` のときだけ呼ばれる(`consolidation-cost-format.ts` と同じ形)。 */
type MeasuredArchiveSweepCostRunJson = Extract<ArchiveSweepCostRunJson, { status: "measured" }>;

/** 画面向けの人が読む要約(機械可読な出力は `MNEMORA_ARCHIVE_SWEEP_JSON` の側)。 */
export function formatArchiveSweepCostReport(json: MeasuredArchiveSweepCostRunJson): string {
  const lines: string[] = [];
  lines.push(
    `provider: llm=${json.llmMode} embedding=${json.embeddingMode}/${json.embeddingSpace.model}/${json.embeddingSpace.dimensions}次元`,
  );
  lines.push(
    `probeCount=${json.probeCount} haystackSize=${json.haystackSize} halfLifeHours=${json.halfLifeHours} ` +
      `recallLimit=${json.recallLimit} budgetLadder=[${json.budgetLadder.join(",")}]`,
  );
  lines.push(
    `sweep: supported=${json.sweep.supported} limit=${json.sweep.limit} ` +
      `archivedCount=${json.sweep.archivedCount} reachedLimit=${json.sweep.reachedLimit}`,
  );
  lines.push("");
  lines.push(
    "| phase | activeCount | supersededCount | archivedCount | activeContentChars | " +
      "activeContentTokens | activeDigestChars | activeDigestTokens | allContentChars |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");
  lines.push(formatPhaseStoreRow("before", json.before));
  lines.push(formatPhaseStoreRow("after", json.after));
  lines.push("");
  lines.push(
    "| phase | budget | 平均carriedCount | 平均usageChars | 平均goldRank(除外件数) | " +
      "平均omittedArchivedCount | 平均recalledActiveShare |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  lines.push(formatPhaseRecallRow("before", "unbudgeted", json.before.recall.unbudgeted.mean));
  for (const rung of json.before.recall.budgeted) {
    lines.push(formatPhaseRecallRow("before", `budget=${rung.budgetTokens}`, rung.mean));
  }
  lines.push(formatPhaseRecallRow("after", "unbudgeted", json.after.recall.unbudgeted.mean));
  for (const rung of json.after.recall.budgeted) {
    lines.push(formatPhaseRecallRow("after", `budget=${rung.budgetTokens}`, rung.mean));
  }
  return lines.join("\n");
}

function formatPhaseStoreRow(label: "before" | "after", phase: ArchiveSweepPhaseJson): string {
  const s = phase.store;
  return (
    `| ${label} | ${s.activeCount} | ${s.supersededCount} | ${s.archivedCount} | ` +
    `${s.activeContentChars} | ${s.activeContentTokens} | ${s.activeDigestChars} | ` +
    `${s.activeDigestTokens} | ${s.allContentChars} |`
  );
}

function formatPhaseRecallRow(
  label: "before" | "after",
  budgetLabel: string,
  mean: ArchiveSweepMeanJson,
): string {
  const goldRankCell =
    mean.goldRank === null
      ? `(無し, 除外${mean.goldRankExcludedCount}件)`
      : `${mean.goldRank.toFixed(2)}(除外${mean.goldRankExcludedCount}件)`;
  return (
    `| ${label} | ${budgetLabel} | ${mean.carriedCount.toFixed(2)} | ` +
    `${mean.usageChars.toFixed(1)} | ${goldRankCell} | ` +
    `${mean.omittedArchivedCount.toFixed(2)} | ${mean.recalledActiveShare.toFixed(3)} |`
  );
}
