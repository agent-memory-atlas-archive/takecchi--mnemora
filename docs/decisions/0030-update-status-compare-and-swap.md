# ADR 0030: `MemoryStore.updateStatus` を compare-and-swap にし、`reextract` の安全弁の TOCTOU を塞ぐ

- **状態**: 採用 (2026-09)

> **⚠ 2026-09-17 追記（名乗りの復元。本文は書き換えていない）。**
> 本文の「**UPDATE は待たされることはあっても「取れない」という状態を持たない——他のトランザクションの
> ロック解放を待って、そのまま条件を再評価するだけ**」は、**この repo に裏づける実測が無い。**
> **【受・未検証】** PostgreSQL の行ロック挙動についての一般的な説明であり、`EXPLAIN` や
> 実際に競合させたトランザクションでの確認は無い。
> ⛔ **これは「主張が誤っている」ではない。**PostgreSQL のドキュメントに載っている一般的な性質である
> 可能性が高い。⭐ **測っていない、と書くだけである。**（ADR 0219 の掃きで残ったもの）

- **文脈**:

  マネージャーが現物で確認した事実として渡された、次の1点を直す。

  `packages/postgres/src/memory-store.ts` の `updateStatus` の `WHERE` は
  `tenant_id = ... AND id = ...` だけで、**`status` を条件にしていない。**

  `packages/core/src/runtime.ts` の `reextract` は次の順で動く:

  1. `listBySourceObservation`（既存 Memory を読む）
  2. `classifyReextractTargets`（`status !== 'active'` の Memory を対象外にする——ADR 0028
     の安全弁: `forgotten` を絶対に触らない・`contested` も対象外）
  3. `updateStatus(ctx, id, "superseded")`（書く）

  読み（1）と書き（3）の間に、他の誰かが同じ Memory に対して
  `updateStatus(ctx, id, "forgotten")` を呼ぶと、2の判定は「読んだ時点では `active`
  だった」という古い情報に基づいたまま3が実行され、**`forgotten` を絶対に触らない**という
  安全弁が TOCTOU（time-of-check to time-of-use）で破れる。しかも `updateStatus` が
  status を条件にしていないため、この上書きは**何のエラーも出さずに成功し、誰にも
  見えない**——ADR 0028・0029 が積み上げてきた「飛ばした理由を出す」という仕事を、
  一段深いところで無効化しかねない。

  `MemoryStore` も `PostgresMemoryStore` も公開 export であり
  （`packages/core/src/index.ts`・`packages/postgres/src/index.ts`）、利用側アプリが
  `updateStatus(ctx, id, "forgotten")` を直接呼ぶのが**今日の論理削除の口**である
  （リポジトリ自身の適合テスト・`packages/core/src/__tests__/runtime.test.ts` がその形で
  検査している）。**`Runtime` に `forget()` という動詞はまだ実装されていない**
  （`Runtime` interface は `{ observe, tick, recall, reextract }` の4つのみ）。
  docs/architecture.md §3.2 の「破棄系 — `forget(ctx, target)`」は設計時点の見取り図であり、
  実装済みの API ではない。本 ADR は「利用者が `forget()` を呼ぶと」という書き方をしない
  ——そう書くと実装済みであるかのように読める嘘になる。実際に安全弁を破る経路は
  「`MemoryStore.updateStatus` を直接呼べる誰か（アプリ側のコード、あるいは将来実装される
  `forget()`）」である。

  **この PR で直すのはこの1点だけ。** 他にも「読んでから書く」箇所はリポジトリ内に
  存在するが、範囲を広げない（マネージャーが別途住所を作る）。

