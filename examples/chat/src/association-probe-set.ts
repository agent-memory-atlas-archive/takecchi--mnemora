import type { ProbeUtterance } from "./probe-set.js";
import { DEFAULT_HAYSTACK_SIZE, buildHaystackUtterance } from "./probe-set.js";

/**
 * 連想枠（段3.5、ADR 0151、Issue #200）専用の probe set（Issue #291）。
 *
 * **背景**: `recall()` に連想枠（`RecallQuery.association`）が入ったが、それが想起の質を
 * 動かすかを測る器が無かった。`retrieval`（`./probe-set.js`）の probe は、query が直接
 * `limit` 内で gold に当たることを前提に設計されており、連想枠が無くても gold が返る
 * ——⟹ 連想枠を on/off しても `retrieval` の12行の指標は動かない（伸び代が無い）。
 *
 * **この probe set の三角形**（マネージャー設計。実装は逐語で受ける）:
 *
 *   `query ≈ anchor`（クエリで上位に当たる） /
 *   `anchor ≈ gold`（ブリッジ語を共有） /
 *   `query ≉ gold`（クエリでは `limit=10` の外）
 *
 * つまり、**query だけでは gold に届かない**が、query が引いた anchor の近傍（コサイン
 * 類似度）を辿れば gold に届く、という状況を作る。連想枠が off なら gold は原理的に
 * 返らない（`recall-runtime.ts` の段3.5は `association` を渡したときしか走らない）。
 * 連想枠が on なら、gold は `retrievedVia: "association"` として `allUnits` の後ろに
 * 連結されて返りうる——⟹ **`hit@10` は連想枠の効果を測れない**（gold は本体の11位以降に
 * しか現れない）。この probe set が測る指標は `goldReturned`/`goldRank`/`mrr` など、
 * `limit` を超えて返るかどうかを見るものにする（`./association-arm.ts` 参照）。
 *
 * **12件 = 3カテゴリ（ブリッジ語の字種）× 4件**——ASCII の識別子・日本語の固有名詞・
 * 日本語の普通名詞（カテゴリごとにブリッジ語の性質が違うことで、埋め込み空間の
 * どの領域でも三角形が成立することを確かめる。ADR 0033 §3 と同じ規律で、12件からは
 * 「一般にどの程度」を統計的に主張しない——「この12件で何件成立したか」までである）。
 *
 * 🔴 **マネージャーが CI と同じ埋め込み（`@mnemora/local-embedding`、ruri v3 30m/sym）で
 * 12/12 について実測済み**の4条件（このファイルの担当者は実測していない。確かめていない
 * ことの一覧は PR 本文/報告に明記する）:
 *   ① アンカーがクエリ上位3件以内 ② gold がクエリ順位11位以降
 *   ③ cos(anchor, gold) ≥ 0.5 ④ gold がアンカー近傍の40位以内。
 *
 * ⛔ **`ASSOCIATION_PROBES` の中身（`bridge`/`query`/`anchor`/`gold`/`distractor`）は
 * 逐語である。1文字も変えないこと**——マネージャーが上の4条件を実測した対象そのもの
 * だからである。
 */
export interface AssociationProbe {
  id: string;
  /** ブリッジ語の字種。3カテゴリ×4件。 */
  category: "ascii-id" | "proper-noun" | "common-noun";
  /** anchor と gold の両方に現れ、他のどの発話にも現れない語（機械的に検査する）。 */
  bridge: string;
  /** 終盤に投げる質問。gold とは内容語を共有しない(`limit=10` の外に gold を追いやる)。 */
  query: string;
  /** query で上位に当たる、bridge を含む記憶。連想枠の起点(アンカー)。 */
  anchor: string;
  /** query では引けないが、anchor とは bridge を共有する記憶。連想枠が拾うべき答え。 */
  gold: string;
  /** 同じ話題(query 寄り)だが bridge を含まない記憶。連想枠が無くても引ける対照。 */
  distractor: string;
}

