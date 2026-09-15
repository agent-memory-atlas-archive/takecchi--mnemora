/**
 * 意味的関連性の probe set(設計メモ段階の下書きを土台にした本実装。PR 本文 (C))。
 *
 * 狙い: 「意味的に関連する記憶が正しく上位に来るか」を測る。
 *
 * 設計の要:
 *  - gold の質問は、gold の事実と**内容語を共有しない**。擬似 embedding が持つのは
 *    文字コードに由来する語彙的な重なりだけなので、内容語を共有しない質問は
 *    擬似物では引けず、本物の埋め込みでしか引けない。
 *  - `lexicalControl: true` の1件だけは既存ベンチと同じ「語彙が重なる」質問であり、
 *    対照群として置く(擬似物でも通るはずの問い)。
 *  - distractor は「同じ話題・違う主語/値」。これが gold より上に来たら、
 *    「話題は合っているが答えが違う」記憶を返しているということであり、
 *    Recall@10 が緑でも中身は外れている。
 */
export interface Probe {
  id: string;
  /** 会話の冒頭付近で1度だけ表明される事実。これが gold。 */
  fact: string;
  /** 終盤に投げる質問。gold と内容語を共有しない(lexicalControl を除く)。 */
  query: string;
  /** 同じ話題・違う主語や値の記憶。gold より上に来たら「話題は合うが答えが違う」。 */
  distractor: string;
  /** 既存ベンチと同じ、語彙が重なる対照群かどうか。 */
  lexicalControl?: boolean;
}

export const PROBES: Probe[] = [
  {
    id: "color",
    fact: "私の好きな色は青です。誕生日は4月3日です。",
    query: "ところで、わたしの好きな色を覚えていますか?",
    distractor: "妹の好きな色は緑です。",
    lexicalControl: true,
  },
  {
    id: "pet",
    fact: "私は猫を2匹飼っています。",
    query: "うちのペットについて何か知っていますか?",
    distractor: "同僚は犬を3匹飼っています。",
  },
  {
    id: "exercise",
    fact: "毎朝5時に起きてジョギングをしています。",
    query: "私の運動の習慣はどんなものでしたか?",
    distractor: "父は毎晩ウォーキングをしています。",
  },
  {
    id: "diet",
    fact: "牛乳を飲むとお腹を壊します。",
    query: "私が避けたほうがいい食べ物はありますか?",
    distractor: "妻は卵アレルギーがあります。",
  },
  {
    id: "family",
    fact: "弟は札幌に住んでいます。",
    query: "私の家族はどこで暮らしていますか?",
    distractor: "姉は福岡で働いています。",
  },
  {
    id: "language",
    fact: "TypeScript より Rust のほうが好みです。",
    query: "私が一番気に入っているプログラミング言語は何ですか?",
    distractor: "同僚は Go を推しています。",
  },
  {
    id: "travel",
    fact: "来月、京都へ出張します。",
    query: "次の遠出の行き先はどこでしたか?",
    distractor: "先月は大阪へ出張しました。",
  },
];

// ---------------------------------------------------------------------------
// haystack(干し草) — 本 PR で追加(PR 本文 (C).1)
// ---------------------------------------------------------------------------

/**
 * ⚠ 既存の `scenario.ts` の filler(「今日はいい天気ですね。」等の世間話)は使えない。
 * マネージャーが実 API(gpt-4o-mini)で確認した事実として、この種の filler には
 * `{"memories":[]}`(0件)が返る——本物の LLM では記憶にならず、干し草が消えてしまう。
 *
 * 代わりに、**本物の LLM が記憶として抽出するであろう、ありふれた事実の表明**を
 * 決定的に(乱数を使わず)生成する。probe の話題(色・ペット・運動・食べ物/アレルギー・
 * 家族の居住地・プログラミング言語・出張/旅行)とは重ならない領域として、事務手続き・
 * 家電の修理・書籍や文房具の購入・部屋の片付け・郵便物・季節の行事の準備を選んだ。
 *
 * 「1件ずつ内容が違う」ことを保証するため、3つの軸(時間文脈・対象・状態)の組み合わせで
 * 文を作る(`scenario.ts` の filler が固定12行の巡回で同じ文を繰り返すのとは異なる方式—
 * 同じ文が繰り返されると擬似 embedding が同一ベクトルになり、順位付けの試験にならない
 * ため、この benchmark では巡回ではなく直積で一意性を作る)。
 */
