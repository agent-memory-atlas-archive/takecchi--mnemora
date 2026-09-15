import type { AssociationDeltaJson, AssociationProbeRunJson } from "./association-json.js";

/**
 * `association-probes` の人が読む要約(Markdown の表。`./archive-sweep-format.ts` と
 * 同じ形)。機械可読な出力は `MNEMORA_ASSOCIATION_JSON` の側(`./association-json.js`)。
 */
export function formatAssociationProbeRunReport(json: AssociationProbeRunJson): string {
  const lines: string[] = [];
  lines.push(
    `provider: llm=${json.llmMode} embedding=${json.embedding.provider}/${json.embedding.model}/` +
      `${json.embedding.dimensions}次元`,
  );
  lines.push(
    `probeCount=${json.probeCount} haystackSize=${json.haystackSize} recallLimit=${json.recallLimit}`,
  );
  lines.push("");
  lines.push(
    "| arm | 連想 | maxCount | goldReturned | hit@1 | hit@10 | goldViaAssociation | MRR | " +
      "returnedTotal | memoryChars | associationChars |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const arm of json.arms) {
    lines.push(
      `| ${arm.armLabel} | ${arm.associationEnabled} | ${arm.associationMaxCount ?? "-"} | ` +
        `${arm.goldReturnedCount}/${arm.probeCount} | ${arm.hit1Count}/${arm.probeCount} | ` +
        `${arm.hit10Count}/${arm.probeCount} | ${arm.goldViaAssociationCount} | ` +
        `${arm.mrr.toFixed(3)} | ${arm.returnedMemoryTotal} | ${arm.memoryCharsTotal} | ` +
        `${arm.associationCharsTotal} |`,
    );
  }
  lines.push("");
  lines.push(
    "| baseline | against | ΔgoldReturned | goldViaAssociation | ΔMRR | Δhit@10 | " +
      "ΔmemoryChars | charsPerAdditionalGold |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const delta of json.deltas) {
    lines.push(formatDeltaRow(delta));
  }
  lines.push("");
  for (const arm of json.arms) {
    const reasons = Object.entries(arm.stageSkippedReasons);
    if (reasons.length > 0) {
      lines.push(
        `stageSkipped[${arm.armLabel}]: ` +
          reasons.map(([reason, count]) => `${reason}=${count}`).join(", "),
      );
    }
  }
  return lines.join("\n");
}

function formatDeltaRow(delta: AssociationDeltaJson): string {
  const charsPerGold =
    delta.charsPerAdditionalGold === null ? "(無し)" : delta.charsPerAdditionalGold.toFixed(1);
  return (
    `| ${delta.baselineArmLabel} | ${delta.againstArmLabel} | ${delta.goldReturnedCount} | ` +
    `${delta.goldViaAssociationCount} | ${delta.mrr.toFixed(3)} | ${delta.hit10Count} | ` +
    `${delta.memoryCharsTotal} | ${charsPerGold} |`
  );
}
