import type { AnswerCase } from "./answer-case.js";

/**
 * `answer` ベンチの調整に使わないケース集合（held-out、`tuningUse: "held-out"`）。
 *
 * ⛔ **このファイルのケースを見て実装を調整しない。** 見て調整したら、そのケースは以後
 * `development` として扱い、`answer-case-set.dev.ts` へ移すこと（`docs/autonomy.md` §2.2
 * 決定5）。
 * ⚠ **これを機械で強制する手段は無い。ここは規律に残る。**
 *
 * 6類（`AnswerCategory`）すべてを最低1件ずつ含む（`answer-case-set.dev.ts` と同じ最低数）。
 * `unknown` 類の `grounds.turnIndex` の扱いは `answer-case-set.dev.ts` と同じ規約
 * （空配列を `unknown` のときだけ許す。`answer-case.ts` の `AnswerGrounds.turnIndex` /
 * `assertGroundsPresent` 参照）に揃える。
 */
export const ANSWER_CASE_SET_EVAL: AnswerCase[] = [
  {
    id: "pref-window-seat",
    category: "preference",
    conversation: [
      { role: "user", text: "飛行機の座席は、通路側より窓側のほうが好きです。" },
      { role: "assistant", text: "承知しました。" },
      { role: "user", text: "最近のニュースについてどう思いますか。" },
      { role: "assistant", text: "どのニュースのことでしょうか。" },
      { role: "user", text: "料理のレシピを教えてほしいです。" },
      { role: "assistant", text: "得意な食材はありますか。" },
      { role: "user", text: "ペットの調子があまり良くないので心配です。" },
      { role: "assistant", text: "早めに病院で診てもらうと安心です。" },
    ],
    question: "飛行機の座席は、わたしにはどちら側を用意すればいいですか?",
    expected: { kind: "closed-value", accept: ["窓側"], reject: ["通路側"] },
    grounds: {
      turnIndex: [0],
      rationale:
        "第0ターンで本人が『通路側より窓側のほうが好き』と明言している。会話中にこれを覆す発言は無い。",
    },
    tuningUse: "held-out",
  },
  {
    id: "schedule-change-deadline",
    category: "schedule-change",
    conversation: [
      { role: "user", text: "報告書の提出期限は今月の20日でお願いします。" },
      { role: "assistant", text: "承知しました。20日ですね。" },
      { role: "user", text: "週末は友達と出かける予定です。" },
      { role: "assistant", text: "楽しんできてくださいね。" },
      { role: "user", text: "新しい趣味を始めようと思っています。" },
      { role: "assistant", text: "それは良い挑戦だと思います。" },
      {
        role: "user",
        text: "やはり提出期限を25日に延ばしてもらえますか。20日は間に合いそうにありません。",
      },
      { role: "assistant", text: "承知しました。25日に変更します。" },
    ],
    question: "報告書の提出期限はいつですか?",
    expected: { kind: "closed-value", accept: ["25日"], reject: ["20日"] },
    grounds: {
      turnIndex: [0, 6],
      rationale:
        "第0ターンで20日と決めたが、第6ターンで『25日に延ばしてもらえますか』と依頼し、承諾されている。最新の期限は25日である。",
    },
    tuningUse: "held-out",
  },
  {
    id: "negation-moved-job",
    category: "negation",
    conversation: [
      { role: "user", text: "以前はエンジニアとして働いていました。" },
      { role: "assistant", text: "そうなんですね。" },
      { role: "user", text: "今日はいい天気ですね。" },
      { role: "assistant", text: "そうですね、良い一日になりそうです。" },
      { role: "user", text: "いまはエンジニアではなく、デザイナーとして働いています。" },
      { role: "assistant", text: "デザイナーのお仕事ですね、承知しました。" },
      { role: "user", text: "最近見た映画の感想を話したいです。" },
      { role: "assistant", text: "ぜひ聞かせてください。" },
    ],
    question: "わたしはいま何の仕事をしていますか?",
    expected: { kind: "closed-value", accept: ["デザイナー"], reject: ["エンジニア"] },
    grounds: {
      turnIndex: [0, 4],
      rationale:
        "第0ターンでエンジニアだったと述べているが、第4ターンで『いまはエンジニアではなく、デザイナーとして働いています』と明示的に否定・更新している。",
    },
    tuningUse: "held-out",
  },
  {
    id: "other-person-favorite-food",
    category: "other-person",
    conversation: [
      {
        role: "user",
        text: "わたしの好きな食べ物はラーメンです。息子の好きな食べ物はカレーです。",
      },
      { role: "assistant", text: "覚えておきますね。" },
      { role: "user", text: "旅行の計画を立てています。" },
      { role: "assistant", text: "どこへ行く予定ですか。" },
      { role: "user", text: "運動不足を感じているので何か始めたいです。" },
      { role: "assistant", text: "軽い運動から始めるのがおすすめです。" },
      { role: "user", text: "仕事の進捗について相談したいことがあります。" },
      { role: "assistant", text: "詳しく教えていただけますか。" },
    ],
    question: "息子の好きな食べ物は何ですか?",
    expected: { kind: "closed-value", accept: ["カレー"], reject: ["ラーメン"] },
    grounds: {
      turnIndex: [0],
      rationale:
        "第0ターンで『わたしはラーメン、息子はカレー』と2人分の事実が並んでいる。問いは息子の側だけを指しており、本人のラーメンは別人（reject）の値である。",
    },
    tuningUse: "held-out",
  },
  {
    id: "other-period-city-last-year",
    category: "other-period",
    conversation: [
      { role: "user", text: "今年は東京に住んでいます。去年は大阪に住んでいました。" },
      { role: "assistant", text: "承知しました。" },
      { role: "user", text: "最近読んだ本がとても面白かったです。" },
      { role: "assistant", text: "どんな内容の本でしたか。" },
      { role: "user", text: "お昼ご飯は何を食べようか迷っています。" },
      { role: "assistant", text: "軽めのものはいかがでしょうか。" },
    ],
    question: "去年、わたしはどこに住んでいましたか?",
    expected: { kind: "closed-value", accept: ["大阪"], reject: ["東京"] },
    grounds: {
      turnIndex: [0],
      rationale:
        "第0ターンで『今年は東京、去年は大阪』と期間ごとの事実が並んでいる。問いは去年を指しており、今年の東京は別期間（reject）の値である。",
    },
    tuningUse: "held-out",
  },
  {
    id: "unknown-favorite-number",
    category: "unknown",
    conversation: [
      { role: "user", text: "最近のニュースについてどう思いますか。" },
      { role: "assistant", text: "どのニュースのことでしょうか。" },
      { role: "user", text: "新しい趣味を始めようと思っています。" },
      { role: "assistant", text: "それは良い挑戦だと思います。" },
      { role: "user", text: "旅行の計画を立てています。" },
      { role: "assistant", text: "どこへ行く予定ですか。" },
      { role: "user", text: "料理のレシピを教えてほしいです。" },
      { role: "assistant", text: "得意な食材はありますか。" },
    ],
    question: "わたしの好きな数字は何ですか?",
    expected: {
      kind: "must-abstain",
      accept: ["分かりません", "分かりかねます", "聞いていません", "知りません", "存じません"],
      reject: ["7", "3", "8"],
    },
    grounds: {
      // `answer-case-set.dev.ts` の unknown ケースと同じ採用: 空配列を許す。
      turnIndex: [],
      rationale:
        "会話のどのターンにも好きな数字についての言及が無い。根拠となるターンが構造的に存在しない。",
    },
    tuningUse: "held-out",
  },
];