- **決定**:

  1. `packages/core/src/interfaces/memory-store.ts` の `updateStatus` に
     `opts.expectedStatus?: MemoryStatus` を追加する。

     ```ts
     updateStatus(
       ctx: Ctx,
       id: MemoryId,
       status: MemoryStatus,
       opts?: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
     ): Promise<Memory>;
     ```

     **単数にする**（配列・集合にしない）。理由は「採らなかった案」参照。
     **省略時は今日と一字も変えない**——status を条件にせず常に更新する。既存の呼び出し元
     （`archived`/`forgotten` への遷移など）・適合テストを壊さない。

  2. `MemoryStatusConflictError`（`Error` の派生、`packages/core/src/interfaces/memory-store.ts`
     で定義・export）を新設する。`packages/postgres/src/advisory-lock.ts` の型付き
     エラー階層（`AdvisoryLockTimeoutError`/`AdvisoryLockUnavailableError`）に倣う。

     ```ts
     class MemoryStatusConflictError extends Error {
       constructor(
         readonly memoryId: MemoryId,
         readonly expectedStatus: MemoryStatus,
         readonly observedStatus: MemoryStatus | null,
       );
     }
     ```

     `observedStatus` は**弾かれた後に読み直した値であり、弾かれた瞬間の値とは限らない**
     ——adapter は `UPDATE ... WHERE status = expectedStatus` が0行だったときに追加の
     `SELECT` で読み直すため、その `SELECT` と実際に条件が破れた瞬間の間にも別の書き込みが
     割り込む余地がある。「衝突があったこと」は確実だが「衝突した相手の正確な値」としては
     読まないこと、と doc コメントに明記した。

     「対象が無い」は今日どおり別の例外（`Error`、`memory not found`）のまま——
     `packages/testkit/src/memory-store-conformance.ts` の既存の歯がこれを期待している。

  3. `packages/postgres/src/memory-store.ts` の `updateStatus`: `expectedStatus` が
     あるときだけ `AND status = ${expectedStatus}` を足す。0行だった場合、
     `SELECT status FROM memories WHERE tenant_id AND id` で読み直し、行が無ければ
     「memory not found」、行があれば `MemoryStatusConflictError`（`observedStatus` に
     読んだ値）を投げる。`expectedStatus` が無いときは今日と一字も変えない。

  4. `packages/core/src/strategies/reextract.ts`:
     - `ReextractSkip` に `{ kind: "status_changed_concurrently"; memoryId: MemoryId;
       observedStatus: MemoryStatus | null }` を追加する。**件数の欄を持たせない**
       （ADR 0029 の規約を継ぐ）。
     - `status_not_active` の `status: Exclude<MemoryStatus, "active">` と違い、こちらの
       `observedStatus` は `MemoryStatus | null` にした。**この非対称は構造的に保証できない
       ことの反映**——`status_not_active` は `classifyReextractTargets` 自身が読んだ
       `Memory.status` をそのまま運ぶので `"active"` を除いた型で閉じられるが、
       `status_changed_concurrently` は adapter が競合を検知した「後」に読み直した値を
       運ぶため、読み直した時点で行が消えている可能性を型として排除できない。
     - 判定を純関数 `classifySupersedeFailure(memoryId, error): ReextractSkip | null` に
       切り出す（ADR 0029 の `classifyReextractTargets` と同じ「純関数の戦略」——DB を
       持たない `packages/core` で手元の値に直接変異を撃てるようにするため）。
       `MemoryStatusConflictError` なら skip を返し、**それ以外なら `null` を返す**。

  5. `packages/core/src/runtime.ts` の `reextract` の supersede ループ:
     `updateStatus(ctx, existing.id, "superseded", { supersededById, expectedStatus: "active"
     })` を try/catch で囲み、`classifySupersedeFailure` に掛ける。skip が返れば
     `skipped` に積み、`supersededMemoryIds` には入れず、`eventStore.append` も呼ばない
     （`superseded` イベントを積むと「置き換えた」という監査ログが嘘になる）。`null` が
     返れば**そのまま再送出**する。🔴 安全弁3として、既存の 🔴 安全弁1・2 と同じ書式で
     コメントを足した。

  6. `packages/testkit/src/__fixtures__/in-memory-memory-store.ts` と
     `packages/core/src/__tests__/runtime-fakes.ts` の `FakeMemoryStore` にも同じ意味論
     （`expectedStatus` があるときだけ CAS）を実装した。`FakeMemoryStore` には加えて
     `beforeUpdateStatus`（テスト専用のフック、CAS 判定の直前に呼ばれる）を足した——
     `reextract` の TOCTOU を確率的な並行では再現せず、決定的な差し込みで再現するための
     機構（「歯について」参照）。

  **CAS にした時点で、これは競合を確率的に再現しなくても検査できる。** 「読んだ後・書く前に
  status が変わった」という決定的な差し込みで足りる——確率的な並行テスト（タイミングを
  ずらして「たまたま」競合させる）より、差し込みのほうが**厳密**である。確率的な検査は
  「今回はこのタイミングで競合が起きた/起きなかった」を報告するだけで、次に実行したときに
  同じ結果になる保証が無い。決定的な差し込みは「この瞬間に競合したら何が起きるか」を毎回
  必ず検査する。これが本 PR の歯の作り方の基本方針である。