export const ASSOCIATION_PROBES: AssociationProbe[] = [
  // --- ascii-id（ASCII の識別子がブリッジ） ---
  {
    id: "ascii-project",
    category: "ascii-id",
    bridge: "PROJ-1234",
    query: "いま担当している案件の資料を、取引先へ共有してよいか確認したいです。",
    anchor: "いま担当している案件は PROJ-1234 です。",
    gold: "PROJ-1234 には顧客名を伏せる守秘義務が付いています。",
    distractor: "取引先とのやりとりは必ずCCに上長を入れます。",
  },
  {
    id: "ascii-printer",
    category: "ascii-id",
    bridge: "EP-880A",
    query: "自宅のプリンタで年賀状を刷る準備をしています。何が要りますか?",
    anchor: "自宅のプリンタは EP-880A です。",
    gold: "EP-880A に通せるのは厚さ0.3mmまでです。",
    distractor: "年賀状の宛名は毎年おなじ名簿から作っています。",
  },
  {
    id: "ascii-camera",
    category: "ascii-id",
    bridge: "SDXC",
    query: "運動会で使うカメラの準備で、買い足すものはありますか?",
    anchor: "使っているカメラの記録媒体は SDXC です。",
    gold: "SDXC は exFAT なので古い機器では読めないことがあります。",
    distractor: "運動会は来月の第2土曜です。",
  },
  {
    id: "ascii-router",
    category: "ascii-id",
    bridge: "WXR-5950",
    query: "自宅のネットが夜だけ遅くなります。心当たりはありますか?",
    anchor: "自宅のルーターは WXR-5950 です。",
    gold: "WXR-5950 の2.4GHz帯は近隣の無線と干渉しやすいです。",
    distractor: "自宅の回線は光の1ギガ契約です。",
  },
  // --- proper-noun（日本語の固有名詞がブリッジ） ---
  {
    id: "name-meeting",
    category: "proper-noun",
    bridge: "田中さん",
    query: "来週火曜の打ち合わせに向けて、準備しておくことはありますか?",
    anchor: "来週の火曜日、田中さんと新規案件の打ち合わせがあります。",
    gold: "田中さんは甲殻類アレルギーがあります。",
    distractor: "打ち合わせの議事録は共有ドライブに置く決まりです。",
  },
  {
    id: "name-trip",
    category: "proper-noun",
    bridge: "シンガポール",
    query: "今月末の出張の準備で、残っている手続きはありますか?",
    anchor: "今月末にシンガポールへ出張します。",
    gold: "シンガポールは入国時点で残存有効期間が6か月ないと入れません。",
    distractor: "出張の精算は帰着から2週間以内に出します。",
  },
  {
    id: "name-bank",
    category: "proper-noun",
    bridge: "ひまわり銀行",
    query: "来月の家賃の引き落としについて確認しておきたいです。",
    anchor: "家賃はひまわり銀行の口座から引き落としています。",
    gold: "ひまわり銀行は月末が土日だと翌営業日の処理になります。",
    distractor: "家賃は毎月8万円です。",
  },
  {
    id: "name-gift",
    category: "proper-noun",
    bridge: "佐野さん",
    query: "上司の退職祝いに何を贈るか決めたいです。",
    anchor: "退職される上司は佐野さんです。",
    gold: "佐野さんは3年前からお酒を断っています。",
    distractor: "退職祝いは部署の全員でお金を出し合います。",
  },
  // --- common-noun（日本語の普通名詞句がブリッジ） ---
  {
    id: "noun-car",
    category: "common-noun",
    bridge: "父の車",
    query: "週末に実家へ帰ります。何か気をつけることはありますか?",
    anchor: "実家へ帰るときは父の車を借りています。",
    gold: "父の車は高さ制限のある立体駐車場に入りません。",
    distractor: "実家には週末しか誰もいません。",
  },
  {
    id: "noun-medicine",
    category: "common-noun",
    bridge: "カルシウム拮抗薬",
    query: "毎朝の習慣で、見直したほうがよい点はありますか?",
    anchor: "毎朝、カルシウム拮抗薬を飲んでいます。",
    gold: "カルシウム拮抗薬はグレープフルーツで効きが強くなります。",
    distractor: "毎朝6時に起きて犬の散歩へ行きます。",
  },
  {
    id: "noun-laptop",
    category: "common-noun",
    bridge: "会社支給のノートPC",
    query: "出先で仕事をするとき、持ち物で足りないものはありますか?",
    anchor: "仕事では会社支給のノートPCを持ち歩いています。",
    gold: "会社支給のノートPCはUSB-Cで65W以上ないと充電できません。",
    distractor: "出先では社内網へVPNで入る決まりです。",
  },
  {
    id: "noun-apartment",
    category: "common-noun",
    bridge: "木造アパート",
    query: "引っ越してから、近所付き合いで気をつけることはありますか?",
    anchor: "先月、木造アパートの2階へ引っ越しました。",
    gold: "木造アパートは床の遮音等級が低い造りです。",
    distractor: "引っ越しの段ボールがまだ半分残っています。",
  },
];

