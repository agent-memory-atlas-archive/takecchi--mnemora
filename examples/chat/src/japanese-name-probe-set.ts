import type { ProbeUtterance } from "./probe-set.js";
import type { ArmProbeSetSpec } from "./identifier-arm.js";
import { DEFAULT_HAYSTACK_SIZE, buildHaystackUtterance } from "./probe-set.js";

/**
 * 日本語の固有名詞を含む probe set(マネージャー指示: 識別子 probe(`./identifier-probe-set.js`)
 * とは別の第2集合として足す)。
 *
 * **背景**: `./identifier-probe-set.js` の30件は、query に含める識別子が
 * `PROJ-1234`/`TICKET-48213`/`@yamada.taro` のような **ASCII 主体**の書式である
 * (日本語の地の文に ASCII の識別子が混じる形)。この集合が実際に測っているのは
 * 「ASCII 識別子を含む query」であり、**すべてが日本語である固有名詞**
 * (人名・組織名・製品名・地名を、ASCII の型番やハンドルを介さず直接書いた query)を
 * 1件も測っていない——これがこの第2の probe set をここに置く理由である。
 *
 * ⛔ **`./identifier-probe-set.js` は1文字も変更していない**(1つも import していない
 * ——弁別構造は真似るが、コードとしては独立している)。
 * ⛔ **`./probe-set.js` も1文字も変更していない**(`buildHaystackUtterance`/
 * `DEFAULT_HAYSTACK_SIZE` を import して `sparse` haystack に再利用するだけである)。
 *
 * **弁別構造は `./identifier-probe-set.js` と同じ**——gold と distractor は
 * 「同じ書式・違う対象」にする(例: `PROJ-1234` に対する `PROJ-5678`)。distractor が
 * gold より上に来たら「書式は合っているが対象が違う」ものを返しているということであり、
 * 固有名詞の取り違えそのものである。この集合では書式の軸を4種の日本語カテゴリに
 * 対応させる:
 *
 * - `person`(4件): **同じ姓・違う名**(例: `藤井健太` に対する `藤井大輝`)
 * - `org`(3件): 同じ組織の別部署(例: `蒼天ロジスティクスの第一営業部` に対する
 *   `蒼天ロジスティクスの第二営業部`)
 * - `product`(3件): 同じ製品系列の別版/別名(例: `かがやき手帳` に対する `かがやき台帳`)
 * - `place`(2件): 同じ都道府県の別拠点(例: `浜松支店` に対する `静岡支店`。
 *   いずれも静岡県内の別拠点であり、`人名の例(藤井健太/藤井大輝)`と同型の
 *   「同じ大分類・違う個体」を地名で表す)
 *
 * **query は固有名詞そのものを含む**(`./identifier-probe-set.js` と同じ狙い。
 * 言い換えクイズにしない——「その文字列を含むか」で引きたいのが Issue #106 の
 * 報告者の要求そのものだからである)。
 */
export interface JapaneseNameProbe {
  id: string;
  category: "person" | "org" | "product" | "place";
  /** 会話の冒頭付近で1度だけ表明される、固有名詞を含む事実。これが gold。 */
  fact: string;
  /** 終盤に投げる質問。**固有名詞そのものを含む**。 */
  query: string;
  /** 同じ書式・違う対象の記憶。gold より上に来たら「書式は合うが対象が違う」。 */
  distractor: string;
}

