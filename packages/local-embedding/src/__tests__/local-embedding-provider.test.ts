import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import {
  DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
  DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS,
  LOCAL_EMBEDDING_PROVIDER_ID,
  LocalEmbeddingProvider,
  defaultLocalEmbeddingRetryDelayMs,
} from "../local-embedding-provider.js";
import type {
  CreateLocalEmbeddingPipeline,
  LocalEmbeddingModelSpec,
  LocalEmbeddingPipeline,
} from "../pipeline.js";
import { LocalEmbeddingProviderError, isLocalEmbeddingProviderError } from "../errors.js";

/**
 * `LocalEmbeddingProvider` の歯。**本物のモデルは一切落とさない**——
 * `createPipeline` を注入して、このクラスが本当に持っているロジックだけを測る:
 * `space` の確定と凍結 / 遅延ロードを1回に畳むこと / 失敗後に再試行できること /
 * 次元と件数の検査 / prefix の適用 / `warmup()`。
 *
 * **擬似にしているのは「モデルを読み込んで推論する」往復だけである。**
 * 本物のモデルが実際に 256 次元を返すこと・日本語で意味のある近さを出すことは
 * `live.local-embedding.test.ts`（opt-in）が測る。
 */

const ctx: Ctx = { tenantId: "test-tenant" };

/**
 * このファイルの偽 pipeline を `LocalEmbeddingPipeline`（ADR 0090 §3.1 の必須 interface）の
 * 形に組み立てる。**このファイルは上限の検査そのものは測らない**（それは
 * `input-token-limit.test.ts` の役目）ので、`maxInputTokens` / `countTokens` は
 * ダミーの値で埋める——⛔ ここに実モデルの上限値を書かない。
 */
function fakeLocalEmbeddingPipeline(
  embed: (texts: string[]) => Promise<number[][]>,
): LocalEmbeddingPipeline {
  return {
    maxInputTokens: Number.MAX_SAFE_INTEGER,
    countTokens: (texts) => texts.map(() => 0),
    embed,
  };
}

/** 呼ばれた回数と、渡された `spec` / テキストを記録する偽 pipeline。 */
function createRecordingPipeline(
  options: {
    dimensions?: number;
    /** 返すベクトルの件数を入力件数からずらす（件数不一致の歯で使う）。 */
    countDelta?: number;
    /** `createPipeline` の解決を止めておくためのゲート。 */
    gate?: Promise<void>;
  } = {},
) {
  const dimensions = options.dimensions ?? DEFAULT_LOCAL_EMBEDDING_DIMENSIONS;
  const state = {
    createCalls: 0,
    specs: [] as LocalEmbeddingModelSpec[],
    embeddedBatches: [] as string[][],
  };

  const pipeline: LocalEmbeddingPipeline = fakeLocalEmbeddingPipeline(async (texts) => {
    state.embeddedBatches.push([...texts]);
    const count = texts.length + (options.countDelta ?? 0);
    return Array.from({ length: Math.max(count, 0) }, (_, row) =>
      Array.from({ length: dimensions }, (_, column) => (row + column) / 1000),
    );
  });

  const createPipeline: CreateLocalEmbeddingPipeline = async (spec) => {
    state.createCalls += 1;
    state.specs.push(spec);
    if (options.gate) await options.gate;
    return pipeline;
  };

  return {
    createPipeline,
    specs: state.specs,
    embeddedBatches: state.embeddedBatches,
    /** `createPipeline` が呼ばれた回数。**この数がこのファイルで一番大事な数である。** */
    get calls(): number {
      return state.createCalls;
    },
  };
}

