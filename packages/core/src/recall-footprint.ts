import {
  DEFAULT_DIGEST_BAND_LIMIT,
  DEFAULT_RECALL_LIMIT,
  DIGEST_BAND_MAX_CHARS,
  DIGEST_BAND_MAX_ENTRY_CHARS,
} from "./recall.js";
import {
  DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS,
  DIGEST_BAND_ENTRY_SEPARATOR_CHARS,
} from "./digest-band.js";
import type { RecallResult } from "./recall.js";

/**
 * `recall-footprint` — **mnemora を使うべき場面か、会話ログを全部積むほうが小さいかを、
 * LLM を呼ばずに判定する純関数**（[Issue #276](https://github.com/takecchi/mnemora/issues/276)）。
 *
 * ## なぜこれが要るか
 *
 * `docs/north-star.md` の物差しは「**使う側が、会話ログを全部プロンプトへ積むのをやめられたか**」
 * であり、問い1は「**毎回渡す量を減らす方向に働くか**」である。
 * **mnemora 自身が、短い会話ではこの問いに落ちる**——`examples/chat/compare-baseline.json`
 * の実測で、2ターンの会話では mnemora のほうが **4.18倍**大きい（交点は 8〜10 ターンの間）。
 *
 * ⟹ 「いつ効くか」を呼び出し側へ答えることは、**物差しそのものを製品の関数にすること**である。
 *
 * ## なぜ LLM が要らないか（北極星の問い5）
 *
 * `recall()` が積む量は `recall-runtime.ts` の
 * `usage.chars = digestChars + indexChars` で決まり、**両項とも構造的な上限を持つ**
 * （`DEFAULT_RECALL_LIMIT` / `DEFAULT_DIGEST_BAND_LIMIT` / `DIGEST_BAND_MAX_CHARS`）。
 * ⟹ mnemora の積む量は会話長に対して **O(1) で頭打ち**になり、会話ログ全部は **Θ(会話長)**。
 * **交点は必ず存在し、算術で出せる。**
 *
 * ## ⚠ 「ターン数の閾値」ではないこと
 *
 * 実測の比は**単調に下がらない**——22ターンで 53.4% まで下がった後、162ターンで 84.7% へ
 * **一度悪化してから**また下がる（目次帯が伸び、やがて上限に当たるため）。
 * ⟹ **「N ターン以上なら得」という形の判定は、この区間で嘘をつく。**
 * だからこのモジュールが入力に取るのは**ターン数ではなく**、
 * 「会話ログ全部だと何文字か」と「スコープ内に Memory が何件あるか」である。
 *
 * ## 呼び出し側の義務
 *
 * **`packages/core` は「会話ログ全部だと何文字か」を知りようがない**（会話ログは
 * 呼び出し側にしか無い）。⟹ その値は必ず引数で受け取る。ここで推定しない。
 *
 * **同じ理由で、連想枠（`RecallQuery.association`、ADR 0151）が実際に何件を
 * 本体へ昇格させるかも、`packages/core` は知りようがない**（ADR 0166）——
 * `RecallFootprintShape.associationCount` として引数で受け取る。省略すれば
 * 連想枠を使わない呼び出しと1バイトも変わらない。
 */

// ---------------------------------------------------------------------------
// 構造定数の写し（較正がいつずれたかに気づくための材料）
// ---------------------------------------------------------------------------

/**
 * 見積もりが依存している、`recall` 側の構造定数の一覧。
 *
 * **なぜ写しを持つのか**: `BUILTIN_RECALL_FOOTPRINT_PROFILE` の係数は
 * **これらの定数が現在の値であったときに測ったもの**である。定数が動けば係数も動く
 * ——特に `digestBandMaxEntryChars` は `recall.ts` 自身が「**⚠ 暫定値である**」と
 * 明記しており、実運用の digest 長が測れたら見直す対象である。
 *
 * ⟹ **既定プロファイルに「どの定数の下で測ったか」を記録しておき、
 * 現在値との一致を歯で検査する**（`recall-footprint.test.ts`）。
 * 定数を動かした人は、既定プロファイルを測り直す必要があることを、
 * **赤いテストとして受け取る。**
 *
 * ⚠ **これが守るのは既定プロファイルだけである。**呼び出し側が
 * `calibrateRecallFootprint` で自分の環境から較正した値については、
 * このリポジトリは何も知らないので、何も検査できない。
 */
