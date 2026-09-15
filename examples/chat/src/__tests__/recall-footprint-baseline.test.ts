import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_RECALL_FOOTPRINT_PROFILE,
  DEFAULT_RECALL_LIMIT,
  calibrateRecallFootprint,
  compareWithFullLog,
  estimateRecallFootprint,
  type RecallFootprintSample,
} from "@mnemora/core";

/**
 * Issue #276 の `recall-footprint.ts` を、`examples/chat/compare-baseline.json`
 * （CI の `example-chat` ジョブが実測し repo に commit した12点。ADR 0133 により⭐門）に
 * 対して検算する歯。**DB も API キーも要らない**——読むのは commit 済みの JSON だけである。
 *
 * ⚠ `compare-baseline.json` はこの歯の対象そのものであり、**書き換えない**（CIの門）。
 *
 * ## この歯がやっていること
 *
 * `BUILTIN_RECALL_FOOTPRINT_PROFILE` は「12点のうち目次帯が空の7点（`totalInScope <=
 * DEFAULT_RECALL_LIMIT`）だけを使った最小二乗」だと自称している（`recall-footprint.ts` の
 * 該当コメント）。この歯は、**その主張を実際に自分で計算し直して検算する**
 * ——同梱の既定プロファイルを信用せず、`calibrateRecallFootprint` を実際に呼ぶ。
 */

interface BaselineRow {
  turnCount: number;
  totalInScope: number;
  naiveChars: number;
  mnemoraChars: number;
  mnemoraShareOfNaiveChars: number;
  returnedCount: number;
}

interface BaselineFile {
  rowCount: number;
  rows: BaselineRow[];
}

// examples/chat/src/__tests__/ から見て examples/chat/compare-baseline.json は2つ上。
const baselinePath = fileURLToPath(new URL("../../compare-baseline.json", import.meta.url));
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineFile;
const rows = baseline.rows;

/**
 * ⚠ **なぜ 2.5% か**（実測ぎりぎりに置かない理由）。
 *
 * このファイルが実際に検算した値では、12行全体の最大誤差は **2ターン行
 * （`totalInScope=2`）の 1.56%**、較正に使っていない5行（hold-out）側の最大は
 * **82ターン行（`totalInScope=25`）の 1.28%** だった。
 *
 * 閾値をこの実測値（1.56%）ぎりぎりに置くと、浮動小数点の丸め方の違いや
 * 将来の軽微な変更だけで揺れて赤くなりうる——この歯が守りたいのは
 * 「mnemora は頭打ちになる」という主張が実測に対して成立することであって、
 * 「いま測った小数第3位までを固定する」ことではない。2.5% は実測(1.56%)に
 * 約6割の余裕を載せた値である。
 */
const ACCURACY_TOLERANCE = 0.025;

const holdInRows = rows.filter((r) => r.totalInScope <= DEFAULT_RECALL_LIMIT);
const holdOutRows = rows.filter((r) => r.totalInScope > DEFAULT_RECALL_LIMIT);

function relativeError(estimatedChars: number, actualChars: number): number {
  return Math.abs(estimatedChars - actualChars) / actualChars;
}

describe("compare-baseline.json — 前提（行数が変わっていないこと）", () => {
  it("12行のうち、目次帯が空の(totalInScope <= DEFAULT_RECALL_LIMIT)行が7行、そうでない行が5行", () => {
    expect(rows).toHaveLength(12);
    expect(holdInRows).toHaveLength(7);
    expect(holdOutRows).toHaveLength(5);
  });
});