describe("space（コンストラクタで同期に確定する）", () => {
  it("new した直後に既定値で確定している（pipeline の読み込みを待たない）", () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    expect(provider.space).toEqual({
      provider: LOCAL_EMBEDDING_PROVIDER_ID,
      model: DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
      dimensions: 256,
    });
    // ⭐ 既定値そのものを書き下しておく。定数を参照するだけだと
    // 「既定値が変わった」ことをこの歯が検知できない。
    expect(provider.space.provider).toBe("local");
    expect(provider.space.model).toBe("ruri-v3-30m/sym");
    expect(provider.space.dimensions).toBe(256);
  });

  it("space を読むためにモデルを読み込まない", () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });
    void provider.space.model;
    expect(recorder.calls).toBe(0);
  });

  it("凍結されている（走っている途中で書き換えられない）", () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    expect(Object.isFrozen(provider.space)).toBe(true);
    // strict mode（ESM）では凍結オブジェクトへの代入は TypeError になる。
    expect(() => {
      (provider.space as { dimensions: number }).dimensions = 999;
    }).toThrow(TypeError);
    expect(provider.space.dimensions).toBe(256);
  });

  it("modelId / dimensions は差し替えられる", () => {
    const recorder = createRecordingPipeline({ dimensions: 8 });
    const provider = new LocalEmbeddingProvider({
      modelId: "ruri-v3-30m/asym",
      dimensions: 8,
      createPipeline: recorder.createPipeline,
    });
    expect(provider.space.model).toBe("ruri-v3-30m/asym");
    expect(provider.space.dimensions).toBe(8);
  });
});

describe("遅延ロード", () => {
  /**
   * ⭐ **この歯がこのファイルの本体である。**
   *
   * Promise を握らない素朴な実装（読み込み済みの pipeline だけを持つ形）では、
   * 同時に来た8本の `embed()` が全員それぞれモデルを読み込み、
   * 557ms / 406MB が 3,138ms / 1,009MB になることを実測している。
   * **`createPipeline` の呼び出し回数を数えることで、その形へ戻ったら赤くなる。**
   *
   * ゲートで読み込みを止めたまま8本を投げる——止めないと、1本目が
   * マイクロタスク1つで解決してしまい、競合の窓が開かないことがある。
   */
  it("並行する embed() 8本でも、モデルの読み込みは1回だけ", async () => {
    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const recorder = createRecordingPipeline({ gate });
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    const inFlight = Array.from({ length: 8 }, (_, index) =>
      provider.embed(ctx, [`テキスト ${index}`]),
    );
    openGate();
    const results = await Promise.all(inFlight);

    expect(recorder.calls).toBe(1);
    expect(results).toHaveLength(8);
    for (const vectors of results) {
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toHaveLength(256);
    }
  });

  it("続けて呼んでも読み込みは増えない", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await provider.embed(ctx, ["1本目"]);
    await provider.embed(ctx, ["2本目"]);
    await provider.embed(ctx, ["3本目"]);

    expect(recorder.calls).toBe(1);
  });

  /**
   * 失敗した Promise を握り続けると、**一度の一時的な失敗が、そのインスタンスを
   * 永久に使えなくする**（ネットワークが落ちていた最初の1回で終わる）。
   *
   * ⚠ **`retry: { attempts: 1 }` でこの回の中のリトライ（Issue #261 / ADR 0141）を
   * 無効化している。**ここで確かめたいのは「1回の `#load()` が使い切って失敗したあと、
   * 次の `embed()` 呼び出しが新しい `#load()` をやり直せるか」であって、
   * 1回の `#load()` の中で何度試すかではない——後者は下の
   * describe("読み込みの再試行 (Issue #261 / ADR 0141)") が見る。
   */
  it("読み込みに失敗しても、次の呼び出しで再試行できる", async () => {
    let attempts = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ネットワークが落ちていた");
      return fakeLocalEmbeddingPipeline(async (texts) =>
        texts.map(() => Array.from({ length: 256 }, () => 0.1)),
      );
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, retry: { attempts: 1 } });

    // ⚠ 失敗は包まれる（下の describe を見ること）ので、cause 側で確かめる。
    await expect(provider.embed(ctx, ["1回目"])).rejects.toThrow(/モデルを読み込めなかった/);
    const vectors = await provider.embed(ctx, ["2回目"]);

    expect(attempts).toBe(2);
    expect(vectors).toHaveLength(1);
  });

  it("createPipeline が同期に throw しても、reject として返る（例外が素通りしない）", async () => {
    const createPipeline = (() => {
      throw new Error("同期に落ちた");
    }) as unknown as CreateLocalEmbeddingPipeline;
    const provider = new LocalEmbeddingProvider({ createPipeline, retry: { attempts: 1 } });

    const error = await provider.embed(ctx, ["テキスト"]).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect((error as Error | undefined)?.cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe("同期に落ちた");
  });

  // ⚠ `retry: { attempts: 1 }`——ここで確かめたいのは #ready の並行時の畳み方であって、
  // 1回の #load() の中のリトライではない。
  it("同時に来た8本が全部失敗しても、読み込みは1回だけで、その後再試行できる", async () => {
    let attempts = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async (_spec) => {
      attempts += 1;
      await Promise.resolve();
      if (attempts === 1) throw new Error("落ちた");
      return fakeLocalEmbeddingPipeline(async (texts) =>
        texts.map(() => Array.from({ length: 256 }, () => 0.1)),
      );
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, retry: { attempts: 1 } });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => provider.embed(ctx, ["テキスト"])),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(attempts).toBe(1);

    await expect(provider.embed(ctx, ["テキスト"])).resolves.toHaveLength(1);
    expect(attempts).toBe(2);
  });
});