export interface FootprintStructuralConstants {
  defaultRecallLimit: number;
  defaultDigestBandLimit: number;
  digestBandMaxChars: number;
  digestBandMaxEntryChars: number;
  digestBandEntryFixedOverheadChars: number;
  digestBandEntrySeparatorChars: number;
}

/** 現在の構造定数。`recall.ts` / `digest-band.ts` の値をそのまま読む（複製した数値を置かない）。 */
export const FOOTPRINT_STRUCTURAL_CONSTANTS: FootprintStructuralConstants = {
  defaultRecallLimit: DEFAULT_RECALL_LIMIT,
  defaultDigestBandLimit: DEFAULT_DIGEST_BAND_LIMIT,
  digestBandMaxChars: DIGEST_BAND_MAX_CHARS,
  digestBandMaxEntryChars: DIGEST_BAND_MAX_ENTRY_CHARS,
  digestBandEntryFixedOverheadChars: DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS,
  digestBandEntrySeparatorChars: DIGEST_BAND_ENTRY_SEPARATOR_CHARS,
};

// ---------------------------------------------------------------------------
// プロファイル（較正済みの係数）とその出所
// ---------------------------------------------------------------------------

/** 較正で決まりうる係数の名前。`borrowedFromDefault` が指すのはこの集合である。 */
export type FootprintCoefficientName = "charsPerDigest" | "fixedIndexChars";

/**
 * 見積もりの**出所**。
 *
 * ⭐ **これが独立した判別可能な欄であることが、この設計の芯である。**
 * `docs/north-star.md`「目指す姿」6本目（逐語）:
 *
 * > **知らないことを、知らないと言える。
 * > ——「見つからなかった」と「探していない」を、同じ顔で返さない。**
 *
 * **較正していない見積もりは「探していない」である。**較正済みの見積もりと
 * 同じ顔で返した瞬間、この姿に反する。⟹ 注記の文字列ではなく、
 * **呼び出し側が `origin.kind` で分岐できる形**にしてある。
 *
 * **2階建てである**（`DigestBandCoverage` の doc と同じ考え方）:
 * - `kind` が `'builtin_default'` ＝ **一度も較正していない。**
 * - `kind` が `'calibrated'` かつ `borrowedFromDefault` が空 ＝ 全係数が実データから決まった。
 * - `kind` が `'calibrated'` かつ `borrowedFromDefault` が非空 ＝ **較正したが、
 *   与えられた標本では決められなかった係数があり、そこだけ既定値のままである。**
 *
 * この3つを1つの真偽値へ潰さないこと。3つ目を1つ目と同じ顔にすると
 * 「較正した」と名乗りながら実は既定値、という最も誤解を生む状態が見えなくなる。
 */
export type FootprintProfileOrigin =
  | {
      kind: "builtin_default";
      /** 何を測った値か（出所。`AGENTS.md`「確かめていないことは確かめていないと書く」）。 */
      measuredFrom: string;
      /** **どの構造定数の下で測ったか。**現在値と違っていれば、この係数は古い。 */
      measuredUnder: FootprintStructuralConstants;
    }
  | {
      kind: "calibrated";
      /** 較正に実際に使えた標本数（渡された標本数とは限らない——下の doc 参照）。 */
      sampleCount: number;
      /** 較正に使った標本の `memoryCount` の範囲。外挿の判定に使う。 */
      observedMemoryCount: { min: number; max: number };
      /** 標本から決められず、既定値のまま残った係数。空なら全部データから決まった。 */
      borrowedFromDefault: readonly FootprintCoefficientName[];
    };

/**
 * 見積もりの係数。**自由な係数は2つだけである。**
 *
 * 他の項（目次帯1件あたりの JSON の器・帯全体の上限・件数上限）は
 * **`recall` 側の構造定数からそのまま決まる**ので、係数として持たない
 * ——持つと、同じ意味の値が2箇所に在って食い違いうる（ADR 0011 と同じ理由）。
 */
export interface RecallFootprintProfile {
  origin: FootprintProfileOrigin;
  /**
   * Memory 1件の digest の平均文字数。
   *
   * `memories` tier（返した分）と `index` tier（目次帯に載る分）の**両方**に効く
   * ——帯の1件の費用は `器(63+1字) + min(charsPerDigest, DIGEST_BAND_MAX_ENTRY_CHARS)` である。
   */
  charsPerDigest: number;
  /**
   * 件数に依らない固定分（`JSON.stringify(indexBand)` のうち、
   * `groups` / `totalInScope` / `countKind` / `digestBandCoverage` などの器）。
   *
   * ⚠ `groups` は群の数に比例して伸びるが、**この係数は定数として扱う。**
   * 較正の標本に群の数の広がりが無く、分離できる根拠が無いためである
   * （分離したければ、群の数を振った標本で較正し直すこと）。
   */
  fixedIndexChars: number;
}