export const JAPANESE_NAME_PROBES: JapaneseNameProbe[] = [
  // --- person(同じ姓・違う名) ---
  {
    id: "person-a",
    category: "person",
    fact: "藤井健太さんは総務部に所属しています。",
    query: "藤井健太さんはどの部署に所属していますか?",
    distractor: "藤井大輝さんは経理部に所属しています。",
  },
  {
    id: "person-b",
    category: "person",
    fact: "三浦陽子さんは広報部の担当です。",
    query: "三浦陽子さんはどの部署の担当ですか?",
    distractor: "三浦真由美さんは人事部の担当です。",
  },
  {
    id: "person-c",
    category: "person",
    fact: "小島誠さんは品質保証部のリーダーです。",
    query: "小島誠さんはどの部署のリーダーですか?",
    distractor: "小島学さんは開発部のリーダーです。",
  },
  {
    id: "person-d",
    category: "person",
    fact: "桐生美咲さんは法務部に配属されました。",
    query: "桐生美咲さんはどの部署に配属されましたか?",
    distractor: "桐生麻衣さんは営業部に配属されました。",
  },
  // --- org(同じ組織の別部署) ---
  {
    id: "org-a",
    category: "org",
    fact: "蒼天ロジスティクスの第一営業部は関東エリアを担当しています。",
    query: "蒼天ロジスティクスの第一営業部はどのエリアを担当していますか?",
    distractor: "蒼天ロジスティクスの第二営業部は関西エリアを担当しています。",
  },
  {
    id: "org-b",
    category: "org",
    fact: "北陵物産株式会社の開発一課はモバイルアプリを担当しています。",
    query: "北陵物産株式会社の開発一課は何を担当していますか?",
    distractor: "北陵物産株式会社の開発二課は基幹システムを担当しています。",
  },
  {
    id: "org-c",
    category: "org",
    fact: "桜庭商事株式会社の東日本支社は法人向け営業を担当しています。",
    query: "桜庭商事株式会社の東日本支社は何を担当していますか?",
    distractor: "桜庭商事株式会社の西日本支社は個人向け営業を担当しています。",
  },
  // --- product(同じ製品系列の別版/別名) ---
  {
    id: "product-a",
    category: "product",
    fact: "かがやき手帳は来月にアップデートが予定されています。",
    query: "かがやき手帳はいつアップデートが予定されていますか?",
    distractor: "かがやき台帳は来週にアップデートが予定されています。",
  },
  {
    id: "product-b",
    category: "product",
    fact: "きらめき工房は今期から月額料金プランに変わりました。",
    query: "きらめき工房は今期から何のプランに変わりましたか?",
    distractor: "きらめき道場は来期から年額料金プランに変わります。",
  },
  {
    id: "product-c",
    category: "product",
    fact: "はるか会計は来週に新機能がリリースされます。",
    query: "はるか会計はいつ新機能がリリースされますか?",
    distractor: "はるか給与は再来週に新機能がリリースされます。",
  },
  // --- place(同じ都道府県の別拠点) ---
  {
    id: "place-a",
    category: "place",
    fact: "浜松支店は来月に移転する予定です。",
    query: "浜松支店はいつ移転する予定ですか?",
    distractor: "静岡支店は来年に移転する予定です。",
  },
  {
    id: "place-b",
    category: "place",
    fact: "札幌配送センターは24時間稼働しています。",
    query: "札幌配送センターは何時間稼働していますか?",
    distractor: "旭川配送センターは12時間稼働しています。",
  },
];

// ---------------------------------------------------------------------------
// 固有名詞の重なり検査(機械的) — `./identifier-probe-set.js` の
// `IDENTIFIER_TOPIC_KEYWORDS`/`findIdentifierTopicKeywordViolations` と同じ形。
// ---------------------------------------------------------------------------

/**
 * probe ごとの固有名詞(fact/query/distractor に登場する、gold/distractor を
 * 弁別する固有名詞そのもの)。`./identifier-probe-set.js` の
 * `IDENTIFIER_TOPIC_KEYWORDS` と同じ理由で、`JAPANESE_NAME_PROBES` から
 * 自動導出せず人手で書き出す。`JAPANESE_NAME_PROBES` に probe を足したら、
 * ここにも対応する固有名詞を足すこと。
 *
 * ⚠ **日本語は部分文字列一致が起きやすい**(`山田太郎` と `山田` など)。
 * ここでは常に「姓+名」「組織+部署」のように**完全な固有名詞のまとまり**を1つの
 * キーワードにしており、姓だけ・組織名だけを単独のキーワードにはしていない
 * ——単独の姓をキーワードにすると、無関係な同姓の haystack 文まで違反として
 * 拾ってしまい、検査として粗すぎる。
 */
export const JAPANESE_NAME_TOPIC_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "person-a": ["藤井健太", "藤井大輝"],
  "person-b": ["三浦陽子", "三浦真由美"],
  "person-c": ["小島誠", "小島学"],
  "person-d": ["桐生美咲", "桐生麻衣"],
  "org-a": ["蒼天ロジスティクスの第一営業部", "蒼天ロジスティクスの第二営業部"],
  "org-b": ["北陵物産株式会社の開発一課", "北陵物産株式会社の開発二課"],
  "org-c": ["桜庭商事株式会社の東日本支社", "桜庭商事株式会社の西日本支社"],
  "product-a": ["かがやき手帳", "かがやき台帳"],
  "product-b": ["きらめき工房", "きらめき道場"],
  "product-c": ["はるか会計", "はるか給与"],
  "place-a": ["浜松支店", "静岡支店"],
  "place-b": ["札幌配送センター", "旭川配送センター"],
};