describe("読み込みの再試行 (Issue #261 / ADR 0141)", () => {
  /**
   * **Issue #261 の直接の再現**: `actions/cache` が hit しても
   * （またはそもそもキャッシュに関係なく）、モデルの読み込みが
   * 「種類の分かっていない失敗」（典型はネットワーク）で1回だけ落ちることがある。
   * ⟹ **1回の `#load()` の中で、呼び出し側に見せずに吸収できるはずである。**
   *
   * `sleep` を注入して実時間を消費しないようにしている——待つこと自体は
   * `defaultLocalEmbeddingRetryDelayMs` の歯（下）が別に見る。
   */
  it("種類の分かっていない失敗は、既定の設定でも同じ embed() 呼び出しの中で吸収される", async () => {
    let calls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      calls += 1;
      if (calls < 2) throw new Error("cause: fetch failed");
      return fakeLocalEmbeddingPipeline(async (texts) =>
        texts.map(() => Array.from({ length: 256 }, () => 0.1)),
      );
    };
    // ⭐ retry オプション自体は既定値（DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS）のまま——
    // 「CI が何も指定しなくても直る」ことを確かめるのが、この歯の主眼である。
    const provider = new LocalEmbeddingProvider({ createPipeline, sleep: async () => {} });

    const vectors = await provider.embed(ctx, ["1回だけ失敗しても通る"]);

    expect(vectors).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("既定の試行回数（3回）を使い切ると、それ以上は増やさずに失敗として返す", async () => {
    let calls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      calls += 1;
      throw new Error("cause: fetch failed（毎回）");
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, sleep: async () => {} });

    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/モデルを読み込めなかった/);
    expect(calls).toBe(DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS);
  });

  it("試行回数は options.retry.attempts で変えられる", async () => {
    let calls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      calls += 1;
      throw new Error("落ちる");
    };
    const provider = new LocalEmbeddingProvider({
      createPipeline,
      sleep: async () => {},
      retry: { attempts: 5 },
    });

    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/モデルを読み込めなかった/);
    expect(calls).toBe(5);
  });

  it("失敗のたびに、指定した delayMs(attempt) の分だけ sleep する", async () => {
    const waited: number[] = [];
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      throw new Error("落ちる");
    };
    const provider = new LocalEmbeddingProvider({
      createPipeline,
      retry: { attempts: 3, delayMs: (attempt) => attempt * 100 },
      sleep: async (ms) => {
        waited.push(ms);
      },
    });

    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/モデルを読み込めなかった/);
    // 3回試行 ⟹ 待つのは attempt 1 と 2 の後だけ（最後の失敗の後には待たない）。
    expect(waited).toEqual([100, 200]);
  });

  it("最後まで失敗したときの cause は、最後の試行のエラーである", async () => {
    let calls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      calls += 1;
      throw new Error(`失敗 ${calls} 回目`);
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, sleep: async () => {} });

    const error = await provider.embed(ctx, ["テキスト"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe(
      `失敗 ${DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS} 回目`,
    );
  });

  it("メッセージに試行回数が入る（1回試すだけの設定では入らない）", async () => {
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      throw new Error("落ちる");
    };

    const retried = await new LocalEmbeddingProvider({
      createPipeline,
      sleep: async () => {},
      retry: { attempts: 3 },
    })
      .embed(ctx, ["テキスト"])
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    expect((retried as Error).message).toContain("3 回試したが取得できなかった");

    const single = await new LocalEmbeddingProvider({
      createPipeline,
      retry: { attempts: 1 },
    })
      .embed(ctx, ["テキスト"])
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    expect((single as Error).message).not.toContain("回試したが取得できなかった");
  });

  /**
   * 🔴 **`kind` の付いた失敗（ADR 0090）はリトライしない。**
   * 入力・設定の問題であり、同じ入力で再試行しても結果は変わらない
   * ——リトライは無駄な待ち時間を足すだけである。
   */
  it("kind の付いたエラー（unknown_input_limit 等）はリトライせず、1回で即座に投げ直す", async () => {
    let calls = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      calls += 1;
      throw new LocalEmbeddingProviderError("unknown_input_limit", "モデルが上限を宣言していない");
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, sleep: async () => {} });

    const error = await provider.embed(ctx, ["テキスト"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(calls).toBe(1);
    expect(isLocalEmbeddingProviderError(error)).toBe(true);
    expect((error as LocalEmbeddingProviderError).kind).toBe("unknown_input_limit");
    // ⚠ 包まれていない——「モデルを読み込めなかった」の文面は付かない。
    expect((error as Error).message).not.toMatch(/モデルを読み込めなかった/);
  });
});