const HAYSTACK_TIME_CONTEXT = [
  "今日、",
  "昨日、",
  "先週、",
  "今週末に、",
  "午前中に、",
  "仕事の後で、",
  "休憩時間に、",
  "ふと思い立って、",
] as const;

const HAYSTACK_SUBJECT = [
  "市役所での住民票の再発行",
  "電子レンジの修理",
  "本棚に並べる参考書の購入",
  "玄関まわりの片付け",
  "溜まっていた郵便物の仕分け",
  "年末年始の飾り付けの準備",
  "自転車のパンク修理",
  "冷蔵庫の中の整理",
  "新しいボールペンとノートの購入",
  "洗濯機のフィルター掃除",
] as const;

const HAYSTACK_PREDICATE = [
  "を今日済ませました。",
  "を来週の予定に入れました。",
  "の見積もりを取りました。",
  "がようやく終わりました。",
  "を先延ばしにしていましたが着手しました。",
  "について調べているところです。",
  "を業者に依頼しました。",
  "を明日までに片付けるつもりです。",
] as const;

/**
 * `DEFAULT_TICK_LIMIT`(50、`packages/core/src/runtime.ts`)より大きい値にしてある。
 * 「既定の `tick()` を1回呼ぶだけでは 51件目以降が埋め込まれないまま残る」ことを
 * この benchmark 自身が実際に踏んで見せるため(背景2、`retrieval-quality.ts` 参照)。
 */
export const DEFAULT_HAYSTACK_SIZE = 60;

/**
 * `index` に対して一意な干し草文を返す(決定的、乱数無し)。
 * 3軸(時間文脈8 × 対象10 × 述語8 = 640通り)の直積で組み立てる——
 * `DEFAULT_HAYSTACK_SIZE` を大きく超えない限り、同じ組み合わせは出ない。
 */
export function buildHaystackUtterance(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `buildHaystackUtterance: index は 0 以上の整数である必要がある(実際: ${index})`,
    );
  }
  const subject = HAYSTACK_SUBJECT[index % HAYSTACK_SUBJECT.length]!;
  const predicate =
    HAYSTACK_PREDICATE[Math.floor(index / HAYSTACK_SUBJECT.length) % HAYSTACK_PREDICATE.length]!;
  const timeContext =
    HAYSTACK_TIME_CONTEXT[
      Math.floor(index / (HAYSTACK_SUBJECT.length * HAYSTACK_PREDICATE.length)) %
        HAYSTACK_TIME_CONTEXT.length
    ]!;
  return `${timeContext}${subject}${predicate}`;
}

// ---------------------------------------------------------------------------
// 話題語の重なり検査(機械的) — PR 本文 (C).1「機械的に検査する小さな関数」
// ---------------------------------------------------------------------------

/**
 * probe ごとの話題語。`PROBES` の `fact`/`query`/`distractor` を読んで人手で拾った
 * ものであり、`PROBES` から自動導出してはいない(文全体の部分文字列一致にすると
 * 「私」のようなほぼ全文に現れる語まで「話題語」になってしまい、検査として機能しない
 * ため)。`PROBES` に probe を足したら、ここにも対応する話題語を足すこと。
 */
export const PROBE_TOPIC_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  color: ["色", "青", "緑"],
  pet: ["猫", "犬", "ペット"],
  exercise: ["ジョギング", "運動", "ウォーキング"],
  diet: ["牛乳", "お腹", "食べ物", "アレルギー", "卵"],
  family: ["弟", "姉", "兄", "妹", "父", "母", "家族", "札幌", "福岡", "住んで"],
  language: ["TypeScript", "Rust", "Go", "プログラミング言語"],
  travel: ["出張", "京都", "大阪", "旅行", "遠出"],
};

const ALL_TOPIC_KEYWORDS: string[] = Object.values(PROBE_TOPIC_KEYWORDS).flat();

export interface TopicKeywordViolation {
  index: number;
  text: string;
  keyword: string;
}

/**
 * 干し草の各文が probe の話題語を含んでいないかを機械的に検査する。
 * 空配列を返せば「重なり無し」。
 */
