/**
 * DecayStrategy — Phase 1・純関数（docs/architecture.md §5.7、ADR 0010）。
 *
 * 両方とも純関数であり、状態を保存しない。`strengthAt` の結果はどこにも永続化されない。
 * 永続化されるのは書き込み時に一度だけ計算する `decay_floor_at`（`floorAt` の戻り値）。
 */
export interface DecayParams {
  /** Memory.recordedAt。lastReinforcedAt が無い場合の起点として使う。 */
  recordedAt: Date;
  /** Memory.lastReinforcedAt。無ければ recordedAt を起点にする（ADR 0010）。 */
  lastReinforcedAt?: Date | null;
  strength: number;
  halfLifeHours: number;
}

export interface DecayStrategy {
  strengthAt(now: Date, params: DecayParams): number;
  /** threshold を省略すると `DEFAULT_DECAY_THRESHOLD`（0.05、ADR 0010）が使われる。 */
  floorAt(params: DecayParams, threshold?: number): Date;
}

/** ADR 0010 が固定する既定の減衰閾値。 */
export const DEFAULT_DECAY_THRESHOLD = 0.05;

const MS_PER_HOUR = 1000 * 60 * 60;

function decayBase(params: DecayParams): Date {
  return params.lastReinforcedAt ?? params.recordedAt;
}

/**
 * [ADR 0157](../../../docs/decisions/0157-decay-activity-clock.md) 決めたこと7:
 * 単位を持たない数値核。`elapsed` と `halfLife` が「時間」の単位であろうと「recall 回数」の
 * 単位であろうと、この式自体は変わらない——`floorAt`/`floorSeqAt`（活動時計側は
 * `defaultActivityDecayStrategy.floorAt`）は、この核を「時刻」または「通し番号」で
 * 包むだけの薄いラッパーになる。
 *
 * `strengthAt(now, params) = strength * decayFactor(elapsed, halfLife)` の `elapsed`/`halfLife`
 * 部分だけを切り出したもの。
 */
export function decayFactor(elapsed: number, halfLife: number): number {
  return Math.pow(0.5, elapsed / halfLife);
}

/**
 * `decayFactor` の逆関数側——「`strength` が `threshold` をちょうど下回るまでの `elapsed`」を
 * 返す、単位を持たない数値核（ADR 0157 決めたこと7）。
 *
 * `strength <= threshold`（既に閾値以下）のときは `0` を返す——`floorAt`/`floorSeqAt` 側で
 * 「base をそのまま返す」という既存の分岐（`strength <= threshold` → 経過していない）に
 * 対応する、オフセット版の表現。
 */
export function decayFloorOffset(strength: number, halfLife: number, threshold: number): number {
  if (strength <= threshold) {
    return 0;
  }
  return halfLife * Math.log2(strength / threshold);
}

/**
 * `strengthAt(now, params) = strength * 0.5 ** (elapsedHours / halfLifeHours)`（ADR 0010）。
 *
 * `decayFactor` の薄い包み——`elapsed`/`halfLife` を「時間」の単位で読む実例。
 */
function strengthAt(now: Date, params: DecayParams): number {
  const base = decayBase(params);
  const elapsedHours = (now.getTime() - base.getTime()) / MS_PER_HOUR;
  return params.strength * decayFactor(elapsedHours, params.halfLifeHours);
}

/**
 * `strengthAt` が `threshold` をちょうど下回る時刻。
 *
 * `strength <= threshold`（既に閾値以下）の場合は base をそのまま返す（ADR 0010）。
 * これは「その Memory は作成された時点で既に閾値以下だった」という状態を表し、
 * 呼び出し側から見ると過去の時刻が返る（すでに忘却対象）。
 *
 * `decayFloorOffset` の薄い包み——`elapsed`/`halfLife` を「時間」の単位で読む実例。
 */