describe("defaultLocalEmbeddingRetryDelayMs（既定のバックオフ）", () => {
  it("attempt が増えるほど、上限が指数的に伸びる（full jitter なので毎回 [0, 上限) を確かめる）", () => {
    for (let trial = 0; trial < 50; trial += 1) {
      expect(defaultLocalEmbeddingRetryDelayMs(1)).toBeGreaterThanOrEqual(0);
      expect(defaultLocalEmbeddingRetryDelayMs(1)).toBeLessThan(200);
      expect(defaultLocalEmbeddingRetryDelayMs(2)).toBeLessThan(400);
      expect(defaultLocalEmbeddingRetryDelayMs(3)).toBeLessThan(800);
    }
  });

  it("上限は 4000ms で頭打ちになる（試行回数が増えても待たせすぎない）", () => {
    for (let trial = 0; trial < 20; trial += 1) {
      expect(defaultLocalEmbeddingRetryDelayMs(10)).toBeLessThan(4_000);
      expect(defaultLocalEmbeddingRetryDelayMs(20)).toBeLessThan(4_000);
    }
  });
});

describe("読み込み失敗のメッセージ", () => {
  /**
   * 既定の repo は**個人の変換 repo** であり、消えうる。それを承知で選べているのは
   * **元モデルが公式（`cl-nagoya/ruri-v3-30m`, apache-2.0）で、変換をやり直せる**からである。
   * ⟹ **その情報が、repo が消えて落ちた人に届かなければ、選択の前提が成立しない。**
   * 届く先は doc ではなく、その人が最初に見るもの——**例外のメッセージ**である。
   *
   * ⚠ **文面を全文一致で固定しない。**そうすると文言のほうを直せなくなる。
   * 見るのは「必要なものが入っているか」だけ。
   */
  const failing: CreateLocalEmbeddingPipeline = async () => {
    throw new Error("HTTP 404: model not found");
  };

  async function loadFailure(
    options: ConstructorParameters<typeof LocalEmbeddingProvider>[0],
  ): Promise<Error> {
    const provider = new LocalEmbeddingProvider(options);
    const reason = await provider.embed(ctx, ["テキスト"]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(reason, "読み込みが失敗したのに reject しなかった").toBeInstanceOf(Error);
    return reason as Error;
  }

  it("実際に使った repo 名が入る（既定値ではなく）", async () => {
    const error = await loadFailure({ repo: "someone/my-own-conversion", createPipeline: failing });
    expect(error.message).toContain("someone/my-own-conversion");
    expect(error.message).not.toContain("sirasagi62/ruri-v3-30m-ONNX");
  });

  it("既定で使ったときは既定の repo 名が入る", async () => {
    const error = await loadFailure({ createPipeline: failing });
    expect(error.message).toContain("sirasagi62/ruri-v3-30m-ONNX");
  });

  it("実際に使った dtype と cacheDir が入る", async () => {
    const error = await loadFailure({
      dtype: "fp32",
      cacheDir: "/tmp/mnemora-models",
      createPipeline: failing,
    });
    expect(error.message).toContain("fp32");
    expect(error.message).toContain("/tmp/mnemora-models");
  });

  it("元の例外を cause に保持している（404 とネットワーク断と dtype 誤りを潰さない）", async () => {
    const original = new Error("HTTP 404: model not found");
    const error = await loadFailure({
      createPipeline: async () => {
        throw original;
      },
    });
    expect(error.cause).toBe(original);
  });

  it("やり直せること（元モデル・変換・repo オプション）が書いてある", async () => {
    const error = await loadFailure({ createPipeline: failing });
    // 元モデルの識別子が無いと、読んだ人は何を変換すればよいか分からない。
    expect(error.message).toContain("cl-nagoya/ruri-v3-30m");
    // 変換したものをどこへ差すか。
    expect(error.message).toContain("repo");
    // 詳しい手順の在り処。
    expect(error.message).toContain("README");
  });

  // ⚠ `retry: { attempts: 1 }`——ここで確かめたいのは「包むことと握り続けることは別」
  // （#ready を早期に手放すこと）であって、1回の #load() の中のリトライではない。
  it("包んでも、次の呼び出しで再試行できる（包むことと握り続けることは別）", async () => {
    let attempts = 0;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("HTTP 404: model not found");
      return fakeLocalEmbeddingPipeline(async (texts) =>
        texts.map(() => Array.from({ length: 256 }, () => 0.1)),
      );
    };
    const provider = new LocalEmbeddingProvider({ createPipeline, retry: { attempts: 1 } });

    await expect(provider.embed(ctx, ["1回目"])).rejects.toThrow(/モデルを読み込めなかった/);
    await expect(provider.embed(ctx, ["2回目"])).resolves.toHaveLength(1);
    expect(attempts).toBe(2);
  });
});

