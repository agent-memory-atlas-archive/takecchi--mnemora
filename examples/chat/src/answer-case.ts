import type { ProviderMode } from "./providers.js";

/**
 * Issue #506 / 親 #498: 「全文経路と記憶経路の最終回答を比較する器」が使う型と採点関数。
 *
 * 🔴 **この器が測るのは配線であって、回答品質ではない。**
 * 同じ会話・同じ質問・同じ回答モデル・同じ採点基準で、naive（全文経路）と mnemora
 * （記憶経路）の最終回答・入力量を対で出す——ここまでが本作業の範囲であり、
 * **着地しても回答品質は未評価のまま**である（Issue #506「この器が何であって、何でないか」）。
 */

export type AnswerCategory =
  | "preference" // 好み
  | "schedule-change" // 予定変更
  | "negation" // 否定
  | "other-person" // 別人の事実
  | "other-period" // 別期間の事実
  | "unknown"; // 未知の質問（会話に根拠が無い）

export interface AnswerCaseTurn {
  role: "user" | "assistant";
  text: string;
}

/** 期待する答え。accept / reject はどちらも省略できない（空配列は許す）。 */
export interface AnswerExpectation {
  /** closed-value: 答えが一意に閉じる質問。must-abstain: 「分からない」と言えること。 */
  kind: "closed-value" | "must-abstain";
  accept: string[];
  reject: string[];
}

/** ⭐ 正解の根拠。実装の出力から正解を作る経路を、型の上で塞ぐ。 */
export interface AnswerGrounds {
  /**
   * 会話のどのターンが答えを含意するか（`conversation` の index）。
   *
   * **空配列を許さない検査を置く**（{@link assertGroundsPresent}）——ただし
   * `category: "unknown"` のときだけ例外的に空配列を許す。unknown は「会話のどこにも
   * 根拠が無い」ことそのものが根拠であり、根拠となるターンを名指しできないことが
   * 構造的に正しいからである。この例外は型では表現していない（`number[]` のまま）——
   * `assertGroundsPresent` という実行時の検査に寄せてある（下記 docstring 参照）。
   */
  turnIndex: number[];
  /** なぜそれが正解か。会話の文面に対する説明であって、実装の挙動の説明ではない。 */
  rationale: string;
  /** docs の該当節（あれば）。 */
  spec?: string;
}

export interface AnswerCase {
  id: string;
  category: AnswerCategory;
  conversation: AnswerCaseTurn[];
  question: string;
  expected: AnswerExpectation;
  grounds: AnswerGrounds;
  /**
   * ⭐ 省略不可。`?` を付けない。
   *
   * **理由**: 「宣言し忘れた」（省略）と「development である」が同じ `undefined` に
   * 潰れてしまうと、あるケースが調整に使ってよいのか held-out なのかを、型からも
   * 実行時の値からも区別できなくなる。`tuningUse` を必須にすることで、書き手が
   * 毎回どちらであるかを明示する（ADR 0095 決定2 の先例——同じ理由で
   * `deterministic: false` と「測っていない」を区別した）。
   */
  tuningUse: "development" | "held-out";
}

/**
 * `grounds.turnIndex` が空配列で、かつ `category !== "unknown"` なら例外を投げる。
 *
 * `unknown` 類だけ空配列を許す（`AnswerGrounds.turnIndex` の docstring 参照）。
 * ケース集合ファイル（`answer-case-set.dev.ts` / `answer-case-set.eval.ts`）と、
 * その単体試験（`__tests__/answer-case.test.ts`）の両方から呼ぶことを想定している。
 */
export function assertGroundsPresent(answerCase: AnswerCase): void {
  if (answerCase.grounds.turnIndex.length === 0 && answerCase.category !== "unknown") {
    throw new Error(
      `assertGroundsPresent: case "${answerCase.id}"（category=${answerCase.category}）の ` +
        "grounds.turnIndex が空である。unknown 以外の類は、根拠となるターンを最低1つ挙げること。",
    );
  }
}