describe("calibrateRecallFootprint — hold-in 7行での較正", () => {
  // 目次帯が空の7行だけを標本にする。これらは totalInScope <= DEFAULT_RECALL_LIMIT なので
  // 全件が返り、目次帯に載る候補が無い(bandEntryCount=0)。
  const samples: RecallFootprintSample[] = holdInRows.map((row) => ({
    totalChars: row.mnemoraChars,
    memoryCount: row.returnedCount,
    bandEntryCount: 0,
  }));
  const calibrated = calibrateRecallFootprint(samples);

  it("borrowedFromDefault が空(7行に memoryCount の広がりがあるため両係数とも決まる)", () => {
    if (calibrated.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(calibrated.origin.borrowedFromDefault).toEqual([]);
    expect(calibrated.origin.sampleCount).toBe(7);
  });

  it("較正した係数がオーナーの実測(charsPerDigest≒15.458 / fixedIndexChars≒170.881)に一致する", () => {
    expect(calibrated.charsPerDigest).toBeCloseTo(15.458, 2);
    expect(calibrated.fixedIndexChars).toBeCloseTo(170.881, 2);
  });

  describe("較正済みプロファイルで12行すべての mnemoraChars を予測する", () => {
    it.each(holdOutRows)(
      "hold-out: turnCount=$turnCount (totalInScope=$totalInScope) の誤差が許容誤差以内",
      (row) => {
        const est = estimateRecallFootprint({ memoryCountInScope: row.totalInScope }, calibrated);
        const err = relativeError(est.chars, row.mnemoraChars);
        expect(err).toBeLessThanOrEqual(ACCURACY_TOLERANCE);
      },
    );

    it("12行全体(較正に使った7行 + hold-outの5行)の最大誤差が許容誤差以内", () => {
      const errors = rows.map((row) => {
        const est = estimateRecallFootprint({ memoryCountInScope: row.totalInScope }, calibrated);
        return relativeError(est.chars, row.mnemoraChars);
      });
      const maxErr = Math.max(...errors);
      expect(maxErr).toBeLessThanOrEqual(ACCURACY_TOLERANCE);
    });
  });

  /**
   * ⚠ **`too_close_to_call` が出る行がありうる。** 実測では:
   * - `totalInScope=4`（10ターン行）: `mnemoraShareOfNaiveChars` ≒ 0.9547（95.5%）。
   *   これは既定許容誤差(5%)の内側に落ち、実際に `too_close_to_call` になる。
   * - `totalInScope=3` のうち `naiveChars=197` の行（8ターン行）: 実測 ≒ 1.0964（109.6%）。
   *   1 には近いが、誤差は約10.3%あり、既定許容誤差(5%)の**外**——`too_close_to_call` には
   *   ならない。
   *
   * `too_close_to_call` は「見積もりが誤差の幅の中に居るのでどちらとも言えない」という
   * 積極的な申告であり、これを「判定を外した」と数えるのは誤り
   * （`recall-footprint.ts` の `FullLogVerdict` の doc）。
   */
  const TOO_CLOSE_TO_CALL_TURN_COUNTS = new Set<number>([10]);

  describe("compareWithFullLog — 12行すべてで判定の向きが実測と一致する(too_close_to_callは除く)", () => {
    it.each(rows)(
      "turnCount=$turnCount (totalInScope=$totalInScope, 実測share=$mnemoraShareOfNaiveChars)",
      (row) => {
        const result = compareWithFullLog({
          fullLogChars: row.naiveChars,
          shape: { memoryCountInScope: row.totalInScope },
          profile: calibrated,
        });

        if (TOO_CLOSE_TO_CALL_TURN_COUNTS.has(row.turnCount)) {
          expect(result.verdict).toBe("too_close_to_call");
          return;
        }

        const expectedDirection =
          row.mnemoraShareOfNaiveChars < 1 ? "mnemora_smaller" : "full_log_smaller";
        expect(result.verdict).toBe(expectedDirection);
      },
    );

    it("8ターン行(totalInScope=3, naiveChars=197, 実測109.6%)は1に近いが許容誤差の外なので full_log_smaller のまま", () => {
      const row = rows.find((r) => r.turnCount === 8);
      if (!row) throw new Error("baseline row not found: turnCount=8");
      const result = compareWithFullLog({
        fullLogChars: row.naiveChars,
        shape: { memoryCountInScope: row.totalInScope },
        profile: calibrated,
      });
      expect(result.verdict).toBe("full_log_smaller");
    });
  });
});

describe("BUILTIN_RECALL_FOOTPRINT_PROFILE（既定プロファイル）でも同じ12行を予測する", () => {
  it("既定プロファイルの最大誤差が許容誤差以内であり、hold-in較正済みプロファイルとほぼ同程度に当たる", () => {
    const samples: RecallFootprintSample[] = holdInRows.map((row) => ({
      totalChars: row.mnemoraChars,
      memoryCount: row.returnedCount,
      bandEntryCount: 0,
    }));
    const calibrated = calibrateRecallFootprint(samples);

    const maxErrDefault = Math.max(
      ...rows.map((row) => {
        const est = estimateRecallFootprint(
          { memoryCountInScope: row.totalInScope },
          BUILTIN_RECALL_FOOTPRINT_PROFILE,
        );
        return relativeError(est.chars, row.mnemoraChars);
      }),
    );
    const maxErrCalibrated = Math.max(
      ...rows.map((row) => {
        const est = estimateRecallFootprint({ memoryCountInScope: row.totalInScope }, calibrated);
        return relativeError(est.chars, row.mnemoraChars);
      }),
    );

    expect(maxErrDefault).toBeLessThanOrEqual(ACCURACY_TOLERANCE);
    // 既定プロファイル自身がこの7行から測ったものである(recall-footprint.ts の
    // BUILTIN_RECALL_FOOTPRINT_PROFILE.origin.measuredFrom を見よ)以上、この歯が
    // hold-in較正し直した値とほぼ一致するはず。ずれるなら既定プロファイルの係数が
    // 古い(誰かが構造定数を変えたのに測り直していない)ということなので、その場合は
    // このテストの失敗をそのまま報告すること。
    expect(Math.abs(maxErrDefault - maxErrCalibrated)).toBeLessThan(0.005);
  });
});
