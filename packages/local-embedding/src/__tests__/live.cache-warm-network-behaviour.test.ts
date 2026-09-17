import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_EMBEDDING_DTYPE,
  DEFAULT_LOCAL_EMBEDDING_REPO,
} from "../local-embedding-provider.js";
import { createLocalEmbeddingPipeline } from "../pipeline.js";
import type { LocalEmbeddingModelSpec } from "../pipeline.js";

const execFileAsync = promisify(execFile);

/**
 * Issue #164 の「実ふるまいの歯」。
 *
 * **既存の歯（`scripts/__tests__/ci-yml-local-embedding-cache-wiring.test.mjs` /
 * `scripts/__tests__/example-chat-local-embedding-cache-dir-wiring.test.mjs`）は、
 * どちらも `ci.yml` と呼び出し側ソースの「文字列」を走査している。**
 * ⟹ `@huggingface/transformers` を版上げして cache まわりの挙動が変わっても、
 * それらの歯は文字列が同じである限り緑のまま黙って通る。
 *
 * ここは違う。**実際に本物のモデルを一度キャッシュへ落とし（cold）、
 * まっさらな別プロセスで同じ `cacheDir` から読み込み（warm）、
 * そのときネットワークへ実際に何回・何に対して出たかを数える。**
 *
 * ⚠ **要る条件**: `MNEMORA_LIVE_LOCAL_EMBEDDING`（既存の opt-in。
 * `live.local-embedding.test.ts` の docstring の通り、課金は発生しない——
 * このパッケージが繋ぐのは Hugging Face の重み配布だけである）。
 * **CI では設定していないので常に skipped。**
 *
 * **置き場所の判断**（ADR に詳細）: 「専用の opt-in ゲート」と
 * 「cache が温まっている CI ジョブの後段」の二択のうち、前者（この既存ゲートへの相乗り）
 * を採った。理由は ADR を見ること——ここでは歯の中身だけを書く。
 *
 * ---
 *
 * ## 🔴 実測結果（2026-09-13、この器から）: 「warm なら0回」は成立しなかった
 *
 * 期待（前々任者の提案）は「cacheDir に重みが在れば `env.fetch` が0回」だった。
 * **実測は0回ではない。** warm な `cacheDir` から読み込んでも、まっさらなプロセスは
 * 毎回ちょうど1回、`tokenizer_config.json` への **Range リクエスト**
 * （`bytes=0-0`。フルダウンロードではなく存在確認）を発生させる。同じ手順を3回
 * 繰り返しても再現し、揺れなかった。
 *
 * **原因（`@huggingface/transformers@4.2.0` の現物を読んで特定・裏取り済み）:**
 * `AutoTokenizer.from_pretrained` はどのトークナイザファイルが存在するかを
 * `src/utils/model_registry/get_tokenizer_files.js` の `get_file_metadata(modelId,
 * 'tokenizer_config.json', {})` で判定する。**この呼び出しは空の `options` を渡しており、
 * 私たちが指定した `cache_dir` を運んでいない。** ⟹ 中の `getCache(options?.cache_dir)`
 * は `options.cache_dir === undefined` を受け取り、`env.cacheDir`
 * （transformers.js 既定の `<パッケージ>/.cache/`。CI がキャッシュしている
 * `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` とは**別の場所**）を見に行く。
 * ⟹ 私たちの `cacheDir` がどれだけ温かくても、この1本のメタデータ確認だけは
 * **その温かさの外側**にあり、`env.allowRemoteModels` が真である限り毎回
 * Hugging Face への Range リクエストで確定させられる。
 *
 * **この歯が固定するのはその「1回」である。** 0回になったら
 * （transformers.js が直したか、私たちが `env.cacheDir` を明示的に合わせたら）、
 * 下のアサーションは失敗する——それは退行ではなく前進なので、
 * その時点で ADR とこの歯を一緒に更新すること。増えたら（cache がさらに効かなく
 * なった）、429 の新しい容疑者として調べること。
 *
 * ⚠ **「効いている」こと自体は否定されていない。** 36MB の `model_quantized.onnx`・
 * `config.json`・`tokenizer.json` は warm なら**一切**再取得されない
 * （このテストの否定側アサーションが、それを毎回確認する）。
 * ⟹ **429 の機序についての1段深い事実**: cache が完全に効いていても、
 * このモデルを読み込むたびに Hugging Face への軽量な Range リクエストが最低1回残る。
 * ここが 429 を返してくれば、重みの cache が warm でもジョブは落ちうる
 * （軽いリクエストのほうが 429 になりにくいと期待はできるが、保証はしていない）。
 *
 * **何を数えているか**: `env.fetch`（`@huggingface/transformers` の唯一のネットワーク
 * 出口。hub.js の `getFile()` と `get_file_metadata.js` の `fetch_file_head()` は、
 * 外部へ実際に HTTP(S) で出るとき必ずこれを通る）への呼び出し回数と、
 * そのたびの URL・メソッド・Range ヘッダ。**ローカルファイルの読み出し
 * （`node:fs` 経由、cache hit の本体）は数えていない。**
 */