const ALL_JAPANESE_NAME_KEYWORDS: string[] = Object.values(JAPANESE_NAME_TOPIC_KEYWORDS).flat();

export interface JapaneseNameKeywordViolation {
  index: number;
  text: string;
  keyword: string;
}

/**
 * `./identifier-probe-set.js` の `findIdentifierTopicKeywordViolations` と同じ形の検査を、
 * この日本語固有名詞 probe set に対して行う。haystack の各文が `JAPANESE_NAME_PROBES` の
 * 固有名詞を(偶然にも)含んでいないかを機械的に見る。空配列を返せば「重なり無し」。
 */
export function findJapaneseNameTopicKeywordViolations(
  utterances: readonly string[],
): JapaneseNameKeywordViolation[] {
  const violations: JapaneseNameKeywordViolation[] = [];
  utterances.forEach((text, index) => {
    for (const keyword of ALL_JAPANESE_NAME_KEYWORDS) {
      if (text.includes(keyword)) {
        violations.push({ index, text, keyword });
      }
    }
  });
  return violations;
}

// ---------------------------------------------------------------------------
// 密な haystack(固有名詞が密な干し草)
// ---------------------------------------------------------------------------

export type JapaneseNameHaystackKind = "sparse" | "dense";

interface DenseJapaneseNameFamily {
  /** このファミリーが対応する probe の `category`(設計メモ、表示・集計には使わない)。 */
  id: string;
  /** このファミリーが提供する干し草の件数。 */
  count: number;
  /** ファミリー内の連番(0始まり)から、`JAPANESE_NAME_PROBES` に無い新しい固有名詞を作る。 */
  identifierAt: (n: number) => string;
  /** 固有名詞を埋め込んだ、ありふれた事務連絡文(意味は無害・probe の話題とは無関係)。 */
  sentenceFor: (identifier: string) => string;
}

/** person ファミリー用の姓(10件、`JAPANESE_NAME_PROBES` の姓(藤井/三浦/小島/桐生)とは
 *  重ならない値を選んである)。 */
const DENSE_PERSON_SURNAMES = [
  "大河内",
  "早乙女",
  "日野",
  "宇佐美",
  "真壁",
  "九条",
  "東雲",
  "時任",
  "黒木",
  "西園寺",
] as const;

/** person ファミリー用の名(2件)。姓10×名2=20件で一意な氏名を作る。 */
const DENSE_PERSON_GIVEN_NAMES = ["俊介", "沙耶香"] as const;

/** org ファミリー用の組織名(15件、`JAPANESE_NAME_PROBES` の組織名
 *  (蒼天ロジスティクス/北陵物産株式会社/桜庭商事株式会社)とは重ならない値を選んである)。 */
const DENSE_ORG_NAMES = [
  "彩雲物流株式会社",
  "銀河製作所",
  "飛鳥商会",
  "蒼海運輸",
  "若葉電機",
  "朝凪食品",
  "天狼精密",
  "水明堂",
  "橙灯商事",
  "紅葉紡績",
  "青嵐建設",
  "白鷺運送",
  "碧空印刷",
  "黎明化学",
  "風待ち通信",
] as const;

/** product ファミリー用の製品名(15件、`JAPANESE_NAME_PROBES` の製品名
 *  (かがやき手帳/かがやき台帳/きらめき工房/きらめき道場/はるか会計/はるか給与)とは
 *  重ならない値を選んである)。 */
const DENSE_PRODUCT_NAMES = [
  "ひかり手帳",
  "つばさ会計",
  "なぎさ工房",
  "あかつき道場",
  "ゆうなぎ給与",
  "いぶき台帳",
  "こもれび管理",
  "しののめ受付",
  "ゆらぎ在庫",
  "はしだて経理",
  "みずかがみ勤怠",
  "そよかぜ発注",
  "ほしあかり検品",
  "わたぼうし精算",
  "かたわれ月報",
] as const;

/** place ファミリー用の拠点名(10件、`JAPANESE_NAME_PROBES` の拠点名
 *  (浜松支店/静岡支店/札幌配送センター/旭川配送センター)とは重ならない値を選んである)。 */