export function findTopicKeywordViolations(utterances: readonly string[]): TopicKeywordViolation[] {
  const violations: TopicKeywordViolation[] = [];
  utterances.forEach((text, index) => {
    for (const keyword of ALL_TOPIC_KEYWORDS) {
      if (text.includes(keyword)) {
        violations.push({ index, text, keyword });
      }
    }
  });
  return violations;
}

// ---------------------------------------------------------------------------
// 会話の組み立て — PR 本文 (C).2・(C).3
// ---------------------------------------------------------------------------

/**
 * `"anchor"` は Issue #291（連想枠、ADR 0151）の probe set（`./association-probe-set.js`）が
 * 使う。**この値を足したことは、既存の呼び出し(`./probe-set.js` 自身・`./identifier-probe-
 * set.js`・`./japanese-name-probe-set.js`)の挙動を1バイトも変えない**——どの集合も
 * `kind: "anchor"` を1件も生成しておらず、`ProbeUtteranceKind` は網羅的な `switch` の
 * 対象になっていない(このファイルにも呼び出し側にも `switch (u.kind)` は無い)。
 */
export type ProbeUtteranceKind = "gold" | "distractor" | "haystack" | "anchor";

export interface ProbeUtterance {
  /** observe() に渡す一意な externalId(PR 本文 (C).3)。返ってきた記憶の系譜を辿る鍵。 */
  externalId: string;
  text: string;
  kind: ProbeUtteranceKind;
  /** gold/distractor/anchor のみ。どの probe に属するか。 */
  probeId?: string;
}

/**
 * `gold-<id>` の externalId 規約。`retrieval-quality.ts` の系譜追跡がこれに依存する。
 */
export function goldExternalId(probeId: string): string {
  return `gold-${probeId}`;
}

/** `distractor-<id>` の externalId 規約。 */
export function distractorExternalId(probeId: string): string {
  return `distractor-${probeId}`;
}

/** `filler-NNNN`(4桁ゼロ埋め)の externalId 規約。 */
export function haystackExternalId(index: number): string {
  return `filler-${String(index).padStart(4, "0")}`;
}

/**
 * 全 probe の gold/distractor + 共有の haystack を1本の会話に組む
 * (PR 本文 (C).2「gold は冒頭付近に置き、その後に haystack を積む」)。
 *
 * **決めたこと**: haystack は7 probe 共通の1本にし、probe ごとには作らない
 * (`arm ごとに別のテナントを使う`という PR 本文 (D) の指示と対にして読むと、
 * 「1 arm = 1 テナント = 1つの会話」という単位になる——probe ごとに別テナントにする
 * 案も検討したが、それだと本物の API を7倍叩くことになり実行コストが7倍に膨らむ上、
 * 「複数の話題が同じスコープに同居している中から正しく引けるか」という、より実運用に
 * 近い状況を検査できなくなる。そのため7 probe の gold/distractor(計14件)を会話の
 * 冒頭にまとめて置き、その後ろに共有の haystack を積む形にした)。
 *
 * gold の直後に同じ probe の distractor を置く。両者は生成時刻がほぼ同時になるため、
 * 順位の差は decay/freshness ではなくスコア(類似度)由来だと言える
 * (`docs/recall.md §7` のスコア内訳を参照)。
 */
export function buildProbeSetConversation(
  haystackSize: number = DEFAULT_HAYSTACK_SIZE,
): ProbeUtterance[] {
  const utterances: ProbeUtterance[] = [];
  for (const probe of PROBES) {
    utterances.push({
      externalId: goldExternalId(probe.id),
      text: probe.fact,
      kind: "gold",
      probeId: probe.id,
    });
    utterances.push({
      externalId: distractorExternalId(probe.id),
      text: probe.distractor,
      kind: "distractor",
      probeId: probe.id,
    });
  }

  const haystackTexts: string[] = [];
  for (let i = 0; i < haystackSize; i += 1) {
    haystackTexts.push(buildHaystackUtterance(i));
  }
  const violations = findTopicKeywordViolations(haystackTexts);
  if (violations.length > 0) {
    throw new Error(
      "buildProbeSetConversation: haystack が probe の話題語と重なっている " +
        `(${violations.length}件): ${JSON.stringify(violations.slice(0, 5))}`,
    );
  }
  haystackTexts.forEach((text, i) => {
    utterances.push({ externalId: haystackExternalId(i), text, kind: "haystack" });
  });

  return utterances;
}
