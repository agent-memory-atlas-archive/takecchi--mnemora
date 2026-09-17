# ADR 0005: Job Queue の抽象

- **状態**: 採用 (2026-09)

> **⚠ 2026-09-17 追記（名乗りの復元。本文は書き換えていない）。**
> 本文の「**BullMQ は 2026 時点でも活発に開発が続いており、既に広く使われている実績がある**」と
> 「**BullMQ は活発に保守されており、Node.js エコシステムでの実績が長い**」は、
> **この repo に裏づける実測が無い。**GitHub の活動（commit・issue・contributor 数）や
> npm のダウンロード数への言及は1つも無い。
> **【現物】同じ commit `1cf6a60`（PR #1）で、同一ファイルに2回書かれている ⟹ 執筆の事故である。**
> ⛔ **これは「主張が誤っている」ではない。**BullMQ が広く使われていること自体は事実である可能性が高い。
> ⭐ **測っていない、と書くだけである。**（ADR 0219 の掃きで残ったもの）

- **文脈**:
  `reflect` / `consolidate` の背景実行、および `observe(extract: 'deferred')` の非同期抽出は、
  何らかのジョブキューを必要とする。一方で mnemora は Postgres を必須要件としているが、Redis のような
  追加ミドルウェアは必須にしたくない（`docs/vision.md` の「やらないこと」に対応する制約意識、
  および Phase 1 を最小構成で成立させる方針）。キューの実装をどう選び、どう抽象化するかを決める必要がある。

- **検討した選択肢**:
  - **キュー実装を直接 core または runtime に固定で結びつける**（BullMQ を interface なしで直接呼ぶ）:
    実装は単純だが、`docs/architecture.md` §4「core は誰にも依存されるが誰にも依存しない」という方針
    および `docs/decisions/0003-memorystore-vs-vectorstore.md` と同種の「差し替え可能性」の要求に反する。
    Redis を持たない構成（Phase 1 の最小構成）を作れなくなる。却下。
  - **`Scheduler` interface を切り、リファレンス実装は BullMQ**: 採用（下記）。
  - **`pg-boss` を唯一の実装にする**: mnemora が Postgres を必須にしている以上、Redis を増やさずに済む
    という利点は大きい。実際、`pg-boss` は有力な代替として繰り返し挙がった。ただし BullMQ は 2026 時点
    でも活発に開発が続いており、既に広く使われている実績がある。**どちらか一方だけを唯一の実装にする
    必然性が無い**——`Scheduler` interface を切ってあれば両方を adapter として持てる。「`pg-boss` のみ」を
    選ばなかったのは、BullMQ を排除する理由が無かったため。

- **決定**:
  `Scheduler` interface を切る。リファレンス実装は **BullMQ**（`packages/bullmq`）とする。
  **`pg-boss` を一級の代替として明記する。**mnemora は Postgres を必須としているが Redis は必須ではないため、
  Redis を増やしたくない構成では `pg-boss` ベースの adapter を選べる余地を最初から用意する。

  パッケージ名はオーナー案の `redis` から **`bullmq`** に改名した。依存の中心は Redis というミドルウェア
  そのものではなく、`Scheduler` を実装する BullMQ というライブラリだからである。Redis を単体で
  使う用途（キャッシュ等）は Phase 3 まで発生せず、パッケージ名を実際に依存している役割に合わせた。

- **理由**:
  1. mnemora の必須インフラは Postgres であり、Redis はオプションでありたい。`Scheduler` を interface
     化すれば、Redis を持たない構成（`InlineScheduler`。下記）と、Redis を持つ構成（BullMQ）の
     どちらも同じ core の上で成立する。
  2. **transactional outbox（`docs/architecture.md` §3.4）により、キューは「outbox を運ぶ役」に
     縮小されている。**`observe()` の DB コミットと「抽出ジョブを積む」は同一トランザクションで
     `outbox` テーブルへの書き込みとして行われ、実際のキュー（BullMQ でも pg-boss でも）へは
     別の運搬役（relay）が outbox の未処理行を読んで渡す。**キューの選択が、この設計のおかげで
     支配的な決定ではなくなっている——これがこの抽象の狙いである。**キューを差し替えても
     outbox の書き込み契約自体は変わらない。
  3. BullMQ は活発に保守されており、Node.js エコシステムでの実績が長い。`pg-boss` は Postgres
     依存を増やさないという明確な利点を持つ代替であり、どちらを選ぶかは運用環境（Redis を既に
     持っているか）に依存する判断であって、mnemora の設計が強制すべきことではない。

- **DB トランザクションの中から外部システムへ直接書かない理由**:
  `observe()` のトランザクション内で Redis（BullMQ）や Postgres 外のキューへ直接エンキューすると、
  コミットとエンキューが分離するため at-least-once が壊れる。DB がコミットされたのにジョブが飛ばない、
  または DB がロールバックしたのにジョブだけ残る、のどちらかが起こりうる。そのため `observe()` は
  同一トランザクションで書ける `outbox` テーブルへジョブを書き、実際のキューへの引き渡しは
  トランザクションの外側にある別プロセス（relay）に任せる。

- **結果（この決定が招くもの）**:
  良い面: Redis 無しの最小構成（`InlineScheduler`、下記）が最初から成立する。BullMQ と pg-boss の
  どちらを選んでも `Scheduler` interface とその上の runtime コードは変わらない。at-least-once の
  保証が outbox という単一の機構に集約され、キュー実装ごとに個別に保証する必要が無い。

  引き受ける負債: outbox テーブルとその relay（outbox の未処理行を読んでキューへ渡すプロセス）を
  Phase 1 から持つ必要がある。`deferred` を Phase 1 に含める以上、outbox もセットで Phase 1 の
  成果物になる。relay 自体の失敗・再送・重複配信は抽出側の冪等キー
  （`(observationId, extractorVersion)`）が吸収する前提であり、Scheduler 自体は enqueue の重複に
  対して冪等でなくてよい、という設計になっている。

- **`InlineScheduler`（キュー無し）で Background Cognition を切っても成立すること**:
  `Scheduler` の既定実装は **`InlineScheduler`** であり、呼び出しコンテキストの中で同期的に
  `enqueue` を実行する。外部プロセスを必要としない。ただし `observe()` が `extract: 'deferred'` を
  選び、かつ Scheduler が `InlineScheduler`（実質的にキューを持たない）構成では、積まれたジョブを
  誰かが実際に消化しなければ抽出が永久に走らない。この継ぎ目を隠さず、**`runtime.tick(ctx, opts)`**
  として明示的に露出する判断をした。cron や手動呼び出しから叩ける形にし、「キューが無ければ
  黙って何も起きない」という状態を作らない。

- **これが覆るとしたら**:
  - `pg-boss` の実運用実績が BullMQ を明確に上回り、リファレンス実装を入れ替えた方が新規ユーザーの
    体験が良いと判断できたら、リファレンス実装を差し替える（`Scheduler` interface があるため
    コストは低い）。
  - outbox + relay の構成が実運用で遅延やスループットの問題を起こすと分かったら、relay の実装
    （ポーリング間隔、LISTEN/NOTIFY の活用等)を見直す。これは Scheduler 選択とは独立した課題である。

- **確かめていないこと**:
  - `pg-boss` を実際に adapter として実装した場合の、BullMQ 実装との性能差・運用差は検証していない。
    「一級の代替として明記する」は interface レベルの位置づけの話であり、実装の比較検証は未実施。
  - outbox の relay をどう実装するか（ポーリングか LISTEN/NOTIFY か）は本 ADR の範囲外で、
    Phase 1 の実装時に決める。
