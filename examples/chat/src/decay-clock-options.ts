import type { DecayClock } from "@mnemora/core";
import { assertValidDecayClock } from "@mnemora/core";

/**
 * `examples/chat` の CLI が受け付ける `--decay-clock <wall|activity|either>` フラグ
 * （ADR 0165 決めたこと11「`examples/chat` が実際に `decay_clock` を設定して使う」）。
 *
 * **既存のオプション（`archive-sweep-options.ts`/`consolidation-cost-options.ts`）とは
 * あえて形を変えている。** それらは環境変数（`EnvLike`）から読むベンチ専用の調整値だが、
 * `--decay-clock` は「このテナントをどちらの時計で運用するか」という、利用者が明示的に
 * 選ぶ設定である。マネージャーの指示（ADR 0165 決めたこと11・作業指示）が
 * `process.argv` の CLI フラグとして通すことを名指ししている。
 */
export const DECAY_CLOCK_FLAG = "--decay-clock";

/**
 * `argv`（例: `process.argv.slice(3)`、サブコマンド名より後ろの引数列）から
 * `--decay-clock <value>` を取り出す（純関数）。
 *
 * - フラグが無ければ `undefined`。**呼び出し側はこの場合、`writeDecayClock` を
 *   一度も呼んではならない**——`examples/chat` の既定挙動を1バイトも変えないための
 *   唯一の契約（ADR 0165 決めたこと1・13、既定 `'wall'`）。
 * - フラグは在るが値が無い（末尾に置かれた等）場合は `Error` で失敗する。
 * - 値が `DecayClock` の3値（`'wall'`/`'activity'`/`'either'`）のいずれでもない場合は
 *   `assertValidDecayClock`（`@mnemora/core`）がそのまま `Error` を投げる——
 *   **検査の条件式をここで書き直さない**（作業指示の明示）。
 */
export function parseDecayClockFlag(argv: readonly string[]): DecayClock | undefined {
  const index = argv.indexOf(DECAY_CLOCK_FLAG);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`${DECAY_CLOCK_FLAG} には値が要る('wall'|'activity'|'either')。`);
  }
  assertValidDecayClock(value);
  return value;
}
