/**
 * 「内容は同一・`validFrom`/`validUntil` だけ違う」ペアの probe set（Issue #280、
 * Issue #202 第2弾）。
 *
 * `time-term-probe-set.ts`（ADR 0058）の設計思想をそのまま踏襲する: ペアの2件の本文を
 * 厳密に同一にすることで、`DeterministicEmbeddingProvider` の性質上 `similarity` を
 * 構成上ぴったり同じにし、**recall の結果の違いが `validAt` ゲート由来だとしか
 * 説明できない状況を作る。**
 *
 * `time-term` との違い: 動かす項は `occurredAt`/`recordedAt`（鮮度・減衰）ではなく
 * `validFrom`/`validUntil`（「いつからいつまで真か」の区間）である。測る対象も違う——
 * `time-term` は「どちらが上位に来るか」（順位）だが、この probe set は
 * 「片方が recall の候補にそもそも残るか」（validAt ゲートによる有無の切り替え）である。
 *
 * 各 probe は2つの member を持つ:
 * - `current`: 既定の `validAt`（省略時 = いま）で真であるべき側。
 * - `other`: 既定では真でない側——`otherReason` が `"expired"`（過去に真だった）か
 *   `"not_yet_valid"`（将来真になる）かを表す。
 *
 * `daysAgo` は `time-term-probe-set.ts` と同じ規約——**正で過去、負で未来、`null` で
 * その境界を持たない**（`validFrom`/`validUntil` を渡さない）。
 */
export interface ValidityProbe {
  id: string;
  /** 2回 observe する、まったく同一の本文。ペア内で内容を同一にすることが、この arm の要。 */
  fact: string;
  query: string;
  /** `current` 側の validFrom（daysAgo 規約）。 */
  currentValidFromDaysAgo: number | null;
  /** `current` 側の validUntil（daysAgo 規約）。 */
  currentValidUntilDaysAgo: number | null;
  /** `other` 側の validFrom。 */
  otherValidFromDaysAgo: number | null;
  /** `other` 側の validUntil。 */
  otherValidUntilDaysAgo: number | null;
  /** `other` 側が既定の `validAt` で落ちる理由——`FilteredOmission.condition` の値と揃える。 */
  otherReason: "expired" | "not_yet_valid";
  /**
   * 受け入れ条件1（「この時刻において真だった記憶」を問える）を測るための、過去の
   * `validAt`（daysAgo）。**その時刻では `other` が真で `current` がまだ真になっていない**
   * よう選ぶこと——`otherReason: "expired"` の probe だけが持つ（`not_yet_valid` の
   * probe は、同じ受け入れ条件を別の形で既に測っている前者に譲る。両方に同じ検査を
   * 重複させない）。
   */
  historicalValidAtDaysAgo?: number;
}

/**
 * 2件。`address`（`otherReason: "expired"`）が受け入れ条件1（過去の時点で真だった
 * 記憶を引ける）と条件3（既定では期限切れが隠れる）の両方を測り、`plan`
 * （`otherReason: "not_yet_valid"`）は条件「`validFrom` が未来の記憶が隠れる」を測る。
 *
 * `fact` は probe ごとに十分違う内容にしてある——`time-term-probe-set.ts` の docstring
 * と同じ理由（`DeterministicLLMProvider` の digest 先頭40字切り出しの衝突を避ける）。
 */
export const VALIDITY_PROBES: ValidityProbe[] = [
  {
    id: "address",
    fact: "引っ越し先の郵便番号は123-4567、最寄り駅は花園町駅です。",
    query: "いまの郵便番号と最寄り駅を教えてください。",
    // current: 30日前から無期限に真（＝「今の住所」）。
    currentValidFromDaysAgo: 30,
    currentValidUntilDaysAgo: null,
    // other: 365日前から30日前まで真だった（＝「去年の住所」、30日前に失効）。
    otherValidFromDaysAgo: 365,
    otherValidUntilDaysAgo: 30,
    otherReason: "expired",
    // 100日前の時点では other は真（365日前〜30日前の区間に入る）、
    // current はまだ真になっていない（30日前からなので100日前はその前）。
    historicalValidAtDaysAgo: 100,
  },
  {
    id: "subscription-plan",
    fact: "有料プランはストレージ容量が500ギガバイトまで使えるプランです。",
    query: "いまの有料プランのストレージ容量はどれくらいですか?",
    // current: 10日前から無期限に真（＝「今のプラン」）。
    currentValidFromDaysAgo: 10,
    currentValidUntilDaysAgo: null,
    // other: 30日後から真になる（＝「来月からの新プラン」、まだ真になっていない）。
    otherValidFromDaysAgo: -30,
    otherValidUntilDaysAgo: null,
    otherReason: "not_yet_valid",
  },
];

/** `current-<id>` の externalId 規約。 */
export function currentExternalId(probeId: string): string {
  return `current-${probeId}`;
}

/** `other-<id>` の externalId 規約。 */
export function otherExternalId(probeId: string): string {
  return `other-${probeId}`;
}

export interface ValidityProbeUtterance {
  externalId: string;
  text: string;
  probeId: string;
  member: "current" | "other";
  validFrom: Date | undefined;
  validUntil: Date | undefined;
}

const MS_PER_DAY = 86_400_000;

/** `daysAgo` 規約: 正で過去、負で未来、`null`/`undefined` は境界を持たない（`undefined` を返す）。 */
function daysAgoToDate(now: Date, daysAgo: number | null | undefined): Date | undefined {
  if (daysAgo === null || daysAgo === undefined) {
    return undefined;
  }
  return new Date(now.getTime() - daysAgo * MS_PER_DAY);
}

/**
 * probe の `current`/`other` 2件を組み立てる。**本文（`text`）は厳密に同一。**
 * `validFrom`/`validUntil`（と、在れば）だけが異なる。
 */
export function buildValidityConversation(
  probe: ValidityProbe,
  now: Date,
): ValidityProbeUtterance[] {
  return [
    {
      externalId: currentExternalId(probe.id),
      text: probe.fact,
      probeId: probe.id,
      member: "current",
      validFrom: daysAgoToDate(now, probe.currentValidFromDaysAgo),
      validUntil: daysAgoToDate(now, probe.currentValidUntilDaysAgo),
    },
    {
      externalId: otherExternalId(probe.id),
      text: probe.fact,
      probeId: probe.id,
      member: "other",
      validFrom: daysAgoToDate(now, probe.otherValidFromDaysAgo),
      validUntil: daysAgoToDate(now, probe.otherValidUntilDaysAgo),
    },
  ];
}

/** `historicalValidAtDaysAgo` を実際の `Date` にする。probe が持たなければ `undefined`。 */
export function historicalValidAt(probe: ValidityProbe, now: Date): Date | undefined {
  return daysAgoToDate(now, probe.historicalValidAtDaysAgo);
}