/**
 * 同梱の既定プロファイル。**較正していない呼び出し側のための、初手の値である。**
 *
 * ⚠⚠ **これはこのリポジトリのベンチで測った値であって、あなたの環境の値ではない。**
 * 日本語・`recorded`（記録した実 API の再生、ADR 0051）・`examples/chat` のシナリオで
 * 測った digest の長さに依存しており、**言語・モデル・埋め込み・コーパスが変われば動く。**
 *
 * **それでも同梱している理由**: 較正の材料は `RecallResult` の中に既に全部在り
 * （`usage.chars` / `memories.length` / `index.digestBand`）、
 * **新しい I/O を1本も足さずに較正できる**——つまり較正の敷居が極めて低い。
 * ⟹ 「初手で使えない」損のほうが、「既定値を自分の環境の値と誤解する」損より大きい、
 * と判断した。**誤解のほうは `origin` で防ぐ**（`FootprintProfileOrigin` の doc）。
 *
 * **採らなかった案**: 既定値を同梱せず、較正を必須にする。
 * 誤用は構造的に消えるが、`recall()` を一度も呼んでいない時点
 * （＝「mnemora を入れるべきか」を判断したい、まさにその時点）で
 * この関数が使えなくなる。**問いに答えられない関数は、正しくても役に立たない。**
 */
export const BUILTIN_RECALL_FOOTPRINT_PROFILE: RecallFootprintProfile = {
  origin: {
    kind: "builtin_default",
    measuredFrom:
      "examples/chat/compare-baseline.json（CI の example-chat ジョブが実測し repo に commit した値。" +
      "llmMode=recorded / embeddingMode=recorded、provenance commit d6a0092）の12点のうち、" +
      "目次帯が空の7点（totalInScope <= DEFAULT_RECALL_LIMIT）だけを使った最小二乗。" +
      "帯のある5点は較正に使っていない（hold-out）。",
    measuredUnder: {
      defaultRecallLimit: 10,
      defaultDigestBandLimit: 50,
      digestBandMaxChars: 4000,
      digestBandMaxEntryChars: 120,
      digestBandEntryFixedOverheadChars: 63,
      digestBandEntrySeparatorChars: 1,
    },
  },
  charsPerDigest: 15.458,
  fixedIndexChars: 170.881,
};

/**
 * 見積もりの許容誤差の既定値（`compareWithFullLog` が `'too_close_to_call'` を返す幅）。
 *
 * **出所**: 上の既定プロファイル（帯が空の7点だけで較正）で
 * `compare-baseline.json` の12点すべてを予測したときの**最大残差 1.56%**
 * （帯のある5点＝ hold-out 側の最大は 1.28%）。
 * **その実測に余裕を見て 5% に置いている。**
 *
 * ⚠ **この値は「この関数の精度が常に5%以内である」ことを意味しない。**
 * 意味するのは「**このリポジトリのベンチの12点では 1.56% だった**」ことだけである。
 * 較正していない環境・外挿の領域ではもっと外れうる——そのことは
 * `origin` と `RecallFootprintEstimate.extrapolated` が名乗る。
 */
export const DEFAULT_FOOTPRINT_TOLERANCE = 0.05;

// ---------------------------------------------------------------------------
// 較正
// ---------------------------------------------------------------------------

/**
 * 較正の標本1件。`RecallResult` から `footprintSampleFromRecall` で作れる。
 *
 * **新しい計測を足していない**——3つとも `recall()` が既に返しているものである。
 */
export interface RecallFootprintSample {
  /** `usage.chars`（digest tier + index tier の合計）。 */
  totalChars: number;
  /** `memories.length`。 */
  memoryCount: number;
  /** `index.digestBand?.length ?? 0`。 */
  bandEntryCount: number;
}

/** `RecallResult` から較正の標本を取り出す。**新しい I/O は要らない。** */
export function footprintSampleFromRecall(result: RecallResult): RecallFootprintSample {
  return {
    totalChars: result.usage.chars,
    memoryCount: result.memories.length,
    bandEntryCount: result.index.digestBand?.length ?? 0,
  };
}