// ---------------------------------------------------------------------------
// ブリッジ語の漏れを機械的に検査する(歯1) — `identifier-probe-set.ts` の
// `findIdentifierTopicKeywordViolations` の作法を踏む。
// ---------------------------------------------------------------------------

export interface AssociationBridgeViolation {
  index: number;
  text: string;
  bridge: string;
  /** ブリッジ語が漏れた元の probe(このブリッジ語の持ち主)。 */
  probeId: string;
}

/**
 * 各 probe の `bridge` が、**その probe の anchor と gold の2件にだけ**現れ、
 * 他のどの発話(他 probe の anchor/gold/distractor・haystack すべて)にも現れないことを
 * 検査する。
 *
 * **なぜこの検査が要るか**: この probe set の三角形(`query ≈ anchor` /
 * `anchor ≈ gold` / `query ≉ gold`)は、bridge が anchor と gold の**外へ漏れていない**
 * ことに依存している。bridge が別の発話(たとえば同じ probe の distractor や、
 * 他の probe の anchor)に漏れれば、「anchor 経由でしか gold に届かない」という
 * 前提が崩れ、連想枠を on にしなくても gold が別経路(語彙一致・別のアンカー)で
 * 引けてしまいうる——それは「連想枠が効いた」のではなく「設計が漏れていた」である。
 *
 * `utterances` は `ProbeUtterance`(`kind`/`probeId` を持つ)を受け取る——文字列の配列
 * ではなく、**どの発話がどの probe の anchor/gold かを構造的に判定する**ため
 * (`identifier-probe-set.ts` の検査は probe を跨いだ「自分自身」の除外が要らないため
 * 文字列配列で足りたが、この検査は「自分自身の anchor/gold」を除外する必要があり、
 * 文字列だけでは判定できない)。
 */