describe("warmup()", () => {
  it("読み込みを起こし、その後の embed() は読み込み直さない", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    expect(recorder.calls).toBe(0);
    await provider.warmup();
    expect(recorder.calls).toBe(1);

    await provider.embed(ctx, ["ウォームアップ後の1本目"]);
    expect(recorder.calls).toBe(1);
  });

  it("推論は走らせない（モデルへ勝手な入力を流さない）", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await provider.warmup();
    expect(recorder.embeddedBatches).toEqual([]);
  });

  it("2回呼んでも読み込みは1回", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await Promise.all([provider.warmup(), provider.warmup()]);
    await provider.warmup();

    expect(recorder.calls).toBe(1);
  });
});

describe("embed(ctx, [])", () => {
  it("[] を返し、モデルを一度も読み込まない", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await expect(provider.embed(ctx, [])).resolves.toEqual([]);
    // ⚠ **だから空配列ではウォームアップできない。**`warmup()` が要る理由がこれである。
    expect(recorder.calls).toBe(0);
  });
});

describe("次元の検査", () => {
  /**
   * `interfaces/embedding-provider.ts` の「次元をモデルに応じて動的に変える実装は
   * 許容しない」を**実行時に守らせる歯**。宣言と中身が食い違ったまま DB へ入ると、
   * `EmbeddingSpaceId` はテーブル名スラグの導出元なので、後から分けられない。
   */
  it("宣言した次元と実物が食い違うと、初回 embed() で例外になる", async () => {
    const recorder = createRecordingPipeline({ dimensions: 384 });
    const provider = new LocalEmbeddingProvider({
      dimensions: 256,
      createPipeline: recorder.createPipeline,
    });

    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/LocalEmbeddingProvider/);
  });

  it("例外のメッセージに、宣言値と実測値の両方が入る", async () => {
    const recorder = createRecordingPipeline({ dimensions: 384 });
    const provider = new LocalEmbeddingProvider({
      dimensions: 256,
      createPipeline: recorder.createPipeline,
    });

    // 片方だけ書いてあると、読んだ人は「何と食い違ったのか」を調べ直すことになる。
    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/256/);
    await expect(provider.embed(ctx, ["テキスト"])).rejects.toThrow(/384/);
  });

  it("次元が合っていれば通る", async () => {
    const recorder = createRecordingPipeline({ dimensions: 256 });
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    const vectors = await provider.embed(ctx, ["あ", "い"]);
    expect(vectors.map((v) => v.length)).toEqual([256, 256]);
  });
});