/**
 * 標本から係数を較正する。**LLM も DB もネットワークも使わない純関数。**
 *
 * **使うのは `bandEntryCount === 0` の標本だけである。**理由は循環——
 * 帯の項の大きさは `charsPerDigest`（いま求めようとしている係数）に依存するため、
 * 帯のある標本を最小二乗にそのまま混ぜると、求めたい係数が両辺に現れる。
 * **帯が空の標本では `totalChars = fixedIndexChars + memoryCount * charsPerDigest` が
 * 厳密な線形式になる。**
 *
 * ⟹ **帯のある標本は較正に使われないが、捨てられてもいない**——
 * それらは「較正の外にある点」として、予測の検証（hold-out）に使える。
 * 実際、このリポジトリの既定プロファイルはそうやって検証してある。
 *
 * **標本が足りないときに黙って既定値へ倒れない。**どの係数を借りたかは
 * `origin.borrowedFromDefault` に名前で出る（`FootprintProfileOrigin` の doc）。
 *
 * @param samples 較正の標本。`bandEntryCount === 0` のものだけが使われる。
 * @param fallback 決められなかった係数の借り元。既定は同梱プロファイル。
 */
export function calibrateRecallFootprint(
  samples: readonly RecallFootprintSample[],
  fallback: RecallFootprintProfile = BUILTIN_RECALL_FOOTPRINT_PROFILE,
): RecallFootprintProfile {
  const usable = samples.filter((s) => s.bandEntryCount === 0 && s.memoryCount > 0);
  const counts = usable.map((s) => s.memoryCount);
  const observedMemoryCount = {
    min: counts.length > 0 ? Math.min(...counts) : 0,
    max: counts.length > 0 ? Math.max(...counts) : 0,
  };

  const borrowed: FootprintCoefficientName[] = [];
  let charsPerDigest = fallback.charsPerDigest;
  let fixedIndexChars = fallback.fixedIndexChars;

  const distinct = new Set(counts).size;
  if (distinct >= 2) {
    // 2点以上で `memoryCount` が異なる ⟹ 傾きと切片の両方が決まる（最小二乗）。
    const n = usable.length;
    const sx = usable.reduce((a, s) => a + s.memoryCount, 0);
    const sy = usable.reduce((a, s) => a + s.totalChars, 0);
    const sxx = usable.reduce((a, s) => a + s.memoryCount * s.memoryCount, 0);
    const sxy = usable.reduce((a, s) => a + s.memoryCount * s.totalChars, 0);
    const denominator = n * sxx - sx * sx;
    charsPerDigest = (n * sxy - sx * sy) / denominator;
    fixedIndexChars = (sy - charsPerDigest * sx) / n;
  } else if (distinct === 1) {
    // `memoryCount` が1種類しかない ⟹ 切片は決まらない。切片を既定値から借りて、
    // 傾きだけを決める。**借りたことは名前で出す。**
    borrowed.push("fixedIndexChars");
    const n = usable.length;
    const meanY = usable.reduce((a, s) => a + s.totalChars, 0) / n;
    const derived = (meanY - fixedIndexChars) / usable[0]!.memoryCount;
    if (derived > 0) {
      charsPerDigest = derived;
    } else {
      // ⚠ 借りた切片のほうが標本の総量より大きい ⟹ 傾きが 0 以下になる。
      // **digest の平均長が負であることはありえない。**
      //
      // これは「標本が語っていること」ではなく「借りた値がこの環境に合っていない」
      // ことの現れである。⟹ **その値をそのまま係数として採らない。**
      // 借りていない顔で負の係数を返すと、以後の見積もりが静かに壊れる
      // （`chars` が負になり、判定は常に `mnemora_smaller` へ倒れる）。
      //
      // 代わりに **傾きも借りたことにして、名前で出す。**
      // 「決められなかった」を「決めた」と同じ顔で返さないための分岐である
      // （`FootprintProfileOrigin` の doc、北極星「目指す姿」6本目）。
      borrowed.push("charsPerDigest");
    }
  } else {
    // 使える標本がない ⟹ 両方とも借りる。
    borrowed.push("charsPerDigest", "fixedIndexChars");
  }

  return {
    origin: {
      kind: "calibrated",
      sampleCount: usable.length,
      observedMemoryCount,
      borrowedFromDefault: borrowed,
    },
    charsPerDigest,
    fixedIndexChars,
  };
}

// ---------------------------------------------------------------------------
// 見積もり
// ---------------------------------------------------------------------------