- **採らなかった案**:

  - **更新0行を黙って成功にする**（`updateStatus` が「対象が0行でもエラーにせず、
    現在の行を読んで返すだけ」にする）: 却下。ADR 0008 と同族の理由——**「安全弁が効いた」
    と「何も起きなかった」が同じ顔になる。** `reextract` が「競合したので supersede
    しなかった」ことと「たまたま何も supersede すべきものが無かった」ことを、呼び出し側が
    区別できなくなる。ADR 0029 がまさに「同じ顔になっている状態」を負債として解消した
    直後に、同じ形の負債を `updateStatus` の層に作り直すことになる。

  - **`expectedStatus` を集合（配列）にする**（`expectedStatus?: MemoryStatus[]`）: 却下。
    現時点の唯一の呼び出し元（`reextract`）が要る条件は `"active"` の1つだけであり、
    集合にする理由が無い。集合にすると「複数の値のどれとも一致しなかった」場合の
    `observedStatus`（実際に観測した1つの値）と「期待していた候補の集合」の関係を
    `MemoryStatusConflictError` の型でどう表現するかという新たな設計判断が要り、
    使われない自由度のために型を複雑にするだけになる。将来、複数の status からの遷移を
    CAS で守りたい呼び出し元が実際に現れたら、そのとき単数から集合へ拡張する
    （「これが覆るとしたら」参照）。

  - **supersede ループ全体を1トランザクションに包む**: 範囲外。PR #27（ADR 0029）の
    本文が既にこれを別項目として挙げている——複数の Memory を supersede する一連の
    `updateStatus` + `eventStore.append` の呼び出し列全体を原子化するかどうかは、
    本 PR が直す「単発の compare-and-swap」より広いスコープの判断であり、
    マネージャーが別途住所を作る。CAS 自体はトランザクションの有無に関わらず機能する
    ——1行ずつの整合性を守ることと、複数行にまたがる操作全体の原子性を守ることは
    別の問題である。

  - **advisory lock で直列化する**（ADR 0017/0018 の形）: 却下。advisory lock は
    「同じキーを取り合う複数プロセスを直列に並べる」ための機構であり、ADR 0017/0018 では
    `runMigrations`/`registerEmbeddingSpace` という**まれにしか起きない・全体を一度だけ
    正しく行いたい**操作に使っている。`updateStatus` は逆に、**日常的に大量に呼ばれる
    单一行の更新**であり、advisory lock で直列化すると「Memory 1件を更新するたびに
    プロセス間ロックを取り合う」という過剰な直列化になる。CAS（`WHERE status = ...`）は
    Postgres の行レベルロック・MVCC がもともと提供する仕組みに乗るだけで、
    同じ保証を遥かに安いコストで得られる。「待って取れた／時間切れ／機構自体が
    使えなかった」という advisory lock 特有の3状態も、単一行の条件付き UPDATE には
    そもそも要らない（UPDATE は待たされることはあっても「取れない」という状態を
    持たない——他のトランザクションのロック解放を待って、そのまま条件を再評価するだけ）。