function floorAt(params: DecayParams, threshold: number = DEFAULT_DECAY_THRESHOLD): Date {
  const base = decayBase(params);
  const hours = decayFloorOffset(params.strength, params.halfLifeHours, threshold);
  return new Date(base.getTime() + hours * MS_PER_HOUR);
}

export const defaultDecayStrategy: DecayStrategy = {
  strengthAt,
  floorAt,
};

/**
 * ActivityDecayStrategy — 壁時計（`DecayStrategy`）と同じ式を、「recall() が起きた回数」を
 * 単位にして読む実例（[ADR 0157](../../../docs/decisions/0157-decay-activity-clock.md)
 * 決めたこと1・3・7）。
 *
 * | | 起点（base） | 進み方（1単位） | 保存する床 |
 * |---|---|---|---|
 * | 壁時計（`DecayStrategy`） | `lastReinforcedAt ?? recordedAt` | 1時間 | `decayFloorAt`（`Date`） |
 * | 活動時計（本 interface） | 書き込み時点の `activity_seq`（`baseSeq`） | そのテナントで `recall()` が1回起きること | `decayFloorSeq`（`bigint`/`number`） |
 *
 * `ADR 0010` が固定した式（`floor = base + halfLife * log2(strength / threshold)`）そのものは
 * 動かさない——動くのは「その式を何の単位で読むか」だけ（`decayFactor`/`decayFloorOffset`
 * を参照）。
 */
export interface ActivityDecayParams {
  /** 書き込み時（作成・強化）の tenant_activity.activity_seq。 */
  baseSeq: number;
  strength: number;
  /** 単位は「そのテナントで recall() が起きた回数」。 */
  halfLifeRecalls: number;
}

export interface ActivityDecayStrategy {
  strengthAt(nowSeq: number, params: ActivityDecayParams): number;
  /** threshold を省略すると `DEFAULT_DECAY_THRESHOLD`（0.05、ADR 0010）が使われる。 */
  floorAt(params: ActivityDecayParams, threshold?: number): number;
}

function activityStrengthAt(nowSeq: number, params: ActivityDecayParams): number {
  const elapsed = nowSeq - params.baseSeq;
  return params.strength * decayFactor(elapsed, params.halfLifeRecalls);
}

/**
 * `baseSeq + Math.ceil(decayFloorOffset(...))` を返す（整数）。
 *
 * **⭐ `ceil` は意図的である**（ADR 0157 決めたこと4「NULL は…緩い側へ倒す」と同じ向き）。
 * 段1のゲートは `decay_floor_seq > nowSeq`（**狭義**）であり、`decayFloorOffset` が返す実数を
 * そのまま足すと小数を切り捨てる形になり、「まだ閾値を割っていない seq」が
 * `decay_floor_seq <= nowSeq` の側に落ちて忘却ゲートを通ってしまう場面が起こりうる
 * （例: offset = 2.3 のとき、`floor` を `base + 2` にすると `nowSeq = base + 2` の時点で
 * `decay_floor_seq(=base+2) > nowSeq(=base+2)` が false になり、実際にはまだ
 * `strengthAt(nowSeq) > threshold` なのに沈んだ扱いになる）。**`ceil` にして
 * `base + 3` を床にすれば、この境界では `decay_floor_seq > nowSeq` が保たれる。**
 * `strength <= threshold`（`decayFloorOffset` が `0` を返す）ときは `baseSeq` をそのまま返す
 * ——壁時計の `floorAt` が `base` を返すのと同じ分岐。
 */
function activityFloorAt(
  params: ActivityDecayParams,
  threshold: number = DEFAULT_DECAY_THRESHOLD,
): number {
  const offset = decayFloorOffset(params.strength, params.halfLifeRecalls, threshold);
  return params.baseSeq + Math.ceil(offset);
}

export const defaultActivityDecayStrategy: ActivityDecayStrategy = {
  strengthAt: activityStrengthAt,
  floorAt: activityFloorAt,
};