/** 見積もりたい状況。**ターン数を取らない**（上の doc「ターン数の閾値ではない」）。 */
export interface RecallFootprintShape {
  /**
   * `recall()` のスコープ内に在る Memory の件数（`RecallResult.index.totalInScope` に相当）。
   *
   * **一度も `recall()` を呼んでいない時点でも見積もれるように、件数そのものを受け取る。**
   * 呼び出し側が持っていないなら、`MemoryStore` の集約1本で取れる（LLM は要らない）。
   */
  memoryCountInScope: number;
  /** `RecallQuery.limit`。省略時は `DEFAULT_RECALL_LIMIT`。 */
  limit?: number;
  /** `RecallQuery.digestBandLimit`。省略時は `DEFAULT_DIGEST_BAND_LIMIT`。 */
  digestBandLimit?: number;
  /**
   * 連想枠（`RecallQuery.association`、ADR 0151）が実際に **本体（memories tier）へ
   * 昇格させると見込む件数**。省略時は `0`（＝連想枠を一切使わない、これまでの呼び出しと
   * 1バイトも変わらない。ADR 0166「後方互換」）。
   *
   * ⚠⚠ **これは `association.maxCount` ではない。**`packages/core` は「連想枠が実際に
   * 何件を本体へ昇格させるか」を `memoryCountInScope` や `maxCount` だけから知りようがない
   * ——実際の昇格件数は、除外集合の外に居る候補の**埋め込み空間上の類似度**
   * （`minSimilarity` の閾値・アンカーごとの ANN 近傍分布）に依存する
   * `recall-runtime.ts` の連想段を見よ）。これは `FullLogComparisonInput.fullLogChars`
   * が「呼び出し側にしか無い値」として引数で渡されるのと同じ理由付けである
   * ——ここで推定しない。呼び出し側が実測（`footprintSampleFromRecall` を使った較正）
   * か、過去の実測から見積もった値を持っているときだけ渡すこと。
   *
   * **構造上の上限**: `memoryCountInScope - min(limit, memoryCountInScope)`
   * （＝ `limit` の外に居る候補の総数）を超える分は、渡しても切り詰められる
   * ——昇格できる候補がそれ以上存在しないため。
   */
  associationCount?: number;
}

/** 見積もりの内訳。**「なぜその数になったか」を後から説明できる形で返す**（北極星の問い3）。 */
export interface RecallFootprintEstimate {
  /** 見積もった総文字数（`RecallUsage.chars` に対応）。 */
  chars: number;
  /**
   * tier 別の内訳。
   *
   * ⚠ **これはモデルによる帰属であって、実測の `RecallUsage.byTier` ではない。**
   * 固定分（`fixedIndexChars`）は丸ごと `index` 側へ帰属させている。
   */
  byTier: { digest: number; index: number };
  /**
   * 返ると見積もった Memory の件数
   * （= `min(limit, memoryCountInScope) + associationCount`。後者は構造上の上限で
   * 切り詰め済み。`shape.associationCount` を渡さなければ後者は常に0）。
   */
  returnedMemories: number;
  /**
   * 連想枠によって本体へ昇格したと見積もった件数（切り詰め後）。
   * `shape.associationCount` を渡さなければ常に `0`。
   */
  associationCount: number;
  /** 目次帯に載ると見積もった件数。 */
  bandEntries: number;
  /** 件数上限（`limit`）で切られているか。切られていれば、会話が伸びても digest tier は増えない。 */
  memoriesCappedByLimit: boolean;
  /** 目次帯が文字数上限（`DIGEST_BAND_MAX_CHARS`）に当たっているか。当たっていれば **以後 mnemora は伸びない。** */
  bandSaturated: boolean;
  /**
   * 較正した標本の範囲の外へ外挿しているか。
   *
   * ⚠ **`origin.kind` が `'builtin_default'` のときは常に `true` である**
   * ——一度も較正していないのだから、あらゆる点が範囲の外である。
   * これも「探していない」を「見つからなかった」と同じ顔で返さないための欄である。
   */
  extrapolated: boolean;
  /** 使ったプロファイルの出所。**そのまま持ち上げる**（呼び出し側が分岐できるように）。 */
  profileOrigin: FootprintProfileOrigin;
}

/** 目次帯1件あたりの JSON 上の費用（器 + 切り詰め後の digest）。 */
function bandEntryChars(charsPerDigest: number): number {
  return (
    DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS +
    DIGEST_BAND_ENTRY_SEPARATOR_CHARS +
    Math.min(charsPerDigest, DIGEST_BAND_MAX_ENTRY_CHARS)
  );
}