const live = (process.env.MNEMORA_LIVE_LOCAL_EMBEDDING ?? "") !== "";

const MEASURE_SCRIPT = fileURLToPath(
  new URL("./fixtures/measure-fetch-calls-in-fresh-node-process.mjs", import.meta.url),
);

interface MeasuredCall {
  readonly url: string;
  readonly method: string;
  readonly range: string | null;
}

interface MeasureResult {
  readonly fetchCount: number;
  readonly calls: MeasuredCall[];
}

async function measureFetchCallsInFreshProcess(cacheDir: string): Promise<MeasureResult> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [MEASURE_SCRIPT, cacheDir, DEFAULT_LOCAL_EMBEDDING_REPO, DEFAULT_LOCAL_EMBEDDING_DTYPE, "1"],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 60_000 },
  );
  return JSON.parse(stdout) as MeasureResult;
}

describe("live: cacheDir が warm なとき、実際に何回・何にネットワークへ出るか (MNEMORA_LIVE_LOCAL_EMBEDDING が無ければ skipped と表示される)", () => {
  it.skipIf(!live)(
    "cold で温めた cacheDir を、まっさらな別プロセスから読むと、重みは再取得されず、tokenizer_config.json への軽量な Range リクエストが1回だけ残る",
    async () => {
      const cacheDir = await mkdtemp(path.join(tmpdir(), "mnemora-local-embedding-cache-"));
      try {
        // 1. 温める（cold）。この呼び出しは本物のモデル一式を cacheDir へ落とす。
        const spec: LocalEmbeddingModelSpec = {
          repo: DEFAULT_LOCAL_EMBEDDING_REPO,
          dtype: DEFAULT_LOCAL_EMBEDDING_DTYPE,
          cacheDir,
          numThreads: 1,
        };
        const coldPipeline = await createLocalEmbeddingPipeline(spec);
        // 実際に1回埋め込んで、cold の読み込みが本当に動くものであることも確認する。
        const coldVectors = await coldPipeline.embed(["温め用の文"]);
        expect(coldVectors).toHaveLength(1);
        expect(coldVectors[0]).toHaveLength(256);

        // 2. まっさらな別プロセスで、同じ cacheDir から読む（"warm" のつもり）。
        const warm = await measureFetchCallsInFreshProcess(cacheDir);

        // 報告に数字を持ち帰るため、有効桁を落とさずに出力する。
        console.error(
          `[warm cache network behaviour] fetchCount=${warm.fetchCount} calls=${JSON.stringify(warm.calls)}`,
        );

        // ⭐ 否定側: 36MB の重み・config.json・tokenizer.json は warm なら再取得されない。
        const urls = warm.calls.map((call) => call.url);
        expect(urls.some((url) => url.includes("model_quantized.onnx"))).toBe(false);
        expect(urls.some((url) => url.includes("/config.json"))).toBe(false);
        expect(urls.some((url) => url.endsWith("/tokenizer.json"))).toBe(false);

        // 🔴 肯定側・実測どおりの固定: tokenizer_config.json へのメタデータ確認
        // （Range: bytes=0-0）が、warm でもちょうど1回残る。
        expect(warm.fetchCount).toBe(1);
        expect(warm.calls[0]?.url).toContain("tokenizer_config.json");
        expect(warm.calls[0]?.range).toBe("bytes=0-0");
      } finally {
        await rm(cacheDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