const DENSE_PLACE_NAMES = [
  "前橋営業所",
  "高崎倉庫",
  "甲府配送拠点",
  "諏訪工場",
  "飯田物流センター",
  "松本サービスセンター",
  "伊那出張所",
  "岡谷支所",
  "塩尻中継所",
  "茅野受付窓口",
] as const;

/**
 * `JAPANESE_NAME_PROBES`(12件、person 4 / org 3 / product 3 / place 2)の配分に
 * 比例させて(× 5)、ファミリーごとの件数を 20 / 15 / 15 / 10(合計60)に固定した。
 *
 * 🔑 **なぜ 60 件(密度 60/12 = 5:1)か**: これは `./identifier-probe-set.js` の
 * 識別子ベンチが**最初に設計されたとき**の密度と同じ比である(当初12 probe に対し
 * dense haystack 60件、`DENSE_IDENTIFIER_FAMILIES` 参照。その後 probe が12→30件へ
 * 増えても dense haystack の60件は増やしていない——「同じ書式の他人」の密度は
 * probe が増えるほど相対的に薄まっている)。この日本語 probe set は識別子ベンチの
 * 反省を引き継がず、**その反省を経る前の初期条件そのもの**(12 probe / 60 haystack、
 * 密度5:1)を再現する——「引けないもの」が出るとしたら、この初期条件でこそ最も
 * 出やすいはずである、という賭けを最初から明示するため。
 *
 * ⚠ **`JAPANESE_NAME_TOPIC_KEYWORDS` に登場する24件の固有名詞とは重ならない値域を
 * 選んである**(姓・組織名・製品名・地名のいずれも probe 側と別の語)。その保証は
 * 「選んだ」だけでは終わらない——`buildJapaneseNameProbeSetConversation` が
 * `findJapaneseNameTopicKeywordViolations` で機械的に再検査し、万一重なっていれば
 * 構築時に例外にする。
 */
const DENSE_JAPANESE_NAME_FAMILIES: readonly DenseJapaneseNameFamily[] = [
  {
    id: "person",
    count: DENSE_PERSON_SURNAMES.length * DENSE_PERSON_GIVEN_NAMES.length,
    identifierAt: (n) =>
      `${DENSE_PERSON_SURNAMES[n % DENSE_PERSON_SURNAMES.length]}` +
      `${DENSE_PERSON_GIVEN_NAMES[Math.floor(n / DENSE_PERSON_SURNAMES.length)]}`,
    sentenceFor: (name) => `${name}さんは来月から新しいプロジェクトに参加します。`,
  },
  {
    id: "org",
    count: DENSE_ORG_NAMES.length,
    identifierAt: (n) => DENSE_ORG_NAMES[n]!,
    sentenceFor: (name) => `${name}は来期に業務システムを刷新する予定です。`,
  },
  {
    id: "product",
    count: DENSE_PRODUCT_NAMES.length,
    identifierAt: (n) => DENSE_PRODUCT_NAMES[n]!,
    sentenceFor: (name) => `${name}のマニュアルが今週改訂されました。`,
  },
  {
    id: "place",
    count: DENSE_PLACE_NAMES.length,
    identifierAt: (n) => DENSE_PLACE_NAMES[n]!,
    sentenceFor: (name) => `${name}では来月から窓口対応時間が変わります。`,
  },
];

/** `DENSE_JAPANESE_NAME_FAMILIES` の件数の合計から導く——ここにも 60 を書き写さない。 */
export const DEFAULT_JAPANESE_NAME_DENSE_HAYSTACK_SIZE: number =
  DENSE_JAPANESE_NAME_FAMILIES.reduce((sum, f) => sum + f.count, 0);

/**
 * `index`(0始まり)に対応する、固有名詞が密な haystack 文を1件返す。
 * ファミリーを跨ぐ累積オフセットで、どのファミリーの何番目かを決める(決定的、乱数無し)。
 */
export function buildDenseJapaneseNameHaystackUtterance(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `buildDenseJapaneseNameHaystackUtterance: index は0以上の整数である必要がある` +
        `(実際: ${index})`,
    );
  }
  let remaining = index;
  for (const family of DENSE_JAPANESE_NAME_FAMILIES) {
    if (remaining < family.count) {
      const identifier = family.identifierAt(remaining);
      return family.sentenceFor(identifier);
    }
    remaining -= family.count;
  }
  throw new Error(
    `buildDenseJapaneseNameHaystackUtterance: index ${index} が総件数 ` +
      `${DEFAULT_JAPANESE_NAME_DENSE_HAYSTACK_SIZE} を超えている`,
  );
}