// ---------------------------------------------------------------------------
// 採点
// ---------------------------------------------------------------------------

export type AnswerVerdict = "pass" | "fail" | "indeterminate";

/**
 * 採点の前処理を1箇所にまとめる。NFKC 正規化 → 小文字化 → 空白と一般的な句読点の除去。
 *
 * `\p{P}`（Unicode の Punctuation カテゴリ）は ASCII の句読点だけでなく、日本語の
 * 「、」「。」「「」「」」等も含む（NFKC 後も含む——実測済み。`__tests__/answer-case.test.ts`
 * で固定する）。
 */
export function normalizeForGrading(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, "");
}

/**
 * 一次判定。⛔ LLM を呼ばない。
 *
 * ⚠ **これは `digest`（自由な要約）への文字列一致ではない。**ADR 0052 決定4 が
 * 削除したのはそちらである——`compare.ts` の `factStatementSurvived` が、擬似 LLM の
 * digest が発話そのものだった時代の産物として文字列一致を使っていたのを、系譜の追跡
 * （`sourceObservationId` を辿る）へ置き換えた決定である。
 * ここが対象にするのは**答えが短く閉じる質問への最終回答**であり、言い換えの自由度が
 * 構造的に小さい。⟹ **評価ケースは「答えが短く閉じる質問」だけで構成する、という
 * 制約とセットでのみ成立する**（`answer-case-set.*.ts` が `kind: "closed-value" |
 * "must-abstain"` に絞っているのはそのため）。
 *
 * 判定順序（`reject` を `accept` より先に見る）:
 * - 空文字・空白のみの回答 ⟹ `"indeterminate"`（「答えなかった」を不正解へ倒さない）
 * - `reject` のいずれかを含む ⟹ `"fail"`（⚠ `accept` より先に見る——
 *   「水曜ですが、もとは金曜でした」を `pass` にしないため）
 * - `accept` のいずれかを含む ⟹ `"pass"`
 * - どちらでもない ⟹ `"fail"`
 *
 * `indeterminate` を握り潰さない——三分割は ADR 0222 の先例（`pass`/`fail`/`indeterminate`
 * の3値を、`compare` の門が「比較できていない」を握り潰さないために導入した）に倣う。
 */
export function gradeAnswer(answer: string, expected: AnswerExpectation): AnswerVerdict {
  const normalizedAnswer = normalizeForGrading(answer);
  if (normalizedAnswer.length === 0) {
    return "indeterminate";
  }
  const rejectHit = expected.reject.some((r) => normalizedAnswer.includes(normalizeForGrading(r)));
  if (rejectHit) {
    return "fail";
  }
  const acceptHit = expected.accept.some((a) => normalizedAnswer.includes(normalizeForGrading(a)));
  if (acceptHit) {
    return "pass";
  }
  return "fail";
}

// ---------------------------------------------------------------------------
// 品質を主張させない仕掛け
// ---------------------------------------------------------------------------

/**
 * 回答品質を主張してよい provider の層かどうか。
 *
 * ⛔ `deterministic` の LLM は意味を持たない stub（`DeterministicLLMProvider.complete` は
 * 渡した最後のメッセージの内容をそのまま返す——プロンプト全文を丸ごとエコーするだけで、
 * 質問に「答えて」いない）であり、`docs/autonomy.md` §2.2 決定3 が「意味的品質を測るときに
 * deterministic stub へ置き換えない」と決めている。
 * ⟹ **deterministic での実行は配線の検査であって品質の測定ではない。**
 *
 * `recorded`/`openai`/`local` はここでは `true` を返す——ただし `local` は
 * embedding 専用で LLM 側には存在しない（`ProviderMode` の docstring、`providers.ts`）ため、
 * 実際に `answer` の `llmMode` として渡ってくることは無い（渡ってきても、この関数の
 * 契約としては「deterministic でなければ主張してよい」のままにしておく）。
 */
export function answerQualityClaimable(llmMode: ProviderMode): boolean {
  return llmMode !== "deterministic";
}
