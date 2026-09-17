import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの(消す前に読むこと)**
 *
 * **`@mnemora/local-embedding` が実行時に落とすファイルのサイズを表す2つの異なる
 * 名詞——「重み(`model_quantized.onnx` 本体、36MB)」と「一式(4ファイル計、42MB)」
 * ——に、正しい数字が向いていること**(Issue #455)。
 *
 * 🔑 **なぜ「staleness」ではないか**: Issue #455 が見つけた壊れ方は「数字が古くなった」
 * ではない。**同じ2つの数字(36MB/42MB)が、9ファイル・12箇所に手で複製されるうちに、
 * 一部で向きを取り違えた**(「重み」の話をしているのに42MBを書く/「一式」の話を
 * しているのに36MBを書く。取り違えの方向は一定ではない——#455 の#13は逆方向だった)。
 * ⟹ **「値を1箇所の定数に持たせる」だけではこの壊れ方を防げない**(定数が2つ在っても、
 * 散文を書く人が間違ったほうを選べる)。この歯は「一致」(食い違っていないか)だけでなく
 * **「対応」(どちらの名詞にどちらの数字が付いているか)**を見る。
 *
 * ⛔ **ADR (`docs/decisions/**`) は対象外。** このリポジトリは ADR 本文を書き換えない
 * 規律であり(実際、ADR 0184・ADR 0107 は本文に誤りが残ったまま、ファイル冒頭の
 * 訂正の追記で対応している)、この歯が ADR を対象に含めると「直せない」のに「赤い」
 * PR を量産する。一次資料である ADR 0085 決定7/決定1 の**外**への複製だけを見る。
 *
 * ## 正典値(literal)と、その実在検査
 *
 * ADR 0085 決定7 の実測値(`model_quantized.onnx` 37,142,404 B を含む4ファイル計
 * 42MB)を正規表現で構造的にパースするのは脆い(表現が変わるたびに歯が壊れる)ため、
 * **正典値はこの歯の中に literal で持ち、その literal が ADR 0085 の本文に実在する
 * ことを別の `it` で検査する**形を取った(依頼元が明示的に許容した代替形)。
 *
 * ⚠ **スコープは「決定7の見出しブロックだけ」ではなく「ADR 0085 ファイル全体」にした。**
 * 【現物】確認したところ、`42MB`・`4ファイル`・`37,142,404` は決定7の見出しブロックに
 * 実在するが、**丸めた重みの値`36MB`は決定7ではなく決定1の比較表(選定根拠)にしか
 * 出てこない**。決定7は「42MBを4ファイル」としか書いておらず、そこから`36MB`を
 * 再導出することもできない(37,142,404 Bは1024²で割ると約35.42MB、10⁶で割ると
 * 約37.14MBになり、どちらの単位換算でも機械的に「36」には丸まらない——`36MB`は
 * 決定1で独立に実測された値であり、決定7の厳密バイト値の丸めではない)。
 * ⟹ **`36MB`と`42MB`は、ADR 0085という同じ1ファイルの中の別々の決定に住んでいる。**
 * 「一次資料は単一である」という前提(Issue #455)を保ちつつこれを検査するには、
 * ファイル全体を実在チェックの範囲にする必要があった。
 *
 * ## 対応(この歯の本体)の測り方: 最近傍の名詞で数字の文脈を判定する
 *
 * 非ADRファイル全体から `36MB`/`42MB`(前後が数字でない、単独の出現)を正規表現で
 * 拾い、各出現について前後 {@link CONTEXT_WINDOW} 文字の窓を見て、
 * **「一式」系の名詞と「重み」系の名詞のどちらがより近いか**(文字距離)を比べる。
 * 近いほうをその数字の文脈と判定し、文脈が「一式」なら`42`、「重み」なら`36`を
 * 期待値として突き合わせる。
 *
 * 🔑 **なぜ「窓の中に含むか」ではなく「最近傍」か**: 実際の文は
 * 「4ファイル計42MB(うち重み36MB)」のように、**1つの文の中に両方の名詞が近接して
 * 同居する**。単純な「窓に含むか」判定では、42MBの窓にも36MBの窓にも両方の名詞が
 * 入ってしまい判定できない。**最近傍**なら、「4ファイル計」が42MBに直接隣接し、
 * 「重み」が36MBに直接隣接するという実際の語順を、機械的に正しく拾える。
 *
 * ⚠ **許す名詞の集合は、いまの `main` の実際の記述に当てて決めた**(2026-09-17時点、
 * 非ADRファイル中の全 `36MB`/`42MB` 出現28箇所を実際に洗い、1つも「正しいのに
 * 落ちる」が無いことを確認してから固定した——下記「測ったこと」参照)。
 * `WEIGHT_NOUNS` に素の「モデル」を含めているのは、`36MB のモデルを回す費用`
 * (`pipeline.ts` / `input-token-limit.test.ts`)・`36MB の ONNX モデル`
 * (`embedding-provider-conformance.ts`)のように、推論コストの文脈で「モデル」が
 * 事実上「重み」の同義語として使われているため。「モデル一式」(一式側の名詞)と
 * 前方一致するが、実際の文では「一式」系の名詞(「4ファイル計」等)のほうが数字に
 * 直接隣接しているため、最近傍判定では常に一式側が勝つ(実測して確認済み)。
 *
 * ## 空回り防止の下限
 *
 * ⚠ **総数そのもの(いま28件・12ファイル)はハードコードしない**——足すたびに赤くなる
 * 歯は捨てられる。**下限だけを固定する**(`ci-yml-local-embedding-cache-wiring.test.mjs`
 * の「対を持つジョブが最低2つ」と同じ形)。対象ファイルの探索が壊れて0件になっても、
 * この歯がそれに気づかず緑のまま何も測らない、という空回りを防ぐ。
 *
 * ## 確かめていないこと
 *
 * - 単位表記の揺れ(`42 MB`のような半角スペース入り、`42.0MB`のような小数、全角数字)
 *   のうち、実際に`main`に存在しない形は検査対象にしていない——存在しない形が今後
 *   増えたとき、この歯は「見えない」まま緑を返す(誤検知ではなく検出漏れ)。
 * - `docs/release-v1.md` / `CHANGELOG.md` / `docs/release-notes-v1.0.0.md` は
 *   スキャン対象から除外していない(現状これらに local-embedding のサイズ言及は無い
 *   ため実害は無いが、将来言及が増えたときにこの歯が触れてよいかは未検討——
 *   これらのファイルは別の担い手がリリース窓で編集中であり、この歯が赤くなっても
 *   このPRでは書き換えない)。
 * - `.github/workflows/ci.yml` のサイズ記述は純粋な `#` コメントで挙動に効かないが、
 *   この歯はそれも検査対象に含めている(コメントを剥がしていない)——挙動に影響しない
 *   記述の誤りも、読む人を誤らせる点では本文と同じだと判断したため。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const adrPath = join(repoRoot, "docs/decisions/0085-local-embedding-provider.md");
const adrText = readFileSync(adrPath, "utf8");

/**
 * この歯自身のファイル(repo ルートからの相対パス)。
 *
 * 🔴 **スキャン対象から自分自身を除く。** この docstring は「取り違えの実例」を
 * 説明するために `36MB`/`42MB` を並べて言及しており(例:
 * 「重み(`model_quantized.onnx` 本体、36MB)」と「一式(4ファイル計、42MB)」)、
 * これは実際の記述を検証する対象の「事実の主張」ではなく**事例の解説**である。
 * 【実測】この除外を入れる前、CI 上で実際にこの歯が自分の docstring を誤検知した
 * (「重み」の直前に置いた `model_quantized.onnx` よりも、直後の例示で置いた
 * 「一式」のほうが文字距離で近く、最近傍判定が「一式」文脈だと誤って判定した)。
 */
const selfPath = relative(repoRoot, fileURLToPath(import.meta.url));

/**
 * ADR 0085(決定7/決定1)から読んだ正典値。**新しい JSON/定数ファイルは作らない**
 * ——この歯の中に literal で持ち、下の `it` で ADR 本文への実在を検査する。
 */
const CANONICAL = {
  totalMb: "42MB",
  weightMb: "36MB",
  fileCountPhrase: "4ファイル",
  weightBytes: "37,142,404",
};

/** 「一式」文脈の名詞(このどれかが最近傍なら、期待値は42)。 */
const TOTAL_NOUNS = ["モデル一式", "一式", "4ファイル計", "4ファイル"];

/** 「重み」文脈の名詞(このどれかが最近傍なら、期待値は36)。 */
const WEIGHT_NOUNS = ["重み本体", "重み", "model_quantized.onnx", "ONNXモデル", "モデル"];

/** 前後何文字を「近傍」とみなすか。実測(下記)では最大でも15文字程度で足りている。 */
const CONTEXT_WINDOW = 50;

/** 単独の `36`/`42` + `MB`(前後が数字・英字でないこと)を拾う。 */
const SIZE_RE = /(?<![0-9])(36|42)\s?MB(?![0-9A-Za-z])/g;

/**
 * `ADR (docs/decisions/**) と publish 経路を除いた、git 管理下の全ファイル一覧。
 *
 * ⛔ **`.github/workflows/publish.yml` はここで除外する**——publish の経路には
 * 一切触れない(読むのもやめる)という規律のため、スキャン対象からも外す。
 *
 * @returns {string[]} repo ルートからの相対パス
 */
function listScannableFiles() {
  const raw = execSync("git ls-files", { cwd: repoRoot, encoding: "utf8" });
  return raw
    .split("\n")
    .filter(Boolean)
    .filter((relPath) => !relPath.startsWith("docs/decisions/"))
    .filter((relPath) => relPath !== ".github/workflows/publish.yml")
    .filter((relPath) => relPath !== selfPath);
}

/**
 * `nouns` の中で、`before`(直前の窓)/`after`(直後の窓)のどちらかに最も近い形で
 * 出現するものまでの文字距離を返す(無ければ `Infinity`)。
 *
 * @param {string} before マッチ直前 `CONTEXT_WINDOW` 文字
 * @param {string} after マッチ直後 `CONTEXT_WINDOW` 文字
 * @param {string[]} nouns
 * @returns {number}
 */
function nearestNounDistance(before, after, nouns) {
  let min = Infinity;
  for (const noun of nouns) {
    const idxBefore = before.lastIndexOf(noun);
    if (idxBefore !== -1) {
      const distance = before.length - (idxBefore + noun.length);
      if (distance < min) min = distance;
    }
    const idxAfter = after.indexOf(noun);
    if (idxAfter !== -1 && idxAfter < min) min = idxAfter;
  }
  return min;
}

/**
 * @typedef {{ file: string, line: number, matched: string, context: "total" | "weight" | "none", snippet: string }} SizeMention
 */

/**
 * 対象ファイル群から、すべての `36MB`/`42MB` 出現を、文脈判定つきで集める。
 *
 * @returns {SizeMention[]}
 */
function scanSizeMentions() {
  /** @type {SizeMention[]} */
  const mentions = [];
  for (const relPath of listScannableFiles()) {
    let text;
    try {
      text = readFileSync(join(repoRoot, relPath), "utf8");
    } catch {
      continue; // シンボリックリンク切れ等は無視(このリポジトリでは起きない想定)
    }
    SIZE_RE.lastIndex = 0;
    let match;
    while ((match = SIZE_RE.exec(text)) !== null) {
      const start = match.index;
      const end = match.index + match[0].length;
      const before = text.slice(Math.max(0, start - CONTEXT_WINDOW), start);
      const after = text.slice(end, end + CONTEXT_WINDOW);
      const totalDistance = nearestNounDistance(before, after, TOTAL_NOUNS);
      const weightDistance = nearestNounDistance(before, after, WEIGHT_NOUNS);
      /** @type {"total" | "weight" | "none"} */
      let context = "none";
      if (totalDistance < weightDistance) context = "total";
      else if (weightDistance < totalDistance) context = "weight";
      const line = text.slice(0, start).split("\n").length;
      mentions.push({
        file: relPath,
        line,
        matched: match[1],
        context,
        snippet: `${before}[${match[0]}]${after}`.replace(/\s+/g, " "),
      });
    }
  }
  return mentions;
}

describe("local-embedding のサイズ表記(36MB/42MB)が、名詞と正しく対応している(Issue #455)", () => {
  it("正典値(literal)が ADR 0085 の本文に実在する(決定7: 42MB/4ファイル/バイト厳密値、決定1: 重み36MB)", () => {
    for (const literal of Object.values(CANONICAL)) {
      expect(adrText, `ADR 0085 に literal "${literal}" が見つからない`).toContain(literal);
    }
  });

  it("スキャン対象ファイルが1本以上見つかる(listScannableFiles の土台が崩れていない)", () => {
    expect(listScannableFiles().length).toBeGreaterThan(0);
  });

  const mentions = scanSizeMentions();

  it("⚠ 空回り防止の下限: 判定できた(total/weightのいずれか)出現が最低10件はある(総数はハードコードしない)", () => {
    // ⛔ `toBe` にしない: 出現数は今後の編集で増減しうる(新しい言及が増えても
    // 赤くならないように)。0件・数件では「本当に測れているか」が疑わしいので、
    // 下限だけを `toBeGreaterThanOrEqual` で固定する。
    const resolved = mentions.filter((m) => m.context !== "none");
    expect(resolved.length).toBeGreaterThanOrEqual(10);
  });

  it("⚠ 空回り防止の下限: 出現が見つかったファイルが最低5本はある", () => {
    const filesWithResolvedMention = new Set(
      mentions.filter((m) => m.context !== "none").map((m) => m.file),
    );
    expect(filesWithResolvedMention.size).toBeGreaterThanOrEqual(5);
  });

  it("⭐ 文脈が判定できたすべての出現で、数字が文脈(一式=42/重み=36)と対応している", () => {
    const mismatches = mentions
      .filter((m) => m.context !== "none")
      .filter((m) => (m.context === "total" ? m.matched !== "42" : m.matched !== "36"))
      .map(
        (m) =>
          `${m.file}:${m.line} — "${m.matched}MB" が「${
            m.context === "total" ? "一式" : "重み"
          }」文脈(期待値 ${m.context === "total" ? "42" : "36"}MB)に付いている: ...${m.snippet}...`,
      );
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("すべての出現で、最近傍の名詞から文脈(一式/重み)を判定できる(未判定=noneが無い)", () => {
    const unresolved = mentions
      .filter((m) => m.context === "none")
      .map(
        (m) => `${m.file}:${m.line} — "${m.matched}MB" の文脈を判定できない: ...${m.snippet}...`,
      );
    expect(
      unresolved,
      `${unresolved.join(
        "\n",
      )}\n⟹ 新しい言い回しが TOTAL_NOUNS/WEIGHT_NOUNS のどちらにも一致しない。名詞集合を見直すか、書き方を既存の形に揃えること。`,
    ).toEqual([]);
  });
});