export function findAssociationBridgeViolations(
  utterances: readonly ProbeUtterance[],
): AssociationBridgeViolation[] {
  const violations: AssociationBridgeViolation[] = [];
  for (const probe of ASSOCIATION_PROBES) {
    utterances.forEach((utterance, index) => {
      const isOwnAnchorOrGold =
        utterance.probeId === probe.id &&
        (utterance.kind === "anchor" || utterance.kind === "gold");
      if (isOwnAnchorOrGold) {
        return;
      }
      if (utterance.text.includes(probe.bridge)) {
        violations.push({ index, text: utterance.text, bridge: probe.bridge, probeId: probe.id });
      }
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// query の語彙漏れを機械的に検査する(歯2) — 「gold はクエリの語彙では引けない」
// という設計を機械が守る。
// ---------------------------------------------------------------------------

/**
 * probe ごとに人手で拾った、query の内容語(3〜5語)。`identifier-probe-set.ts` の
 * `IDENTIFIER_TOPIC_KEYWORDS` と同じ理由で、`ASSOCIATION_PROBES` から自動導出しない
 * (文全体の部分文字列一致にすると、助詞・助動詞まで「内容語」に混じり、検査として
 * 機能しなくなるため)。「ます」「です」等の機能語は含めない。
 *
 * `ASSOCIATION_PROBES` に probe を足したら、ここにも対応する内容語を足すこと。
 */
export const ASSOCIATION_QUERY_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "ascii-project": ["担当", "案件", "資料", "取引先", "共有"],
  "ascii-printer": ["自宅", "プリンタ", "年賀状", "準備"],
  "ascii-camera": ["運動会", "カメラ", "準備", "買い足す"],
  "ascii-router": ["自宅", "ネット", "夜", "遅く"],
  "name-meeting": ["来週", "火曜", "打ち合わせ", "準備"],
  "name-trip": ["今月末", "出張", "準備", "手続き"],
  "name-bank": ["来月", "家賃", "引き落とし", "確認"],
  "name-gift": ["上司", "退職祝い", "贈る"],
  "noun-car": ["週末", "実家", "気をつける"],
  "noun-medicine": ["毎朝", "習慣", "見直し"],
  "noun-laptop": ["出先", "仕事", "持ち物", "足りない"],
  "noun-apartment": ["引っ越し", "近所付き合い", "気をつける"],
};

export interface AssociationQueryLeakViolation {
  probeId: string;
  keyword: string;
  gold: string;
}

/**
 * `ASSOCIATION_QUERY_KEYWORDS` のどの語も、**その probe の gold に現れない**ことを
 * 検査する(全 probe に対する静的検査。`ASSOCIATION_PROBES`/`ASSOCIATION_QUERY_KEYWORDS`
 * 自身から導くため、会話の組み立て結果に依らない——引数を取らない)。
 *
 * 「gold はクエリの語彙では引けない」という、この probe set 存在理由そのものを
 * 機械が守る。ここが破れると、たとえ連想枠が off でも(=`recall()` が query の
 * 語彙一致だけで)gold を返してしまいうる——それは連想枠の効果ではない。
 */
export function findAssociationQueryLeakViolations(): AssociationQueryLeakViolation[] {
  const violations: AssociationQueryLeakViolation[] = [];
  for (const probe of ASSOCIATION_PROBES) {
    const keywords = ASSOCIATION_QUERY_KEYWORDS[probe.id] ?? [];
    for (const keyword of keywords) {
      if (probe.gold.includes(keyword)) {
        violations.push({ probeId: probe.id, keyword, gold: probe.gold });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// 会話の組み立て
// ---------------------------------------------------------------------------

/** `assoc-gold-<id>` の externalId 規約。 */
export function associationGoldExternalId(probeId: string): string {
  return `assoc-gold-${probeId}`;
}

/** `assoc-anchor-<id>` の externalId 規約。 */
export function associationAnchorExternalId(probeId: string): string {
  return `assoc-anchor-${probeId}`;
}

/** `assoc-distractor-<id>` の externalId 規約。 */
export function associationDistractorExternalId(probeId: string): string {
  return `assoc-distractor-${probeId}`;
}

/** `assoc-filler-NNNN`(4桁ゼロ埋め)の externalId 規約。 */
export function associationHaystackExternalId(index: number): string {
  return `assoc-filler-${String(index).padStart(4, "0")}`;
}

/**
 * 全 association probe の anchor/gold/distractor + 共有の haystack を1本の会話に組む。
 *
 * **haystack は `./probe-set.js` の `buildHaystackUtterance` を再利用する**(新しい
 * 生成器を書かない、マネージャー指示)——`identifier-probe-set.ts` の `sparse` 条件と
 * 同じ生成器であり、この probe set のブリッジ語(ASCII 識別子・固有名詞・普通名詞句)を
 * 1件も含まないことは `findAssociationBridgeViolations` が実行時に再検査する。
 *
 * 各 probe につき anchor → gold → distractor の順に積む(この順序は三角形の成立に
 * 必須ではない——`recall()` はテキストの並び順ではなく埋め込みで引く——が、
 * 「まずアンカーが在り、その近傍に gold が在る」という設計意図を会話の見た目にも
 * 揃えるための選択)。
 *
 * ⭐ **歯を2本、ここで実行時に噛ませる**(`findAssociationBridgeViolations`/
 * `findAssociationQueryLeakViolations`)。違反があれば例外にする——
 * `identifier-probe-set.ts`/`probe-set.ts` の先例と同じ規律。
 */
export function buildAssociationProbeSetConversation(
  haystackSize: number = DEFAULT_HAYSTACK_SIZE,
): ProbeUtterance[] {
  const utterances: ProbeUtterance[] = [];
  for (const probe of ASSOCIATION_PROBES) {
    utterances.push({
      externalId: associationAnchorExternalId(probe.id),
      text: probe.anchor,
      kind: "anchor",
      probeId: probe.id,
    });
    utterances.push({
      externalId: associationGoldExternalId(probe.id),
      text: probe.gold,
      kind: "gold",
      probeId: probe.id,
    });
    utterances.push({
      externalId: associationDistractorExternalId(probe.id),
      text: probe.distractor,
      kind: "distractor",
      probeId: probe.id,
    });
  }

  const haystackUtterances: ProbeUtterance[] = [];
  for (let i = 0; i < haystackSize; i += 1) {
    haystackUtterances.push({
      externalId: associationHaystackExternalId(i),
      text: buildHaystackUtterance(i),
      kind: "haystack",
    });
  }

  const bridgeViolations = findAssociationBridgeViolations([...utterances, ...haystackUtterances]);
  if (bridgeViolations.length > 0) {
    throw new Error(
      "buildAssociationProbeSetConversation: bridge が anchor/gold の外へ漏れている" +
        `(${bridgeViolations.length}件): ${JSON.stringify(bridgeViolations.slice(0, 5))}`,
    );
  }

  const queryLeakViolations = findAssociationQueryLeakViolations();
  if (queryLeakViolations.length > 0) {
    throw new Error(
      "buildAssociationProbeSetConversation: query の内容語が gold に漏れている" +
        `(${queryLeakViolations.length}件): ${JSON.stringify(queryLeakViolations.slice(0, 5))}`,
    );
  }

  utterances.push(...haystackUtterances);
  return utterances;
}