/**
 * `recall()` が積むであろう文字数を見積もる。**LLM を呼ばない。DB も引かない。**
 *
 * 式（すべて `recall-runtime.ts` の構造をそのまま写したもの。ADR 0166 で
 * `associationCount` の項を足した——`shape.associationCount` を渡さなければ
 * `連想の件数 = 0` になり、下の式は ADR 0166 以前と1バイトも変わらない）:
 *
 * ```
 * 素の返る件数 = min(limit, memoryCountInScope)
 * 連想の件数   = min(associationCount, memoryCountInScope - 素の返る件数)
 * 返る件数     = 素の返る件数 + 連想の件数
 * 帯の件数     = min(digestBandLimit, memoryCountInScope - 返る件数)
 * 帯の費用     = min(帯の件数 × (63 + 1 + min(charsPerDigest, 120)), DIGEST_BAND_MAX_CHARS)
 * 合計         = fixedIndexChars + 返る件数 × charsPerDigest + 帯の費用
 * ```
 *
 * **連想の項に、新しい自由係数を1つも足していない**（ADR 0166「決めたこと」）。
 * 連想枠が実際にやっているのは「目次帯に載るはずだった候補を、`memories` tier へ
 * 動かす」ことだけであり（`recall-runtime.ts` 段5の `excludeMemoryIds:
 * finalMemories.map(...)` が、連想で昇格した候補も目次帯の対象から除く）、
 * **`returnedMemories` を増やして `bandEligible` を減らす**という、既存の2項
 * （`charsPerDigest` / `fixedIndexChars`）だけで表現できる形で足りる。
 *
 * ⟹ **これが 42〜162ターン行で費用が減り、322〜642ターン行で費用が増えるという
 * 非単調な実測（ADR 0166「なぜ非単調か」）を、この式がそのまま説明する**——
 * 帯が飽和していない領域（`bandEligible <= digestBandLimit`）では、昇格1件ごとに
 * 帯の1件（費用 `63+1+min(charsPerDigest,120)`）が消え、本体の1件
 * （費用 `charsPerDigest`）に置き換わる。このリポジトリの既定プロファイルでは
 * `charsPerDigest`（≒15.5）が帯の1件の費用（≒79.5）より小さいため、**置き換えは
 * 正味で費用を減らす。**帯が既に `digestBandLimit` で頭打ちの領域
 * （`bandEligible > digestBandLimit`）では、昇格した候補はどのみち帯に表示されて
 * いなかった（表示されるのは先頭 `digestBandLimit` 件だけ）ので、帯の費用は
 * 変わらず、本体側の費用だけが純増する。
 */
export function estimateRecallFootprint(
  shape: RecallFootprintShape,
  profile: RecallFootprintProfile = BUILTIN_RECALL_FOOTPRINT_PROFILE,
): RecallFootprintEstimate {
  const inScope = Math.max(0, shape.memoryCountInScope);
  const limit = shape.limit ?? DEFAULT_RECALL_LIMIT;
  const bandLimit = shape.digestBandLimit ?? DEFAULT_DIGEST_BAND_LIMIT;

  const baseReturnedMemories = Math.min(limit, inScope);
  const requestedAssociationCount = Math.max(0, shape.associationCount ?? 0);
  // 構造上の上限: limit の外に居る候補の総数を超えては昇格できない。
  const associationCount = Math.min(
    requestedAssociationCount,
    Math.max(0, inScope - baseReturnedMemories),
  );
  const returnedMemories = baseReturnedMemories + associationCount;
  const bandEligible = Math.max(0, inScope - returnedMemories);
  const bandEntries = Math.min(bandLimit, bandEligible);

  const perEntry = bandEntryChars(profile.charsPerDigest);
  const uncappedBandChars = bandEntries * perEntry;
  const bandChars = Math.min(uncappedBandChars, DIGEST_BAND_MAX_CHARS);

  const digestChars = returnedMemories * profile.charsPerDigest;
  const indexChars = profile.fixedIndexChars + bandChars;

  const extrapolated =
    profile.origin.kind === "builtin_default" ||
    inScope < profile.origin.observedMemoryCount.min ||
    inScope > profile.origin.observedMemoryCount.max;

  return {
    chars: digestChars + indexChars,
    byTier: { digest: digestChars, index: indexChars },
    returnedMemories,
    associationCount,
    bandEntries,
    memoriesCappedByLimit: inScope > limit,
    bandSaturated: uncappedBandChars >= DIGEST_BAND_MAX_CHARS,
    extrapolated,
    profileOrigin: profile.origin,
  };
}

// ---------------------------------------------------------------------------
// 判定（会話ログ全部との比較）
// ---------------------------------------------------------------------------