describe("件数の検査", () => {
  it("返ったベクトルの件数が入力件数と違えば例外になる", async () => {
    const recorder = createRecordingPipeline({ countDelta: -1 });
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    // 黙って返すと、呼び出し側で memory とベクトルが1つずれて対応する。
    await expect(provider.embed(ctx, ["あ", "い", "う"])).rejects.toThrow(/3 件.*2 件/s);
  });

  it("多すぎても例外になる", async () => {
    const recorder = createRecordingPipeline({ countDelta: 1 });
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await expect(provider.embed(ctx, ["あ"])).rejects.toThrow(/1 件.*2 件/s);
  });
});

describe("prefix", () => {
  it("既定（空文字）では、テキストに何も足さない", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await provider.embed(ctx, ["紅茶が好き", "コーヒーが好き"]);

    expect(recorder.embeddedBatches).toEqual([["紅茶が好き", "コーヒーが好き"]]);
  });

  it("明示すると、全件に同じものが付く（クエリと文書を区別しない）", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      prefix: "検索文書: ",
      createPipeline: recorder.createPipeline,
    });

    await provider.embed(ctx, ["紅茶が好き", "コーヒーが好き"]);

    // ⭐ 「全件に同じもの」が仕様である。embed() は渡されたテキストがクエリなのか
    // 文書なのかを知らないので、区別できるふりをしない（options.prefix の説明）。
    expect(recorder.embeddedBatches).toEqual([
      ["検索文書: 紅茶が好き", "検索文書: コーヒーが好き"],
    ]);
  });

  /**
   * 🔴 **呼び出し側が渡した配列を、下流へ素通ししない。**
   *
   * この歯が在るのは、実際に踏んだからである——`prefix` が空のときだけ
   * `texts` をそのまま `createPipeline` の先へ渡していた。書き換える pipeline を
   * 注入すると、**既定の設定でだけ呼び出し側の配列が壊れ、`prefix` を設定すると
   * 壊れなかった。振る舞いが設定に依存し、しかも壊れるほうが既定だった。**
   *
   * ⚠ **2つの設定の両方で測る。**片方だけだと、また分岐が生えたときに気づけない
   * （前回まさにその分岐が原因だった）。
   */
  it.each([
    ["既定（prefix が空）", undefined],
    ["prefix を設定したとき", "検索文書: "],
  ])("%s、下流が書き換えても呼び出し側の配列は壊れない", async (_label, prefix) => {
    const createPipeline = async (): Promise<LocalEmbeddingPipeline> =>
      fakeLocalEmbeddingPipeline(async (texts) => {
        texts[0] = "下流が書き換えた";
        return texts.map(() => [0, 0]);
      });
    const provider = new LocalEmbeddingProvider({ dimensions: 2, prefix, createPipeline });

    const mine = ["紅茶が好き", "コーヒーが好き"];
    await provider.embed(ctx, mine);

    expect(mine).toEqual(["紅茶が好き", "コーヒーが好き"]);
  });

  it("prefix を付けても、返るベクトルの件数は入力どおり", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      prefix: "検索文書: ",
      createPipeline: recorder.createPipeline,
    });

    await expect(provider.embed(ctx, ["あ", "い", "う"])).resolves.toHaveLength(3);
  });
});

describe("モデル指定が createPipeline へ届く（配線）", () => {
  it("既定値がそのまま渡る", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });

    await provider.warmup();

    expect(recorder.specs[0]).toEqual({
      repo: "sirasagi62/ruri-v3-30m-ONNX",
      dtype: "q8",
      cacheDir: undefined,
      numThreads: 4,
    });
  });

  it("差し替えた値がそのまま渡る", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      repo: "someone/other-onnx",
      dtype: "fp32",
      cacheDir: "/tmp/mnemora-models",
      numThreads: 1,
      createPipeline: recorder.createPipeline,
    });

    await provider.warmup();

    expect(recorder.specs[0]).toEqual({
      repo: "someone/other-onnx",
      dtype: "fp32",
      cacheDir: "/tmp/mnemora-models",
      numThreads: 1,
    });
  });
});