- **歯について**:

  基準線: `pnpm run test` の出力で root 7 / `packages/core` 197 / `packages/testkit` 63 /
  `packages/openai` 20（マネージャー実測値と一致することを確認済み）。本 PR 後:
  root 7（変わらず）/ `packages/core` 203（+6: `reextract.test.ts` に4本、
  `runtime.test.ts` に2本）/ `packages/testkit` 68（+5）/ `packages/openai` 20（変わらず）。

  - `packages/core/src/__tests__/reextract.test.ts`（新設）: `classifySupersedeFailure` の
    純関数テスト。`MemoryStatusConflictError` → skip（`observedStatus` を運ぶ、`null` の
    場合も含む）、ただの `Error`・非 `Error` 値 → `null`。
  - `packages/core/src/__tests__/runtime.test.ts` に
    `describe("compare-and-swap（ADR 0030: ...）")` を新設:
    - ⭐ **決定的な TOCTOU の再現**: `FakeMemoryStore.beforeUpdateStatus` で、対象 Memory
      M への1件目の書き込みが来た瞬間に M を `forgotten` に変える。フィクスチャを
      **非対称**にした（M は割り込みを受ける、別の対象 N は受けない・content も
      digest も別の値）——「件数は合っているが対応が崩れている」変異も捕まえるため。
      M が `forgotten` のまま・`supersededMemoryIds` に入らない・`superseded` イベントが
      積まれない・`skipped` に `status_changed_concurrently`（`observedStatus: "forgotten"`）
      が出ることと、同じ呼び出しの中で N が普通に supersede されることを1本の歯で
      並べて assert した。
    - `updateStatus` が競合でない例外（接続断相当）を投げたとき、`reextract` がそれを
      飲み込まずそのまま再送出することを確認する歯。
  - `packages/testkit/src/memory-store-conformance.ts` に5本追加
    （in-memory 実装に対して手元で走り、CI では postgres 実装にも走る）:
    `expectedStatus` 一致で更新される・不一致で `MemoryStatusConflictError` かつ行が
    一切変わっていない（読み直して確認）・`observedStatus` に現在の値が入る・省略時は
    今日どおり・存在しない id + `expectedStatus` は競合ではなく「対象が無い」の例外。
  - `packages/postgres/src/__tests__/memory-store-update-status-concurrency.test.ts`
    （新設、**CI の postgres ジョブでしか走らない**）: `migrate-concurrency.test.ts`/
    `vector-space-concurrency.test.ts` の構え（別々の `Pool` を N=4 本、同一 `Pool` を
    共有しない）に倣い、同じ1行に対して4本が同時に
    `updateStatus(..., 'superseded', { expectedStatus: 'active' })` を撃つと、
    **ちょうど1本だけ成功し残り3本が `MemoryStatusConflictError`**・最終状態が
    `superseded` 1回分であることを検査する。**この歯は手元では実行していない**——
    この器には Docker/PostgreSQL/`DATABASE_URL` が無く、`requireDatabaseUrl()` が
    未設定を検知してテストランナー自体が起動しない。

  変異を4本撃った（すべて新設した歯だけが固有に捕まえ、既存の197本は無傷のまま。
  実測値・落ちたテスト名は PR 本文の変異の表を参照）:

  - M1（`runtime.ts` から `expectedStatus: "active"` を落とす）: `packages/core` で
    203本中1本が赤くなる（⭐ 決定的な TOCTOU の再現の歯）。
  - M2（in-memory fixture の CAS 条件を落とす）: `packages/testkit` で68本中2本が赤くなる
    （expectedStatus 不一致の conformance テスト2本）。
  - M3（`classifySupersedeFailure` の `instanceof` 判定を潰し常に skip を返す）:
    `packages/core` で203本中3本が赤くなる（`classifySupersedeFailure` の純関数テスト2本
    ＋「競合でない例外はそのまま再送出される」の歯1本）。**⭐ 決定的な TOCTOU の再現の歯は
    このケースでは赤くならない**——この変異は「本物の競合」に対しては正しく skip を返す
    ため、TOCTOU 再現の歯自体は通ってしまう。競合でない例外まで skip に化けさせることを
    専用の歯（M3 が狙う欠陥そのもの）だけが捕まえる。
  - M4（`reextract` が skip を `skipped` に積むのをやめる）: `packages/core` で203本中
    1本が赤くなる（⭐ 決定的な TOCTOU の再現の歯——`skipped` の中身を assert している）。