/**
 * 判定の結論。**真偽値にしていない。**
 *
 * `'too_close_to_call'` は「見積もりの誤差の幅の中に居るので、どちらとも言えない」である
 * ——これを `'full_log_smaller'` 側へ丸めると、**モデルが判断できていないことと、
 * 判断した結果とが同じ顔になる**（北極星「目指す姿」6本目）。
 */
export type FullLogVerdict = "mnemora_smaller" | "full_log_smaller" | "too_close_to_call";

/**
 * 判定の理由。**コードで分岐できる形にする**（文字列の注記にしない）。
 *
 * 北極星の問い3「**この記憶が選ばれた理由を、後から説明できるか**」
 * （オーナーが**第一級の機能**と書いているもの）の、この関数への適用である。
 */
export type FootprintReason =
  /**
   * **見積もった量のうち、どの項がいちばん大きいか。**
   *
   * ⭐ **この札は必ず立つ。**`reasons` が空になりうる形にしないためである——
   * 空の `reasons` は「この判定の理由を1つも説明できない」ことであり、
   * 北極星の問い3（説明できない賢さは採らない）に正面から反する。
   *
   * ⚠ **他の札と違い、これは警告ではない。**「何が効いているか」を名指しするだけである
   * （例: 短い会話では `'fixed_index'` が支配的で、長い会話では `'digest_band'` に移る）。
   */
  | {
      code: "dominant_term";
      term: "memories" | "digest_band" | "fixed_index";
      chars: number;
      /** その項が見積もり総量に占める割合。 */
      shareOfEstimate: number;
    }
  /** mnemora の固定費（目次帯の器など）だけで会話ログ全部を超えている ＝ 会話が短すぎる。 */
  | { code: "full_log_below_fixed_cost"; fixedIndexChars: number; fullLogChars: number }
  /** 目次帯が上限に当たっている ＝ **会話がこれ以上伸びても mnemora は増えない。** */
  | { code: "band_saturated"; bandChars: number }
  /** 件数上限で切られている ＝ 会話が伸びても digest tier は増えない。 */
  | { code: "memories_capped_by_limit"; limit: number; memoryCountInScope: number }
  /** 差が許容誤差の内側にある ＝ **どちらとも言えない。** */
  | { code: "within_tolerance"; tolerance: number; estimatedShare: number }
  /** ⚠ 一度も較正していない既定プロファイルで見積もった。 */
  | { code: "profile_not_calibrated" }
  /** ⚠ 較正した標本の範囲の外へ外挿している。 */
  | { code: "outside_calibrated_range"; observed: { min: number; max: number }; asked: number }
  /** ⚠ 較正はしたが、決められなかった係数があり既定値のままである。 */
  | { code: "coefficients_borrowed"; borrowed: readonly FootprintCoefficientName[] };

export interface FullLogComparisonInput {
  /**
   * **会話ログを全部積んだときの文字数。呼び出し側が実測して渡す。**
   * `packages/core` はこれを知りようがない（会話ログを持っていない）。
   */
  fullLogChars: number;
  shape: RecallFootprintShape;
  profile?: RecallFootprintProfile;
  /** `'too_close_to_call'` を返す幅。既定は `DEFAULT_FOOTPRINT_TOLERANCE`。 */
  tolerance?: number;
}

export interface FullLogComparison {
  verdict: FullLogVerdict;
  /** 見積もった `mnemora / 会話ログ全部`（`compare` ベンチの `mnemoraShareOfNaiveChars` に対応）。 */
  estimatedShare: number;
  /**
   * **会話ログ全部が何文字を超えたら mnemora のほうが小さくなるか。**
   *
   * mnemora 側の量は会話ログの長さに依らない（スコープ内の件数にしか依らない）ので、
   * **交点は「見積もった mnemora の文字数」そのものである。**
   *
   * ⚠ ただし会話が伸びれば `memoryCountInScope` も普通は増えるので、
   * **この交点は「いまの件数のままなら」という条件付きである。**
   */
  breakEvenFullLogChars: number;
  /**
   * 根拠。**空にならない**——`dominant_term` が必ず1枚立つ（`FootprintReason` の doc）。
   *
   * ⚠ **かつてここは「少なくとも出所に関する札が1枚は立つ」と書いていたが、それは誤りだった**
   * 【実測】——較正済み・較正範囲の内側・帯が非飽和・件数が非切り詰め・許容誤差の外、が
   * 重なると出所の札も量の札も1枚も立たず、`reasons` は空配列で返っていた
   * （`recall-footprint.test.ts` の歯が、この doc を信じて書かれて赤くなり発見された）。
   * ⟹ **doc ではなく実装のほうを直した**（`dominant_term` を常に立てる）。
   * 空の `reasons` は「理由を1つも説明できない」ことであり、doc を緩めて済ませてよい
   * 種類の食い違いではない。
   */
  reasons: readonly FootprintReason[];
  /** 見積もりそのもの（内訳を読みたい呼び出し側のために持ち上げる）。 */
  estimate: RecallFootprintEstimate;
}

