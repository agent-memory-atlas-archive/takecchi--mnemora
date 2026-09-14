import type { EnvLike } from "./providers.js";
import { DEFAULT_BUDGET_LADDER, DEFAULT_RECALL_LIMIT } from "./consolidation-cost-options.js";

/**
 * `archive-sweep-cost` サブコマンド(Issue #209)が読む環境変数のパース(純関数)。
 *
 * **`budgetLadder`/`recallLimit` の既定値は `consolidation-cost-options.ts` の
 * `DEFAULT_BUDGET_LADDER`/`DEFAULT_RECALL_LIMIT` をそのまま流用する**
 * (`archive-sweep-json.ts` 冒頭の docstring が既に宣言している共有方針)——
 * 予算の階段は「gold を載せるのに要った最小予算」を分解能良く読むために
 * 実測で調整された値であり、書き写すと片方だけ直したときにずれる。
 *
 * `halfLifeHours`/`marginHours` はこの bench 固有(掃引を実行時間内に発火させるための
 * 専用 arm、issue #209 の受け入れ条件1)であり、`consolidation-cost` には無い概念なので
 * 独自に定義する。
 */

/**
 * この bench の tenant に設定する `default_half_life_hours`(既定 720 時間 = 30日)を
 * 短くする値。1時間なら `decayFloorOffsetMs` は約4.32時間——filler を数時間分
 * 過去へ戻すだけで済み、極端な値(秒未満)による丸め誤差や、逆に長すぎる値(720時間の
 * ままなら約130日)による扱いにくさを避けられる。720時間の720分の1であり、
 * 「short life」であることは明確である。
 */
export const DEFAULT_HALF_LIFE_HOURS = 1;

/**
 * filler を backdate するときに、`decayFloorOffsetMs(halfLifeHours)` の上乗せる余裕(時間)。
 * 境界のブレ(浮動小数点・ミリ秒の丸め・observe 呼び出し自体にかかる時間)を吸収する。
 */
export const DEFAULT_MARGIN_HOURS = 0.5;

/** 1回の `sweepArchive` 呼び出しで archived にする上限。既定はこの bench の
 *  `DEFAULT_HAYSTACK_SIZE`(60、`probe-set.ts`)を十分に上回る値。 */
export const DEFAULT_SWEEP_LIMIT = 1000;

export interface ArchiveSweepCostOptions {
  halfLifeHours: number;
  marginHours: number;
  sweepLimit: number;
  budgetLadder: number[];
  recallLimit: number;
}

function parsePositiveInt(varName: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${varName} には正の整数を指定すること(実際: "${value}")。`);
  }
  return parsed;
}

function parsePositiveFloat(varName: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${varName} には正の数値を指定すること(実際: "${value}")。`);
  }
  return parsed;
}

/** `"32,64,128"` のようなカンマ区切りを `number[]` にパースする(`consolidation-cost-options.ts` と同じ形)。 */
function parseBudgetLadder(varName: string, value: string | undefined): number[] {
  if (value === undefined || value === "") {
    return [...DEFAULT_BUDGET_LADDER];
  }
  const parts = value.split(",").map((s) => s.trim());
  const parsed = parts.map((part) => {
    const n = Number(part);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${varName} の各値は正の整数であること(実際: "${value}")。`);
    }
    return n;
  });
  if (parsed.length === 0) {
    throw new Error(`${varName} には少なくとも1つの値が要る(実際: "${value}")。`);
  }
  return parsed;
}

export function parseArchiveSweepCostOptions(env: EnvLike): ArchiveSweepCostOptions {
  return {
    halfLifeHours: parsePositiveFloat(
      "MNEMORA_ARCHIVE_SWEEP_HALF_LIFE_HOURS",
      env.MNEMORA_ARCHIVE_SWEEP_HALF_LIFE_HOURS,
      DEFAULT_HALF_LIFE_HOURS,
    ),
    marginHours: parsePositiveFloat(
      "MNEMORA_ARCHIVE_SWEEP_MARGIN_HOURS",
      env.MNEMORA_ARCHIVE_SWEEP_MARGIN_HOURS,
      DEFAULT_MARGIN_HOURS,
    ),
    sweepLimit: parsePositiveInt(
      "MNEMORA_ARCHIVE_SWEEP_LIMIT",
      env.MNEMORA_ARCHIVE_SWEEP_LIMIT,
      DEFAULT_SWEEP_LIMIT,
    ),
    budgetLadder: parseBudgetLadder(
      "MNEMORA_ARCHIVE_SWEEP_BUDGET_LADDER",
      env.MNEMORA_ARCHIVE_SWEEP_BUDGET_LADDER,
    ),
    recallLimit: parsePositiveInt(
      "MNEMORA_ARCHIVE_SWEEP_RECALL_LIMIT",
      env.MNEMORA_ARCHIVE_SWEEP_RECALL_LIMIT,
      DEFAULT_RECALL_LIMIT,
    ),
  };
}