- **引き受ける負債**:

  - **`observedStatus` は弾かれた瞬間の値ではない**（このファイル冒頭で既述）。
    「弾かれた後に読み直した値」を運ぶという設計は意図的だが、極めて短い窓の中で
    さらに別の書き込みが2回連続で割り込んだ場合、`observedStatus` が「実際に
    `updateStatus` を弾いた status」とすら一致しない可能性がゼロではない
    （読み直しと読み直しの間にもう一段 TOCTOU がある——ただし、これは「衝突があった
    こと」自体の検知を誤らせない。誤りうるのは衝突相手の正確な値の報告だけである）。
  - **`expectedStatus` は単数のまま**（「採らなかった案」参照）。複数の呼び出し元が
    複数の異なる遷移元 status を CAS で守りたくなったら、この設計は拡張が要る。
  - **supersede ループはトランザクションで包まれていない**（範囲外、PR #27 の既存項目）。
    ある Memory の CAS が成功して superseded イベントが積まれた直後に、別の Memory の
    CAS が失敗して例外が再送出されると、ループは途中で止まる——先に成功した分は
    ロールバックされない。これは本 PR が作った新しい負債ではなく、ADR 0028 の時点から
    存在する構造（本 PR は個々の `updateStatus` 呼び出しを CAS にしただけで、ループの
    原子性には手を付けていない）。
  - **`reextract` 以外の「読んでから書く」箇所は本 PR の範囲外**。マネージャーの指示により
    範囲を1点に絞った。他の箇所（存在は調査で把握しているが、本 ADR では列挙しない
    ——調査の詳細は PR 本文の「範囲外として触っていないもの」を参照）は別途住所が
    作られる。

- **確かめていないこと**:

  - **この器に Docker/PostgreSQL/`DATABASE_URL` が無い。** `packages/postgres` の
    新設テスト（compare-and-swap の本物の並行、および conformance テストの postgres
    版）は CI の postgres ジョブが唯一の実行環境であり、本 PR の作業では実行していない。
    手元で確認できたのは (a) 型検査・lint・format が通ること、(b) `packages/core`/
    `packages/testkit` の DB 不要な歯がすべて通ること、(c) `pnpm run build` が通ること
    ——のみである。
  - **Postgres の SQL から `AND status = ${expectedStatus}` を落とす変異**は、上と同じ
    理由で手元で走らせられない。CI の postgres ジョブが唯一の検査経路になる
    （PR 本文「覆えていない範囲」に明記）。
  - **本物の並行**（複数プロセスが実際に同時にネットワーク越しで `UPDATE` を撃つときの
    タイミング）で「ちょうど1本だけ成功する」ことは、CI 上で初めて実測される。
    ローカルではロジックの読み合わせと型検査のみに基づく設計上の期待である。

- **これが覆るとしたら**:

  - 複数の呼び出し元が異なる遷移元 status の集合を CAS で守りたくなったら、
    `expectedStatus` を単数から集合へ拡張することを検討する。
  - supersede ループの原子性（複数 Memory にまたがる操作全体をトランザクションで包む）が
    実際に必要だと分かったら、それは本 ADR の範囲外の新しい ADR になる。
  - CI の postgres ジョブで実測した結果、4本同時実行のうち「ちょうど1本」という前提が
    崩れる（例えばデッドロックで複数本が失敗する）ことが分かったら、リトライ戦略や
    ロック待ちの扱いを再検討する必要が生じる。
