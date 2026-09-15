# ADR 0157: `tick()` が `consolidate()`/`reflect()` を駆動する — 事象駆動（outbox）、既定 off の opt-in

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

- **文脈**:

  ## この ADR が閉じる Issue

  [Issue #204](https://github.com/takecchi/mnemora/issues/204)（`reflect()`/`consolidate()`
  を `tick()` が駆動しない）を閉じる。前提は2つとも `main` に着地済みである:

  - [ADR 0152](./0152-consolidate-seed-neighborhood.md): `ConsolidateTarget` に
    `{ seedMemoryId, maxCandidates?, minAffinity? }` を足した（PR #296）。
  - [ADR 0154](./0154-reflect-seed-neighborhood.md): `ReflectTarget` に同じ形
    `{ seedMemoryId, maxCandidates?, minAffinity? }` を足した（PR #300、`main` = `6c9d101`）。

  両者とも「起点（`seedMemoryId`）は呼び手が渡す」設計であり、`MemoryStore` に「active な
  記憶を列挙する」処理は一切足していない（`docs/roadmap.md` §5.8「`consolidate()` の起点」は
  未解決のまま残った）。⟹ **この ADR は §5.8 を解かない。** 種を1件渡す口はすでに揃っており、
  この ADR が決めるのは「誰が・いつ・どういう形でその口へ種を流すか」だけである。

  ## 決定1: 事象駆動（outbox）を採る。時間駆動（掃引）は採らない

  **マネージャーの決定。理由をここに書く。**

  - `consolidate`/`reflect` の種は `seedMemoryId` 1件で足りる（ADR 0152/0154）。
    ⟹ もし時間駆動（「テナント全体を定期的に眺めて畳む/内省する」バッチ的な巡回）を選ぶと、
    「どの記憶から始めるか」という優先順位の設計判断——`docs/roadmap.md` §5.8 が明示的に
    未解決のまま残しているもの——を、この ADR が先に解く必要が生まれる。
    **事象駆動（「いま `extract` で生まれた記憶を種にする」）ならその優先順位を発明せずに
    済む**——これは ADR 0152 が §5.8 に用意した逃げ道そのものであり、§5.8 に逐語で
    書いてある（「(a) は #204 の一形態（事象駆動）を選べば迂回できる」）。
  - ⚠ **`sweepArchive`（[ADR 0114](./0114-archive-sweep-for-decayed-memories.md)）が
    時間駆動なのを先例として引かない。** `sweepArchive` が掃引する条件は
    `decay_floor_at < now()`——**時刻そのものが条件**であり、「いま何時か」だけで対象が
    決まる（優先順位も `decay_floor_at` 昇順で機械的に決まる、ADR 0114 決定2）。
    `consolidate`/`reflect` の条件は時刻ではない——「どの記憶が似ているか」
    「何を土台に内省するか」という意味的な近さの問題であり、時刻だけでは対象を決められない。
    **同じ「時間駆動にする」という形を採る根拠が無い。** この区別を採らなかった案1で
    もう一度扱う。

  ## Issue #204 引き継ぎコメントとの関係

  ADR 0154 を着地させた担い手が Issue #204 に残した引き継ぎコメント §5 は、この ADR が
  必ず踏むものとして次の3点を挙げている——(1) ADR 0082 決定5の時限式の歯、
  (2) `TICK_SUPPORTED_JOB_KINDS` が唯一の出所であること、(3) 自動駆動が既定で有効に
  ならないこと。下の決定2〜4がそれぞれに対応する。

- **決定**:

  ## 決定2: `TICK_SUPPORTED_JOB_KINDS` に `"consolidate"`/`"reflect"` を足し、payload は既存の `embed` ジョブと同じ `{ memoryId }` にする

  ```ts
  export const TICK_SUPPORTED_JOB_KINDS = ["extract", "embed", "consolidate", "reflect"] as const;
  ```

  `jobHandlers`（`Record<TickSupportedJobKind, JobHandler>`）に `consolidate`/`reflect` の
  ハンドラを足した——型検査が「一覧に足してハンドラを足し忘れる」を止める仕組み
  （ADR 0082 決定3）はそのまま効く。**実測した**（下の「変異試験」参照）。

  **payload の形は新しく発明しない。** `MemoryStore.createMemoryWithOutbox` は
  `jobKinds` の各要素について**同じ payload** `{ memoryId: memory.id }` で outbox 行を作る
  （`packages/postgres/src/memory-store.ts` の `for (const kind of jobKinds) { … payload:
  { memoryId: memory.id } … }`、`packages/core/src/__tests__/runtime-fakes.ts` の
  `FakeMemoryStore` も同じ）。⟹ `jobKinds` に `"consolidate"`/`"reflect"` を混ぜて渡すだけで、
  それらのジョブも `{ memoryId }` を運ぶ——**既存の `embed` ジョブの payload に揃えた**
  （マネージャー指示の第一候補をそのまま採った。理由は採らなかった案4）。

  ```ts
  function readSeedMemoryIdFromPayload(job: OutboxJobRecord): MemoryId {
    const memoryId = job.payload.memoryId;
    if (typeof memoryId !== "string") {
      throw new Error(`runtime.tick: ${job.kind} job payload missing memoryId`);
    }
    return memoryId;
  }

  async function processConsolidateJob(ctx: Ctx, job: OutboxJobRecord): Promise<void> {
    const seedMemoryId = readSeedMemoryIdFromPayload(job);
    await consolidate(ctx, { target: { seedMemoryId } });
  }

  async function processReflectJob(ctx: Ctx, job: OutboxJobRecord): Promise<void> {
    const seedMemoryId = readSeedMemoryIdFromPayload(job);
    await reflect(ctx, { target: { seedMemoryId } });
  }
  ```

  ### payload が壊れていたとき（`memoryId` が無い/文字列でない）は、`processEmbedJob` と同じ規律で投げる

  黙って何もしない・空処理として `complete()` しない（ADR 0082 の哲学）。投げると
  `tick()` の既存の catch 節がそれを拾い、`outboxStore.fail()` で終端に落として
  `TickResult.failed` に数える——**`unsupported` には数えない**。理由は `unsupported` の
  定義（ADR 0082 決定1）が「`tick` がその kind を処理する分岐を持っていなかった」ことを
  指しているからである。`consolidate`/`reflect` は対応している kind であり、**処理を試みて
  （payload の検証で）失敗した**のだから `failed` の側に属する——`processEmbedJob` が
  `memoryId` 欠落や参照先の Memory 欠落を `unsupported` にせず投げて `failed` にするのと
  同じ扱いである。

  ### `seedMemoryId` が指す Memory が見つからない場合は、投げない

  これは `processEmbedJob` と**意図的に違う**。`embed` には「対象が無かった」を表す正規の
  結末が無く、`processEmbedJob` は「メモリが見つからない」を例外にしている。一方
  `consolidate()`/`reflect()` は「種が見つからない」を `nothingReason` 経由の正規の結末
  として扱う設計を ADR 0152 決定6・ADR 0154 決定5 が既に確立している
  （`ids = [seedMemoryId]` → `getMany` が `not_found` に分類 →
  `nothing_to_consolidate`/`no_eligible_sources` 等）。この ADR がここで新しい判定を
  重ねると、同じ「種が見つからない」に対して2つの矛盾する扱い（例外 vs 正規の結末）が
  生まれる。**⟹ `processConsolidateJob`/`processReflectJob` は種の存在確認をしない**
  ——`consolidate()`/`reflect()` に丸ごと委ね、LLM/store が本当に失敗したときの例外だけが
  伝播して `tick()` に `fail()` させる。

  ### `TickResult.unsupported` の性質は変えていない

  `unsupported` の型・意味・「`failed` の内訳である」という契約（ADR 0082 決定1）は
  1行も変更していない。利用者が独自に足した kind（`CUSTOM_KIND` の歯、
  `packages/core/src/__tests__/runtime.test.ts`）は引き続き `unsupported` に名指しで出る
  ——この4本の歯は今回の変更で1本も書き換えていない（下の「歯」参照）。

  ## 決定3: ⏳ 時限式の歯を「いまは tick が処理する」ことを測る歯に書き換える

  `packages/core/src/__tests__/runtime.test.ts` の
  `it.each(["consolidate", "reflect"])("⏳時限式の歯: …")`
  （[ADR 0082](./0082-tick-names-unsupported-job-kinds.md) 決定5、Issue #204 引き継ぎ
  コメント §5 が「必ず踏むもの」として名指ししたもの）は、本体が入った今、赤くなった
  ——それが正しい（ADR 0082 決定5 の予告どおり）。

  **単に削除しない。** 代わりに3本へ書き換えた:

  1. `TICK_SUPPORTED_JOB_KINDS` が実際に `"consolidate"`/`"reflect"` を含むこと
     （元の歯の否定形）。
  2. payload が壊れているジョブは `unsupported: []` かつ `failed: 1` になること
     （「対応している kind として扱われたが、処理を試みて失敗した」——決定2 参照）。
  3.（別 describe）payload が正しいジョブは `unsupported: []` かつ `processed: 1` に
     なること——「積むだけでなく実際に処理される」ところまでを、対象 Memory を用意した
     専用のセットアップで測る。

  `CUSTOM_KIND`・prototype 名（`constructor`/`toString`/`__proto__`/`hasOwnProperty`）を
  使う既存4本の歯は1行も変更していない——時限式ではない側が今回の変更で壊れていないことを
  実際にテストランで確認した（下の「歯」参照）。

  ## 決定4: 🔴 自動駆動は既定で有効にならない——`RuntimeConfig.autoQueueConsolidateReflectOnExtract`（既定 `false`）

  決定2だけでは「呼び出し側が自分でジョブを積めば tick が処理する」で終わり、mnemora が
  自分から統合・内省することは無い。⟹ `extract`（`observe()` の sync 経路・`tick()` の
  `extract` ジョブ経路の両方が経由する `createMemoriesFromCandidates`、
  `packages/core/src/runtime.ts`）が新しい Memory を1件作るたびに、その `memoryId` を種に
  した `consolidate`/`reflect` の outbox ジョブも追加で積む経路を足した——**ただし
  `RuntimeConfig.autoQueueConsolidateReflectOnExtract`（既定 `false`）を有効にしたときだけ**。

  ```ts
  const jobKinds: OutboxJobKind[] = autoQueueConsolidateReflectOnExtract
    ? ["embed", "consolidate", "reflect"]
    : ["embed"];
  ```

  ### 🔴 これを無効にしたとき、Memory Framework として成立する

  北極星の問い2（「これを無効にしたとき、Memory Framework として成立するか」）への回答:
  **成立する。** `autoQueueConsolidateReflectOnExtract` が既定 `false` のままでも、
  `observe()`/`recall()`/`tick()` は完全に成立し、`tick()` は `embed` ジョブだけを処理し
  続ける——これは今日までの `main` の姿と1バイトも変わらない。`consolidate()`/`reflect()`
  自体はこの設定と無関係に、呼び出し側が明示的に呼べば常に動く（ADR 0089/0091 の verb
  としての契約はこの ADR で1行も変えていない）。**この設定が足すのは「mnemora が
  *自分から*種を積むかどうか」だけであり、動詞そのものの可否ではない。**

  **ADR 0114 却下案5（`sweepArchive` を `tick`/`observe` に自動で相乗りさせる案）が
  同じ緊張をどう解いたかを踏襲した**——あちらは「掃引を呼ばない運用でも
  observe/recall は成立しなければならない」「掃引を止めるための独立した操作が無くなる」
  という理由で、自動相乗りを却下し `sweepArchive` を明示呼び出しのままにした
  （`InlineScheduler` が既定で `extract: 'sync'` も残る、という「無効にしても成立する」
  設計と整合させるため）。この ADR も同じ形——**既定で無効かつ、無効にする独立した手段
  （config を渡さない）を持つ**——を採ったが、`sweepArchive` と違って**この ADR は
  opt-in を用意した**（`sweepArchive` に opt-in は無く、常に呼び出し側が明示呼び出しする
  だけ）。この差は決定そのものの理由になる——Issue #204 の受け入れ条件が「自動で
  積む経路を足すこと」を明示的に要求しており（さもないと「呼び出し側が自分でジョブを
  積む」以上のことが何も無く、北極星の「自分から思い出す」の半分が閉じない）、
  `sweepArchive`（ADR 0114）にはその要求が無かった。⟹ **既定 off という「形」は
  ADR 0114 から踏襲し、opt-in という「機構」はこの ADR 独自に足した。**

  ### opt-in の置き場所

  `RuntimeConfig`（`deps.config`）に置いた。`extractorVersion`/`defaultClaimedBy` 等、
  既存の「動作を変える任意設定」と同じ置き場所であり、`createRuntime` の呼び出し側が
  1箇所で渡せる。

  ## 決定5: 測り方（実装はしない）

  Issue #204 受け入れ条件の最後——「効いたかどうかの測り方を、少なくとも『どう測るか』は
  書く」。`examples/chat` の `consolidation-cost`
  （[ADR 0101](./0101-how-to-measure-whether-consolidate-moved-the-north-star.md)）・
  `archive-sweep-cost`（[ADR 0119](./0119-archive-sweep-cost-bench.md)）が同じ形の問い
  （「この操作は北極星の物差し——会話ログを全部積むのをやめられたか——を実際に動かすか」）
  に対して既に答えを持っている。この ADR が予告する形（**実装はしない**）:

  - **姉妹サブコマンド**（例: `tick-drive-cost`）を足し、`autoQueueConsolidateReflectOnExtract`
    を有効にした状態で会話ログを ingest し、`tick()` を干上がるまで回す
    （[ADR 0021](./0021-drain-embed-ticks-in-ingest.md) と同じ形）。
  - 測る数字は、有効/無効の2 arm を比較する形——(a) `recall()` に積まれるトークン数の比
    （北極星の物差しそのもの）、(b) `consolidate`/`reflect` 経由で `superseded`/`reflected`
    になった Memory の件数、(c) 追加の LLM 呼び出し回数（`consolidation-cost`/
    `archive-sweep-cost` が既にコストを別 arm で切り出しているのと同じ理由——
    `consolidate`/`reflect` は北極星の問い5「LLM を呼ばずに済ませられないか」に対して
    「済ませられない」側の操作であり、コストを隠さない）。
  - **`identifier-probes`/`consolidation-cost`/`archive-sweep-cost` と同じく
    `MNEMORA_EMBEDDING=local`** を固定して使うべきである——`deterministic` は想起の質に
    ついて何も言わない（`docs/north-star.md`/`AGENTS.md` の警告）ため、`consolidate`/
    `reflect` が実際に「似ている」ものを集められているかを測るにはこの層が要る。
  - ⛔ **この ADR は上記を実装していない。実測もしていない。** 次の PR（別 issue）の
    宿題として提起する。

- **検討して採らなかった案**:

  1. **時間駆動（掃引、`sweepArchive` と同じ形）にする。**
     却下（決定1参照）。`sweepArchive` の条件（`decay_floor_at < now()`）は時刻そのもの
     であり、優先順位も `decay_floor_at` 昇順で機械的に決まる。`consolidate`/`reflect` の
     「似ている」「土台にする」は意味的な近さの問題であり、時刻だけでは対象が決まらない
     ——時間駆動を選ぶと、`docs/roadmap.md` §5.8（起点の優先順位）を先に解く必要が生まれる。
     事象駆動はそれを迂回できる（ADR 0152 が用意した逃げ道）。

  2. **`reextract` が作る新しい Memory にも同じ opt-in を適用する。**
     却下。Issue #204 本文・引き継ぎコメントが名指ししているのは `extract`
     （`observe()` → `createMemoriesFromCandidates`）であり、`reextract`
     （[ADR 0028](./0028-reextract-superseded-cleanup.md)）は別の動詞・別の ADR の対象
     である。`reextract` は `createMemoriesFromCandidates` を経由せず独自の書き込み経路
     （`supersedeWithNewMemories`・フォールバックの2段ループ）を持つため、混ぜると
     この PR が「extract が種を積む」と「reextract も種を積む」の2つの主張を同時に
     する形になり読めなくなる（`docs/autonomy.md` §2「ついでに直さない」）。

  3. **`consolidate` 用・`reflect` 用に別々の opt-in フラグを持たせる。**
     却下。ADR 0152/0154 は両者を意図的に対称に扱っている（種の集め方は同一、閾値だけが
     向き違い）。この ADR の時点でどちらか片方だけを自動化したいという要求は無く、
     2つのフラグを持たせると「両方 true」「両方 false」以外の組み合わせ（例:
     consolidate だけ自動化）が生まれ、その意味を今から設計する必要がある。単一の
     フラグにして、非対称な需要が実際に出てから分ける（今から分けない、
     `docs/autonomy.md`「決められるなら決めて理由を残す」の適用——今は決める理由が無い）。

  4. **payload に新しい形（例えば `{ seedMemoryId }` という専用フィールド）を発明する。**
     却下。マネージャー指示の第一候補（既存の `embed` ジョブの payload に揃える）を
     現物で確認したところ、`createMemoryWithOutbox` は `jobKinds` の全要素に同じ
     `{ memoryId }` を使うことがすでに保証されていた（postgres 実装・fake 実装の両方）。
     新しい形を発明すると、`createMemoryWithOutbox`/`createManyMemoriesWithOutbox` の
     契約（「`jobKinds` の各要素は同じ payload を持つ」）を破る特別扱いを一箇所だけに
     作ることになり、正当化する理由が無い。

  5. **`processConsolidateJob`/`processReflectJob` で、`processEmbedJob` と同様に
     「参照先の Memory が存在しない」を明示的にチェックして例外にする。**
     却下（決定2「`seedMemoryId` が指す Memory が見つからない場合は、投げない」参照）。
     `consolidate()`/`reflect()` 自身がこれを正規の結末として扱う設計をすでに持っており
     （ADR 0152/0154）、ここで重ねて例外にすると同じ状況に2つの矛盾する扱いが生まれる。

  6. **時限式の歯（決定3）を単に削除する。**
     却下。ADR 0082 決定5 が「本体を足す側がこの歯を書き換えるところまでがその作業」と
     明記しており、単純削除は「本体が入ったことで何が変わったか」の記録を失う。
     代わりに「いまは tick が処理する」ことを測る歯として書き換えた。

- **引き受ける負債・覆えていない範囲**:

  1. 🔴 **起点の選定（`docs/roadmap.md` §5.8）は依然未解決のまま。**
     事象駆動（`extract` が作った直近の Memory を種にする）だけが実装されている——
     「テナント全体を定期的に眺めて畳む/内省する」バッチ的な巡回統合は無い。
     `reflect` 側の同型の宿題（ADR 0154「引き受ける負債」2）にも変化は無い。

  2. **`autoQueueConsolidateReflectOnExtract` を有効にしても、`consolidate`/`reflect` が
     実際に何かを生成するとは限らない。** テナントに Memory が少ない・`minAffinity` を
     満たす近傍が無い等の理由で `nothing_to_consolidate`/`no_eligible_basis` に終わる
     ジョブが多数になりうる——`tick()` の `processed` カウントは「ジョブの実行に成功した」
     ことを意味するだけで、「何かを統合/内省した」ことを意味しない。この区別は
     `ConsolidationResult.outcome`/`ReflectionResult.outcome` の側にしか出ない。

  3. **opt-in を有効にすると、新しい Memory 1件につき LLM 呼び出しが最大2回
     （consolidate 1回・reflect 1回）増えうる。** ADR 0152/0154 の負債（種の再埋め込みで
     embedding 呼び出しが1回ずつ増える）もそのまま積み重なる——1件の extract につき
     最大で embed 1回 + 再埋め込み2回 + LLM 呼び出し2回が追加でありうる。コストは
     決定5の測り方が実測してから判断する。

  4. **`reextract` が作る新しい Memory は種にならない**（採らなかった案2）。
     再抽出で生まれた記憶は、この opt-in の対象外のまま残る。

  5. **本物の Postgres に対して通していない。** この作業環境に `DATABASE_URL` が無く、
     DB テストは実行していない。変更は `packages/core` のみ（`packages/postgres` は
     無変更）であり、`createMemoryWithOutbox` が `jobKinds` の各要素に同じ payload を
     使うことは既存のコード（変更していない）から読んだものである——CI の DB ジョブが
     実測の場になる。

  6. **測り方（決定5）は実装しておらず、実測もしていない。** 提起にとどまる。

- **これが覆るとしたら**:

  - **`docs/roadmap.md` §5.8（起点の優先順位）が解決され、テナント全体を巡回する
    バッチ的な統合/内省が要ると決まったとき。** そのときは時間駆動（掃引）の形を
    別途検討する必要があるが、この ADR の決定1（時間駆動を採らない理由）は
    「優先順位が未解決だから」であり、優先順位が解決すればその前提が外れる。
  - **決定5の測り方を実装し、LLM 呼び出しコストが実用に耐えないと分かったとき。**
    opt-in の既定・粒度（採らなかった案3の再検討を含む）を見直す必要が生まれる。
  - **`reextract` にも同じ種積みを広げる決定がされたとき**（採らなかった案2）。
  - **[Issue #301](https://github.com/takecchi/mnemora/issues/301)（`sweepArchive` の
    駆動）が決着し、「保守操作を `tick`/`observe` に相乗りさせる」規律全体が
    見直されたとき**、この ADR の決定1・決定4 も再考の対象になりうる。

- **確かめていないこと**:

  - **本物の Postgres でこの変更を通していない**（負債5）。
  - **北極星の物差し（積む量）に対する実際の効果は未測定**（負債6・決定5）。
    `examples/chat` に配線していない。
  - **`autoQueueConsolidateReflectOnExtract` を有効にした運用で、`consolidated`/
    `reflected` な Memory がどれだけ積み上がるか**（ADR 0154「引き受ける負債」6が
    予告した「事象駆動の反復呼び出しで重複した `reflected` Memory が積み上がる」懸念が
    実際に顕在化するかを含む）は測っていない。
  - **LLM 呼び出しコスト・頻度が実運用で妥当かどうか**は検証していない。
  - **`consolidate()`/`reflect()` の LLM 呼び出し自体の質**（実際に良い統合/内省を
    作るか）は、この ADR の範囲でも測っていない——ADR 0089/0091/0152/0154 が既に
    「配線と契約であって統合/内省の質ではない」と明記した限界がそのまま続く。

- **変異試験（歯が実際に噛むことを実測した）**:

  変異を打つ前に `packages/core/src/runtime.ts` を `/tmp/mutation-backup-204b/runtime.ts.orig`
  へ退避し（`docs/autonomy.md` §4「`git checkout` で変異を戻すと未コミットの編集も消える」
  を踏まないため）、各変異のたびに `cp` で退避コピーから復元した。最後に `diff`/`md5sum`
  （`d99bb7eac9f003645e2c6647c7632f94`）で退避コピーと復元後のファイルが byte 単位で
  一致することを確認した。

  | # | 壊した内容 | 結果 |
  |---|---|---|
  | M1 | `jobHandlers` から `consolidate: processConsolidateJob` を消す（`TICK_SUPPORTED_JOB_KINDS` はそのまま） | ❌ `tsc`: `TS2741: Property 'consolidate' is missing … but required in type 'Record<"extract" \| "embed" \| "consolidate" \| "reflect", JobHandler>'`（ADR 0082 決定3 の型結びが、今回足した2 kind にも効くことを実測した） |
  | M2 | `readSeedMemoryIdFromPayload` の型検証（`typeof memoryId !== "string"` で投げる）を削除し、無条件で `memoryId as MemoryId` を返すようにする | ❌ 「payload が壊れている」歯2本（`consolidate`/`reflect` 各1本）が赤に。`seedMemoryId: undefined` を渡された `consolidate()`/`reflect()` が「種が見つからない」正規の結末として静かに処理し、`unsupported: []`/`processed: 1` になってしまうことを実測した——他のテストは全緑（705/707 が緑のまま、2本だけが的確に赤くなった） |
  | M3 | `autoQueueConsolidateReflectOnExtract` の既定値を `false` から `true` に反転する | ❌ 「既定では consolidate/reflect のジョブが1件も積まれない」歯1本だけが赤に（706/707 が緑のまま）——決定4 の「既定 off」を測る歯が、実際にそれだけを的確に測っていることを実測した |

  3つとも、狙った歯だけが赤くなり、無関係な歯（既存707本のうち704〜706本）は緑のままだった
  ——歯が広すぎる/狭すぎる誤検知が無いことを確認している。
