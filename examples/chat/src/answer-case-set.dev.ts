import type { AnswerCase } from "./answer-case.js";

/**
 * `answer` ベンチの開発用ケース集合（`tuningUse: "development"`）。
 *
 * ⛔ **会話を生成しない。1件ずつ手で書く。** 各会話は6〜12ターン程度、日本語。
 * 6類（`AnswerCategory`）すべてを最低1件ずつ含む——`__tests__/answer-case.test.ts` が
 * この集合に対して機械的に検査する。
 *
 * ここは**調整に使ってよい**側である。実装のふるまいを見ながらケースを直してよい
 * （`answer-case-set.eval.ts` の冒頭コメントと対になる）。
 */
export const ANSWER_CASE_SET_DEV: AnswerCase[] = [
  {
    id: "pref-tea-over-coffee",
    category: "preference",
    conversation: [
      { role: "user", text: "打ち合わせのとき、飲み物はコーヒーより紅茶のほうが好きです。" },
      { role: "assistant", text: "承知しました。" },
      { role: "user", text: "今日はいい天気ですね。" },
      { role: "assistant", text: "そうですね、良い一日になりそうです。" },
      { role: "user", text: "お昼ご飯は何を食べようか迷っています。" },
      { role: "assistant", text: "軽めのものはいかがでしょうか。" },
      { role: "user", text: "最近見た映画の感想を話したいです。" },
      { role: "assistant", text: "ぜひ聞かせてください。" },
    ],
    question: "打ち合わせのとき、わたしに出す飲み物は何がいいですか?",
    expected: { kind: "closed-value", accept: ["紅茶"], reject: ["コーヒー"] },
    grounds: {
      turnIndex: [0],
      rationale:
        "第0ターンで本人が『コーヒーより紅茶のほうが好き』と明言している。会話中にこれを覆す発言は無い。",
    },
    tuningUse: "development",
  },
  {
    id: "schedule-change-meeting-day",
    category: "schedule-change",
    conversation: [
      { role: "user", text: "来週の定例会議は金曜日にお願いします。" },
      { role: "assistant", text: "承知しました。金曜日で調整します。" },
      { role: "user", text: "最近読んだ本がとても面白かったです。" },
      { role: "assistant", text: "どんな内容の本でしたか。" },
      { role: "user", text: "旅行の計画を立てています。" },
      { role: "assistant", text: "どこへ行く予定ですか。" },
      {
        role: "user",
        text: "すみません、やはり定例会議は水曜日に移してください。金曜日は都合が悪くなりました。",
      },
      { role: "assistant", text: "承知しました。水曜日に変更します。" },
    ],
    question: "来週の定例会議は何曜日ですか?",
    expected: { kind: "closed-value", accept: ["水曜"], reject: ["金曜"] },
    grounds: {
      turnIndex: [0, 6],
      rationale:
        "第0ターンで金曜日と決めたが、第6ターンで『やはり水曜日に移してください』と明示的に変更している。最新の発言が水曜日である。",
    },
    tuningUse: "development",
  },
  {
    id: "negation-moved-city",
    category: "negation",
    conversation: [
      { role: "user", text: "以前は京都に住んでいました。" },
      { role: "assistant", text: "そうなんですね。" },
      { role: "user", text: "運動不足を感じているので何か始めたいです。" },
      { role: "assistant", text: "軽い運動から始めるのがおすすめです。" },
      { role: "user", text: "もう京都には住んでいません。いまは神戸に住んでいます。" },
      { role: "assistant", text: "神戸ですね、承知しました。" },
      { role: "user", text: "料理のレシピを教えてほしいです。" },
      { role: "assistant", text: "得意な食材はありますか。" },
    ],
    question: "わたしはいまどこに住んでいますか?",
    expected: { kind: "closed-value", accept: ["神戸"], reject: ["京都"] },
    grounds: {
      turnIndex: [0, 4],
      rationale:
        "第0ターンで京都に住んでいたと述べているが、第4ターンで『もう京都には住んでいません。いまは神戸です』と明示的に否定・更新している。",
    },
    tuningUse: "development",
  },
  {
    id: "other-person-birthday",
    category: "other-person",
    conversation: [
      { role: "user", text: "わたしの誕生日は4月3日です。妻の誕生日は9月10日です。" },
      { role: "assistant", text: "覚えておきますね。" },
      { role: "user", text: "最近のニュースについてどう思いますか。" },
      { role: "assistant", text: "どのニュースのことでしょうか。" },
      { role: "user", text: "ペットの調子があまり良くないので心配です。" },
      { role: "assistant", text: "早めに病院で診てもらうと安心です。" },
      { role: "user", text: "週末は友達と出かける予定です。" },
      { role: "assistant", text: "楽しんできてくださいね。" },
    ],
    question: "妻の誕生日はいつですか?",
    expected: { kind: "closed-value", accept: ["9月10日", "9月"], reject: ["4月3日", "4月"] },
    grounds: {
      turnIndex: [0],
      rationale:
        "第0ターンで『わたしの誕生日は4月3日、妻の誕生日は9月10日』と2人分の事実が並んでいる。問いは妻の側だけを指しており、本人の4月3日は別人（reject）の値である。",
    },
    tuningUse: "development",
  },
  {
    id: "other-period-city-this-year",
    category: "other-period",
    conversation: [
      { role: "user", text: "去年は札幌で働いていました。今年は福岡で働いています。" },
      { role: "assistant", text: "承知しました。" },
      { role: "user", text: "新しい趣味を始めようと思っています。" },
      { role: "assistant", text: "それは良い挑戦だと思います。" },
      { role: "user", text: "仕事の進捗について相談したいことがあります。" },
      { role: "assistant", text: "詳しく教えていただけますか。" },
    ],
    question: "今年、わたしはどこで働いていますか?",
    expected: { kind: "closed-value", accept: ["福岡"], reject: ["札幌"] },
    grounds: {
      turnIndex: [0],
      rationale:
        "第0ターンで『去年は札幌、今年は福岡』と期間ごとの事実が並んでいる。問いは今年を指しており、去年の札幌は別期間（reject）の値である。",
    },
    tuningUse: "development",
  },
  {
    id: "unknown-blood-type",
    category: "unknown",
    conversation: [
      { role: "user", text: "今日はいい天気ですね。" },
      { role: "assistant", text: "そうですね、良い一日になりそうです。" },
      { role: "user", text: "お昼ご飯は何を食べようか迷っています。" },
      { role: "assistant", text: "軽めのものはいかがでしょうか。" },
      { role: "user", text: "最近見た映画の感想を話したいです。" },
      { role: "assistant", text: "ぜひ聞かせてください。" },
      { role: "user", text: "週末は友達と出かける予定です。" },
      { role: "assistant", text: "楽しんできてくださいね。" },
    ],
    question: "わたしの血液型は何ですか?",
    expected: {
      kind: "must-abstain",
      accept: ["分かりません", "分かりかねます", "聞いていません", "知りません", "存じません"],
      reject: ["A型", "B型", "O型", "AB型"],
    },
    grounds: {
      // ⭐ 採った案: `turnIndex` の空配列を `unknown` のときだけ許す
      // （`AnswerGrounds.turnIndex` の docstring / `assertGroundsPresent` 参照）。
      // 「会話のどこにも根拠が無い」こと自体が根拠なので、根拠となるターンを
      // 名指しできない——空配列のまま持たせる。
      turnIndex: [],
      rationale:
        "会話のどのターンにも血液型についての言及が無い。根拠となるターンが構造的に存在しない。",
    },
    tuningUse: "development",
  },
];
