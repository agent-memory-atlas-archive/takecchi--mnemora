/**
 * 訂正を含む会話シナリオ（Issue #303）。
 *
 * 北極星「目指す姿」の項目5——**「間違いを正すと、古いほうが先に出てこなくなる。」**
 * ——を、`examples/chat` から実演する。`Runtime.markContested`/`Runtime.resolveContested`
 * （ADR 0134/ADR 0150）は今日まで `packages/core` のテストからしか呼ばれておらず、
 * `examples/` 配下からの呼び出しが0件だった（Issue #303 本文）。
 *
 * **矛盾の判定はこのファイルが構造として宣言する。** ADR 0134 決定2:
 *
 * > 呼び出し側（人・上位のアプリケーション層・将来の自動検出）が既に「この2件は対向する」
 * > と決めていることを前提に
 *
 * ⟹ `contestedPair` は「どちらの externalId とどちらの externalId が対向するか」を
 * **書いた時点で固定された宣言**として持つ。LLM にもヒューリスティクスにも聞かない。
 * 「後のほうが勝つ」という順序規則も使わない——`resolution.winnerId` は `correction` を
 * **name で**指す（`turns` の並び順や `recordedAt` の大小からは一切導かない。
 * `correction-demo.ts` の `runCorrectionDemo` 参照）。
 *
 * **⚠ 北極星の主測定（`compare`/`retrieval`）には一切関わらない。**このファイルは
 * `runComparison`/`runRetrievalQualityArm`/`compare.ts`/`compare-json.ts`/`scenario.ts`/
 * `probe-set.ts`/`naive-path.ts` のいずれも import しない——`scope.ts`/`backfill.ts` と
 * 同じ規律（測定条件を一切共有しない、独立したデモ）。`compare` の⭐門（ADR 0133）への
 * 影響は `__tests__/correction-scenario-compare-isolation.test.ts` で機械的に確かめている。
 */

export interface CorrectionTurn {
  index: number;
  role: "user" | "assistant";
  text: string;
}

/** 対向する2発話をそれぞれ識別する。 */
export interface CorrectionStatement {
  /** `observe()` の `externalId`。冪等性の鍵であり、同時にこのシナリオ内での参照名でもある。 */
  externalId: string;
  text: string;
}

/**
 * 「この2件は対向する」という、呼び出し側が既に下した決定そのもの（ADR 0134 決定2）。
 *
 * **`firstExternalId`/`secondExternalId` の並び順に意味を持たせない。** `markContested`
 * 自身も対称な操作であり（`Runtime.markContested` の doc コメント参照）、この宣言も
 * 「どちらが先か」ではなく「どの2件が組か」だけを運ぶ。
 *
 * **`winnerExternalId` も、この宣言の一部として構造で持つ**（ADR 0150 決定1）。
 * `resolveContested` に渡す `winnerId` は、`turns` の並び順・`recordedAt` の大小・
 * 「後に observe したほうが勝つ」といった順序規則からは一切導かない——**このシナリオが
 * 書いた時点で決め打った値**であり、`correction-demo.ts` はこの欄をそのまま渡すだけである。
 */
export interface ContestedPairDeclaration {
  firstExternalId: string;
  secondExternalId: string;
  /** `resolveContested({ kind: 'supersede', winnerId })` に渡す勝者側の externalId。 */
  winnerExternalId: string;
}

export interface CorrectionScenario {
  /** 表示用の会話全体（filler を挟んだ自然な流れ）。 */
  turns: CorrectionTurn[];
  /** 最初に表明された事実。後に訂正される側。 */
  original: CorrectionStatement;
  /** 訂正の発話。`resolveContested` で勝たせる側（このシナリオが決め打つ）。 */
  correction: CorrectionStatement;
  /** この2発話が対向する、という構造としての宣言。 */
  contestedPair: ContestedPairDeclaration;
  /** 訂正後に尋ねる質問。 */
  query: string;
}

const FILLER_BEFORE = ["今日はいい天気ですね。", "お昼ご飯は何を食べようか迷っています。"];

const FILLER_BETWEEN = ["最近見た映画の感想を話したいです。", "週末は友達と出かける予定です。"];

const FILLER_ASSISTANT = [
  "そうですね、良い一日になりそうです。",
  "軽めのものはいかがでしょうか。",
  "ぜひ聞かせてください。",
  "楽しんできてくださいね。",
];

const ORIGINAL_EXTERNAL_ID = "correction-demo-original-favorite-color";
const CORRECTION_EXTERNAL_ID = "correction-demo-corrected-favorite-color";

/** 最初の表明。訂正される側。 */
const ORIGINAL_TEXT = "私の好きな色は青です。";
/**
 * 訂正の発話。**「後のほうが勝つ」から勝つのではない**——`contestedPair`/`resolution` が
 * 明示的にこちらを勝者として指定しているから勝つ。もし呼び出し側が逆に決めていれば、
 * `original` が勝ち残ったはずである（`correction-demo.test.ts`
 * 「宣言を逆にすると勝敗も入れ替わる」参照）。
 */
const CORRECTION_TEXT = "訂正します。よく考えたら、好きな色は青ではなく赤でした。";

const QUERY_TEXT = "わたしの好きな色を覚えていますか?";

function buildTurns(): CorrectionTurn[] {
  const turns: CorrectionTurn[] = [];
  let index = 0;
  const push = (role: CorrectionTurn["role"], text: string) => {
    turns.push({ index: index++, role, text });
  };

  push("user", FILLER_BEFORE[0]!);
  push("assistant", FILLER_ASSISTANT[0]!);
  push("user", ORIGINAL_TEXT);
  push("assistant", "覚えておきますね。");
  push("user", FILLER_BEFORE[1]!);
  push("assistant", FILLER_ASSISTANT[1]!);
  push("user", FILLER_BETWEEN[0]!);
  push("assistant", FILLER_ASSISTANT[2]!);
  push("user", CORRECTION_TEXT);
  push("assistant", "承知しました。訂正を反映します。");
  push("user", FILLER_BETWEEN[1]!);
  push("assistant", FILLER_ASSISTANT[3]!);

  return turns;
}

/**
 * 固定のシナリオ本体。**同じ長さ・同じ発話**で毎回同じ結果になる
 * （`scenario.ts` の `buildConversation` と同じ、決定論的である方針）。
 */
export const CORRECTION_SCENARIO: CorrectionScenario = {
  turns: buildTurns(),
  original: { externalId: ORIGINAL_EXTERNAL_ID, text: ORIGINAL_TEXT },
  correction: { externalId: CORRECTION_EXTERNAL_ID, text: CORRECTION_TEXT },
  contestedPair: {
    firstExternalId: ORIGINAL_EXTERNAL_ID,
    secondExternalId: CORRECTION_EXTERNAL_ID,
    winnerExternalId: CORRECTION_EXTERNAL_ID,
  },
  query: QUERY_TEXT,
};