// ---------------------------------------------------------------------------
// 会話の組み立て
// ---------------------------------------------------------------------------

/** `japanese-name-gold-<id>` の externalId 規約。`./identifier-probe-set.js` の
 *  `identifier-gold-<id>` と衝突しないよう別の prefix を使う。 */
export function japaneseNameGoldExternalId(probeId: string): string {
  return `japanese-name-gold-${probeId}`;
}

/** `japanese-name-distractor-<id>` の externalId 規約。 */
export function japaneseNameDistractorExternalId(probeId: string): string {
  return `japanese-name-distractor-${probeId}`;
}

/** `japanese-name-filler-NNNN`(4桁ゼロ埋め)の externalId 規約。 */
export function japaneseNameHaystackExternalId(index: number): string {
  return `japanese-name-filler-${String(index).padStart(4, "0")}`;
}

/**
 * 全 `JAPANESE_NAME_PROBES` の gold/distractor + 共有の haystack を1本の会話に組む。
 *
 * `haystackKind`(既定 `"sparse"`)で haystack の生成器を切り替える:
 * - `"sparse"`: `./probe-set.js` の `buildHaystackUtterance`(固有名詞を1件も含まない、
 *   話題語ベースの既定 haystack)を再利用する。
 * - `"dense"`: 上の `buildDenseJapaneseNameHaystackUtterance`(同じ「姓/組織/製品/地名」
 *   ファミリーの固有名詞が密な haystack、計60件)。
 *
 * どちらの kind でも、固有名詞の重なり検査(`findJapaneseNameTopicKeywordViolations`)は
 * 必ず通す——`dense` は probe の固有名詞と衝突しない値を選んで設計してあるが、
 * 「選んだつもり」で終わらせず実行時にも再検査する。
 */
export function buildJapaneseNameProbeSetConversation(
  haystackSize?: number,
  haystackKind: JapaneseNameHaystackKind = "sparse",
): ProbeUtterance[] {
  const utterances: ProbeUtterance[] = [];
  for (const probe of JAPANESE_NAME_PROBES) {
    utterances.push({
      externalId: japaneseNameGoldExternalId(probe.id),
      text: probe.fact,
      kind: "gold",
      probeId: probe.id,
    });
    utterances.push({
      externalId: japaneseNameDistractorExternalId(probe.id),
      text: probe.distractor,
      kind: "distractor",
      probeId: probe.id,
    });
  }

  const resolvedSize =
    haystackSize ??
    (haystackKind === "dense" ? DEFAULT_JAPANESE_NAME_DENSE_HAYSTACK_SIZE : DEFAULT_HAYSTACK_SIZE);
  const buildUtterance =
    haystackKind === "dense" ? buildDenseJapaneseNameHaystackUtterance : buildHaystackUtterance;

  const haystackTexts: string[] = [];
  for (let i = 0; i < resolvedSize; i += 1) {
    haystackTexts.push(buildUtterance(i));
  }
  const violations = findJapaneseNameTopicKeywordViolations(haystackTexts);
  if (violations.length > 0) {
    throw new Error(
      `buildJapaneseNameProbeSetConversation: haystack(${haystackKind}) が固有名詞 probe の` +
        `固有名詞と重なっている(${violations.length}件): ${JSON.stringify(violations.slice(0, 5))}`,
    );
  }
  haystackTexts.forEach((text, i) => {
    utterances.push({
      externalId: japaneseNameHaystackExternalId(i),
      text,
      kind: "haystack",
    });
  });

  return utterances;
}

/**
 * `runIdentifierProbeArm` へ渡す probe 集合の仕様（`./identifier-arm.js` の `ArmProbeSetSpec`）。
 *
 * ⚠ **型だけを `./identifier-arm.js` から取る**（`import type`）——実行時の循環を作らない。
 * `identifier-arm.ts` はこのファイルを import しない（既定は識別子 probe 集合のまま）。
 */
export const JAPANESE_NAME_PROBE_SET_SPEC: ArmProbeSetSpec = {
  probes: JAPANESE_NAME_PROBES,
  buildConversation: (haystackSize, haystackKind) =>
    buildJapaneseNameProbeSetConversation(haystackSize, haystackKind),
  goldExternalId: japaneseNameGoldExternalId,
  distractorExternalId: japaneseNameDistractorExternalId,
};