/**
 * **mnemora を使うべきか、会話ログを全部積むべきかを判定する。**
 *
 * この関数が答えるのは `docs/north-star.md` の物差し
 * 「使う側が、会話ログを全部プロンプトへ積むのをやめられたか」そのものである。
 *
 * ⚠ **量だけを見ている。**「削っても目的の記憶が落ちていないか」は別の問いであり、
 * この関数は答えない（`examples/chat/README.md`「⭐ 削減率だけでは意味を持たない」）。
 * **量で負けていても想起のために mnemora を使う、という判断はありうる**——
 * その判断の材料として量を出すのが、この関数の役目である。
 */
export function compareWithFullLog(input: FullLogComparisonInput): FullLogComparison {
  const profile = input.profile ?? BUILTIN_RECALL_FOOTPRINT_PROFILE;
  const tolerance = input.tolerance ?? DEFAULT_FOOTPRINT_TOLERANCE;
  const estimate = estimateRecallFootprint(input.shape, profile);
  const fullLogChars = Math.max(0, input.fullLogChars);

  const reasons: FootprintReason[] = [];

  // --- 支配項の札（**必ず立つ**。これが `reasons` の非空を構造的に保証する） ---
  const bandChars = estimate.byTier.index - profile.fixedIndexChars;
  const terms = [
    { term: "memories" as const, chars: estimate.byTier.digest },
    { term: "digest_band" as const, chars: bandChars },
    { term: "fixed_index" as const, chars: profile.fixedIndexChars },
  ];
  // 同点のときは上の並び順で先に来たものを採る（決定的にするため。`reduce` は `>` で比較）。
  const dominant = terms.reduce((best, t) => (t.chars > best.chars ? t : best));
  reasons.push({
    code: "dominant_term",
    term: dominant.term,
    chars: dominant.chars,
    shareOfEstimate: estimate.chars > 0 ? dominant.chars / estimate.chars : 0,
  });

  // --- 出所に関する札 ---
  if (profile.origin.kind === "builtin_default") {
    reasons.push({ code: "profile_not_calibrated" });
  } else {
    if (profile.origin.borrowedFromDefault.length > 0) {
      reasons.push({
        code: "coefficients_borrowed",
        borrowed: profile.origin.borrowedFromDefault,
      });
    }
    if (estimate.extrapolated) {
      reasons.push({
        code: "outside_calibrated_range",
        observed: profile.origin.observedMemoryCount,
        asked: input.shape.memoryCountInScope,
      });
    }
  }

  // --- 量の形に関する札 ---
  if (estimate.bandSaturated) {
    reasons.push({ code: "band_saturated", bandChars: DIGEST_BAND_MAX_CHARS });
  }
  if (estimate.memoriesCappedByLimit) {
    reasons.push({
      code: "memories_capped_by_limit",
      limit: input.shape.limit ?? DEFAULT_RECALL_LIMIT,
      memoryCountInScope: input.shape.memoryCountInScope,
    });
  }
  if (fullLogChars < profile.fixedIndexChars) {
    reasons.push({
      code: "full_log_below_fixed_cost",
      fixedIndexChars: profile.fixedIndexChars,
      fullLogChars,
    });
  }

  // --- 結論 ---
  // `fullLogChars === 0` は「会話ログが空」であり、比が定義できない。
  // **0除算の結果（Infinity / NaN）を結論の顔で返さない。**
  const estimatedShare =
    fullLogChars > 0 ? estimate.chars / fullLogChars : Number.POSITIVE_INFINITY;

  let verdict: FullLogVerdict;
  if (Math.abs(estimatedShare - 1) <= tolerance) {
    verdict = "too_close_to_call";
    reasons.push({ code: "within_tolerance", tolerance, estimatedShare });
  } else if (estimatedShare < 1) {
    verdict = "mnemora_smaller";
  } else {
    verdict = "full_log_smaller";
  }

  return {
    verdict,
    estimatedShare,
    breakEvenFullLogChars: estimate.chars,
    reasons,
    estimate,
  };
}
