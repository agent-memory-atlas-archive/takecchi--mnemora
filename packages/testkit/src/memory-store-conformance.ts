import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EmbeddingStatus } from "@mnemora/core";
import type {
  Ctx,
  MemoryEvent,
  MemoryId,
  MemoryStore,
  NewMemoryEvent,
  OutboxJobRecord,
  RecallId,
} from "@mnemora/core";
import {
  ContestedWithoutCompanionError,
  defaultActivityDecayStrategy,
  defaultDecayStrategy,
  FILTERED_CONDITION_SCOPE_RELATION,
  MemoryPurgeConflictError,
  MemoryStatusConflictError,
} from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "./test-data.js";

/**
 * 「対象が無い」系の検査専用の、well-formed だが実在しない id。
 *
 * この適合テストは複数の `MemoryStore` 実装（postgres / in-memory）に同じ入力を
 * 投げて、*同じ種類の*失敗になることを測る（このファイル冒頭の doc コメント参照）。
 * `packages/postgres` の `memories.id` は `uuid` 型（migrations/0001_init.sql）で、
 * `setEmbeddingStatus`/`reinforce`/`updateStatus` は `getObservation` と違い
 * `isUuidLike` による事前チェックを持たない（packages/postgres/src/memory-store.ts）ため、
 * UUID の形をしていない文字列（例: 旧 `"does-not-exist"`）を渡すと Postgres 側だけ
 * SQL 実行時点でドライバの `invalid input syntax for type uuid` が飛ぶ——in-memory側は
 * 意図した「memory not found」を投げる。**id を well-formed な UUID に揃えないと、
 * 両実装がここで初めて違う種類の失敗を返すようになり、後段でメッセージを
 * `/memory not found for tenant/` に固定したときに、測りたい対象（「対象が無い」を
 * 両実装が同じに扱っているか）ではなく、この入力形式の食い違いだけで赤くなってしまう**。
 * `randomUUID()` で実行のたびに新しい値を生成すれば、fixture が作る実在の id
 * （store が発行する UUID）と衝突しないことは構造的に保証される。
 */
const NONEXISTENT_MEMORY_ID = randomUUID();

/**
 * 「対象が無い」異常系が投げる例外を検査するための、両実装に共通する部分文字列。
 *
 * `packages/postgres/src/memory-store.ts` は
 * `PostgresMemoryStore: memory not found for tenant: ${id}`、
 * `InMemoryMemoryStore`（packages/testkit/src/__fixtures__/in-memory-memory-store.ts）は
 * `InMemoryMemoryStore: memory not found for tenant: ${id}` を投げる——共通する安定した
 * 部分が `memory not found for tenant`。引数なしの `.rejects.toThrow()` は「何かが
 * 投げられた」しか測らないため、`if (!memory) throw ...` を消しても、null に対する
 * プロパティアクセスが投げる `TypeError`（例: `Cannot set properties of null`）で
 * 同じく満たされてしまい、意図した「対象が無い」分岐を検査したことにならない。
 * メッセージをこのパターンに固定することで、`TypeError` のような別種の失敗と
 * 区別する。
 */
const NOT_FOUND_ERROR_MESSAGE = /memory not found for tenant/;

export interface MemoryStoreConformanceOptions {
  /** テスト出力に出す adapter 名（例: "postgres", "in-memory"）。 */
  name: string;
  /** テストケースごとに独立した状態を持つ新しい MemoryStore を返す。 */
  createStore: () => MemoryStore | Promise<MemoryStore>;
  /**
   * `recordUsage` を呼ぶ前に、有効な `recallId` を用意するためのフック。**必須。**
   *
   * docs/memory-model.md §10 の DDL は `recall_usages.recall_id` を `recalls(id)` への
   * 外部キーにしている。`MemoryStore` interface 自体には「recall を記録する」操作が無い
   * （それは recall() の実装、roadmap.md 段階4の責務）ため、この適合テストは
   * `recordUsage` を単体で検査する際に使う `recallId` をどう用意するかを adapter に委ねる。
   *
   * **ADR 0047 より前は省略可で、省略時は固定文字列 `"recall-1"` を使っていた**——
   * 当時は「外部キーを持たない in-memory 実装向け」の既定として正当だったが、ADR 0047 で
   * `InMemoryMemoryStore`/`FakeMemoryStore` にも `recall_usages` 相当の外部キーを適用した
   * ため、この既定は「実在しない recallId」を意味するようになった。**省略可のオプションの
   * ままにしないこと**——`vector-store-conformance.ts` の `prepareMemoryId`
   * （ADR 0034）と同じ理由: 省略できると「外部キーを実際に検査できる adapter」と
   * 「検査できない adapter」が同じ緑色の出力になる。
   */
  prepareRecallId: (ctx: Ctx) => Promise<RecallId> | RecallId;
  /**
   * ADR 0031: `updateStatusWithEvent` が実際に `memory_events`（相当）へ書いたイベントを
   * 読み出すためのフック。**必須。**「CAS に弾かれたときイベントが1件も積まれていないこと」
   * を検査するには、適合テストがイベントを直接読める必要がある——`MemoryStore` interface
   * 自体には「あるメモリに紐づくイベントを読む」操作が無い（それは `EventStore` の責務）ため、
   * `prepareRecallId` / `outbox-store-conformance.ts` の `seedJob` と同じ理由で、
   * adapter ごとの用意の仕方を呼び出し側に委ねる。**省略可のオプションにしないこと**——
   * 省略できると「検査した」adapter と「検査していない」adapter が同じ緑色の出力になり、
   * このリポジトリが ADR 0011/0025/0027/0028 で繰り返した「名乗れる以上の精度を主張する」
   * 族の失敗を、フックの省略という形で再現することになる。
   */
  listEventsForMemory: (ctx: Ctx, memoryId: MemoryId) => Promise<MemoryEvent[]> | MemoryEvent[];
  /**
   * ADR 0079: `requeueEmbedJobs` が積み直した `embed` ジョブを、**運搬役が実際に
   * claim できるところまで**検査するためのフック。**必須。**
   *
   * `requeueEmbedJobs` の眼目は「`embeddingStatus` が `pending` に戻ること」ではなく
   * **「もう一度処理されるようになること」**である。前者だけを見る歯は、outbox への
   * INSERT を丸ごと落としても緑のままになる——`recall` から見た `notIndexed.pending` が
   * 増えるだけで、**直すつもりが「待っても解けない `pending`」を増やす**という、
   * この ADR がまさに塞ごうとしている状態そのものを作る。
   *
   * `MemoryStore` interface 自体には「積まれたジョブを claim する」操作が無い
   * （それは `OutboxStore` の責務）ため、`prepareRecallId` / `listEventsForMemory` と
   * 同じ理由で、adapter ごとの用意の仕方を呼び出し側に委ねる。**省略可のオプションに
   * しないこと**——省略できると「積み直しが本当に運ばれる adapter」と「戻しただけの
   * adapter」が同じ緑色の出力になる。
   *
   * 実装は `OutboxStore.claimBatch` を `kinds: ["embed"]` で呼んで返すこと
   * （`now` は呼び出し側が渡す。`leaseMs` はこの検査の中だけの値でよい）。
   */
  claimEmbedJobs: (ctx: Ctx, now: Date) => Promise<OutboxJobRecord[]> | OutboxJobRecord[];
  /**
   * Issue #134 / ADR 0100: 対象の `MemoryStore` 実装が `supersedeWithNewMemories`
   * （任意メソッド）を実装しているかどうか。**必須。**
   *
   * ADR 0031 決定9 / ADR 0047 決定9 と同じ判断——**省略可にしないこと。**省略できると
   * 「原子性の歯を実際に検査した」adapter と「検査していない」adapter が同じ緑色の
   * 出力になり、このリポジトリが ADR 0011/0025/0027/0028/0034/0047 で繰り返した
   * 「名乗れる以上の精度を主張する」族の失敗を、フックの省略という形で再現することになる。
   *
   * `true` なら原子性の歯（成功／CAS 競合が `conflicted` に出て他は commit される／対象
   * 不在で「memory not found」・news の作成ごと rollback／`supersededById` の外部キー／
   * `news` が複数件）を実行する。`false` なら
   * `expect(store.supersedeWithNewMemories).toBeUndefined()` を積極的に assert する
   * ——`it.skip` にはしない（`docs/autonomy.md` ⛔、マネージャー指示）。
   */
  supportsSupersedeWithNewMemories: boolean;
  /**
   * Issue #210 / ADR 0115: 対象の `MemoryStore` 実装が `purgeExpiredEvents`
   * （任意メソッド）を実装しているかどうか。**必須。**
   *
   * ADR 0031 決定9 / ADR 0100 と同じ判断——省略可にしない。`true` なら削除の歯
   * （境界・テナント越境しない・`limit`/`reachedLimit`・`dryRun` で1行も変わらない・
   * `events_purged` が件数と期間を持つ・`events_purged` 自身は対象から除外される）を
   * 実行する。`false` なら `expect(store.purgeExpiredEvents).toBeUndefined()` を
   * 積極的に assert する。
   */
  supportsPurgeExpiredEvents: boolean;
  /**
   * Issue #210 / ADR 0115: `purgeExpiredEvents` が積んだ `events_purged` イベント
   * （`memoryId: null`）を読み出すためのフック。`supportsPurgeExpiredEvents: true` の
   * ときだけ呼ばれる。`listEventsForMemory` と同じ理由で必須にする——`MemoryStore`
   * interface 自体には「あるテナントの `events_purged` を読む」操作が無いため。
   */
  listPurgedEvents: (ctx: Ctx) => Promise<MemoryEvent[]> | MemoryEvent[];
  /**
   * ADR 0114: 対象の `MemoryStore` 実装が `archiveDecayed`（任意メソッド）を
   * 実装しているかどうか。**必須。**
   *
   * `supportsSupersedeWithNewMemories` と同じ判断——**省略可にしないこと。**省略できると
   * 「掃引の歯を実際に検査した」adapter と「検査していない」adapter が同じ緑色の
   * 出力になる。
   *
   * `true` なら契約の歯（`status='active'` かつ `decayFloorAt <= now` のみを対象にする、
   * `contested`/`superseded`/`forgotten`/既に `archived` な行は触らない、境界は `<=`
   * で含む、`decayFloorAt` 昇順で `limit` 件まで、`limit` ちょうど返したときだけ
   * `reachedLimit: true`、`memory_events` に `kind='archived'` が1件だけ積まれ
   * `digestSnapshot` が更新前の digest と一致する、テナント分離、対象0件でも例外を
   * 投げない）を実行する。`false` なら
   * `expect(store.archiveDecayed).toBeUndefined()` を積極的に assert する
   * ——`it.skip` にはしない。
   */
  supportsArchiveDecayed: boolean;
  /**
   * Issue #198 / ADR 0124: 対象の `MemoryStore` 実装が `purgeMemory`（任意メソッド）を
   * 実装しているかどうか。**必須。**
   *
   * `supportsArchiveDecayed`/`supportsPurgeExpiredEvents` と同じ判断——省略可にしない。
   * `true` なら契約の歯（`forgotten` かつ未 purge のみを対象にする、`content`/`digest`
   * がトゥームストーンで上書きされ `purgedAt` が設定される、`status` は動かない、
   * `active`/`archived`/`superseded`/`contested`/既に purge 済みは
   * {@link MemoryPurgeConflictError} で弾かれる、対象が無ければ「memory not found」、
   * `memory_events` に `kind='purged'` が1件だけ積まれ `digestSnapshot` が更新前の
   * digest と一致する、テナント分離）を実行する。`false` なら
   * `expect(store.purgeMemory).toBeUndefined()` を積極的に assert する
   * ——`it.skip` にはしない。
   */
  supportsPurgeMemory: boolean;
  /**
   * Issue #197 / ADR 0134: 対象の `MemoryStore` 実装が `markContestedPair`
   * （任意メソッド）を実装しているかどうか。**必須。**
   *
   * `supportsArchiveDecayed`/`supportsPurgeMemory` と同じ判断——省略可にしない。
   * `true` なら契約の歯（両側 `status='active'` のみを対象にする、成功すると両側が
   * `contested` になり `contestedWithId` が相互に設定される、片方でも `active` でなければ
   * {@link MemoryStatusConflictError} で弾かれ両側とも無傷、対象が無ければ
   * 「memory not found」で両側とも無傷、`first.id === second.id` は `RangeError`、
   * `memory_events` に両側1件ずつ積まれる、テナント分離）を実行する。`false` なら
   * `expect(store.markContestedPair).toBeUndefined()` を積極的に assert する
   * ——`it.skip` にはしない。
   */
  supportsMarkContestedPair: boolean;
  /**
   * Issue #197 / ADR 0150: 対象の `MemoryStore` 実装が `resolveContestedPair`
   * （任意メソッド、`markContestedPair` の解決側）を実装しているかどうか。**必須。**
   *
   * `supportsMarkContestedPair` と同じ判断——省略可にしない。`true` なら契約の歯
   * （両側 `status='contested'` かつ相互参照が成立している場合のみを対象にする、
   * 成功すると `contestedWithId` が両側とも `null` に戻り指定した `status`
   * （`'active'`/`'superseded'`）へ更新される、`superseded` を指定した側は
   * `supersededById` も書かれる、`status !== 'contested'` または相互参照が破れていれば
   * {@link MemoryStatusConflictError} で弾かれ両側とも無傷、対象が無ければ
   * 「memory not found」で両側とも無傷、`first.id === second.id` は `RangeError`、
   * `memory_events` に両側1件ずつ積まれる、テナント分離）を実行する。`false` なら
   * `expect(store.resolveContestedPair).toBeUndefined()` を積極的に assert する
   * ——`it.skip` にはしない。
   */
  supportsResolveContestedPair: boolean;
}

/**
 * `MemoryStore` の適合テスト（docs/architecture.md §5.1・§3.7）。
 *
 * ここでの契約は「型」ではなく「振る舞い」である。以下を実際に検査する:
 * - 2テナント分のデータを投入し、クロステナントの取得（get/getMany/aggregateScope/
 *   updateStatus/reinforce）がクロステナントとして扱われること（§3.7 必須契約）
 * - `createObservation` の冪等性（externalId の有無・一致/不一致の各分岐）
 * - `createMemory` の冪等性（§3.5、抽出キーの一致・不一致・sourceObservationId 無しの各分岐）
 * - `recordUsage` が実際に挿入が起きたときだけ `insertedMemoryIds` に載ること
 *   （D9・§3.5、全件新規/全件再送/部分再送/空配列の各分岐）
 * - `reinforce` / `updateStatus` の正常系と「対象が無い」異常系
 * - `updateStatusWithEvent`（ADR 0031）が status 更新とイベント追記を1つの操作として
 *   扱うこと——成功時は両方起きる、CAS に弾かれたら両方とも起きない、対象が無ければ
 *   両方とも起きない、の3分岐を「Memory の状態」と「積まれたイベント数」を並べて検査する
 * - `aggregateScope` の集計が実データを反映すること（群カウント・totalInScope・
 *   status ゲート・period フィルタ・not_indexed の各分岐、roadmap.md 段階4/5・
 *   docs/recall.md §5「スコープの外延」）
 * - `createRecall` が recallId を発行すること（段6、ADR 0008）
 */
export function describeMemoryStoreConformance(options: MemoryStoreConformanceOptions): void {
  const {
    name,
    createStore,
    listEventsForMemory,
    prepareRecallId,
    claimEmbedJobs,
    supportsSupersedeWithNewMemories,
    supportsPurgeExpiredEvents,
    listPurgedEvents,
    supportsArchiveDecayed,
    supportsPurgeMemory,
    supportsMarkContestedPair,
    supportsResolveContestedPair,
  } = options;

  describe(`MemoryStore conformance (${name})`, () => {
    // -------------------------------------------------------------------
    // テナント分離（docs/architecture.md §3.7）
    // -------------------------------------------------------------------

    it("2テナント分のデータを投入すると、クロステナントの get は null になる", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };

      const memoryA = await store.createMemory(
        ctxA,
        buildNewMemoryFixture({ tenantId: "tenant-a" }),
      );
      await store.createMemory(ctxB, buildNewMemoryFixture({ tenantId: "tenant-b" }));

      const crossTenantRead = await store.get(ctxB, memoryA.id);
      expect(crossTenantRead).toBeNull();

      const sameTenantRead = await store.get(ctxA, memoryA.id);
      expect(sameTenantRead?.id).toBe(memoryA.id);
    });

    it("2テナント分のデータを投入すると、クロステナントの aggregateScope は0件になる", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };

      await store.createMemory(ctxA, buildNewMemoryFixture({ tenantId: "tenant-a" }));

      const aggregateB = await store.aggregateScope(ctxB, {});
      expect(aggregateB.totalInScope).toBe(0);
      expect(aggregateB.groups).toEqual([]);
    });

    it("2テナント分のデータを投入すると、クロステナントの getMany は空配列になる", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };

      const memoryA = await store.createMemory(
        ctxA,
        buildNewMemoryFixture({ tenantId: "tenant-a" }),
      );

      const crossTenantRead = await store.getMany(ctxB, [memoryA.id]);
      expect(crossTenantRead).toEqual([]);
    });

    it("クロステナントの updateStatus/reinforce は対象が無いものとして失敗する", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const memoryA = await store.createMemory(
        ctxA,
        buildNewMemoryFixture({ tenantId: "tenant-a" }),
      );

      // ⚠ 引数なしの `.rejects.toThrow()` にしないこと。ここは**両実装が同じ種類の失敗**
      // （自分の「memory not found for tenant」）を返す経路なので、種類まで固定できる。
      // 引数なしだと、`if (!memory) throw` を消す変異が `TypeError: Cannot set properties
      // of null` を投げても緑のままになる——**実際にこの歯だけが素通ししていた**
      // （PR #29 が同じ形を直したとき、この2本は「クロステナント」なので対象から漏れていた）。
      await expect(store.updateStatus(ctxB, memoryA.id, "archived")).rejects.toThrow(
        NOT_FOUND_ERROR_MESSAGE,
      );
      await expect(store.reinforce(ctxB, memoryA.id, new Date())).rejects.toThrow(
        NOT_FOUND_ERROR_MESSAGE,
      );
    });

    // -------------------------------------------------------------------
    // createObservation の冪等性（docs/memory-model.md §10、observe() の再送）
    // -------------------------------------------------------------------

    it("createObservation は externalId が同じなら同じ Observation を返す（冪等）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const input = buildNewObservationFixture({ tenantId: "tenant-1", externalId: "ext-shared" });

      const first = await store.createObservation(ctx, input);
      const second = await store.createObservation(ctx, {
        ...input,
        payload: { text: "違うペイロード（無視されるべき）" },
      });

      expect(second.id).toBe(first.id);
    });

    it("createObservation は externalId が無ければ常に新しい Observation を作る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const input = buildNewObservationFixture({ tenantId: "tenant-1", externalId: null });

      const first = await store.createObservation(ctx, input);
      const second = await store.createObservation(ctx, input);

      expect(second.id).not.toBe(first.id);
    });

    it("createObservation は externalId が異なれば別の Observation を作る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      const first = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1", externalId: "ext-1" }),
      );
      const second = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1", externalId: "ext-2" }),
      );

      expect(second.id).not.toBe(first.id);
    });

    // -------------------------------------------------------------------
    // get / getMany（族A: 無い id は null/[] — 形式不正な id も例外を投げない）
    //
    // packages/postgres/src/mapping.ts の isUuidLike の doc コメントが定める規約:
    // 「存在しない」と「壊れた入力」を区別せずに済ませたい口では、形式チェックで
    // クエリを投げる前に判定し、DB 由来のエラーを呼び出し側に漏らさない。
    //
    // ⚠ 3つを並べて見る: 形式不正 / well-formed だが実在しない / 実在する。
    // 「常に null を返す」実装を通さないためには3番目が要る。
    // -------------------------------------------------------------------

    it("get は形式不正な id に対して例外を投げず null を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.get(ctx, "does-not-exist")).resolves.toBeNull();
    });

    it("get は well-formed だが実在しない id に対して null を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.get(ctx, NONEXISTENT_MEMORY_ID)).resolves.toBeNull();
    });

    it("get は実在する id に対して Memory を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      const fetched = await store.get(ctx, memory.id);
      expect(fetched?.id).toBe(memory.id);
    });

    it("getMany は全件が形式不正なら例外を投げず空配列を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.getMany(ctx, ["does-not-exist", "also-not-a-uuid"])).resolves.toEqual([]);
    });

    it("getMany は well-formed だが実在しない id に対して空配列を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.getMany(ctx, [NONEXISTENT_MEMORY_ID])).resolves.toEqual([]);
    });

    it("getMany は実在する id と形式不正な id が混ざっていても、実在するほうだけを返す（形式不正なほうは静かに落ちる）", async () => {
      // ⟹ 「全部弾く」実装と「全部返す」実装の両方をこの1つで落とす。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      const result = await store.getMany(ctx, [memory.id, "does-not-exist"]);
      expect(result.map((m) => m.id)).toEqual([memory.id]);
    });

    // -------------------------------------------------------------------
    // getObservation / createObservationWithOutbox（roadmap.md 段階3・transactional outbox）
    // -------------------------------------------------------------------

    it("getObservation は作成済みの Observation を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const created = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const fetched = await store.getObservation(ctx, created.id);
      expect(fetched?.id).toBe(created.id);
    });

    it("getObservation は存在しない id に対して null を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      expect(await store.getObservation(ctx, "does-not-exist")).toBeNull();
    });

    it("getObservation はクロステナントで null を返す", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const created = await store.createObservation(
        ctxA,
        buildNewObservationFixture({ tenantId: "tenant-a" }),
      );
      expect(await store.getObservation(ctxB, created.id)).toBeNull();
    });

    it("createObservationWithOutbox は新規作成時に created: true と、jobKinds ぶんの job を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const { observation, created, jobs } = await store.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1", externalId: "ext-outbox-1" }),
        ["extract"],
      );
      expect(created).toBe(true);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.kind).toBe("extract");
      expect(jobs[0]?.payload.observationId).toBe(observation.id);
      expect(jobs[0]?.tenantId).toBe("tenant-1");
    });

    it("createObservationWithOutbox は冪等な再送で created: false・jobs: [] を返す（重複ジョブを積まない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const input = buildNewObservationFixture({
        tenantId: "tenant-1",
        externalId: "ext-outbox-2",
      });

      const first = await store.createObservationWithOutbox(ctx, input, ["extract"]);
      expect(first.created).toBe(true);

      const second = await store.createObservationWithOutbox(ctx, input, ["extract"]);
      expect(second.created).toBe(false);
      expect(second.jobs).toEqual([]);
      expect(second.observation.id).toBe(first.observation.id);
    });

    /**
     * ADR 0054: `created` は、**この呼び出し自身が行を作ったか**を表す。
     *
     * 上の「冪等な再送」の歯は逐次に2回呼ぶだけなので、`created` を「呼び出しの前後で
     * store 全体の件数が増えたか」という**大域の差分**から導いている実装でも通ってしまう
     * ——逐次実行では、差分を測っている区間に他の書き込みが入らないからである。
     *
     * この歯は、その区間に**別の行の作成**を重ねる。既に存在する外部 id への再送（`dup`）と、
     * 全く新しい外部 id の作成（`fresh`）を同時に走らせると、大域の件数は `fresh` のぶん
     * だけ増える。`dup` はその増加を自分の挿入と取り違えてはならない。
     *
     * **フィクスチャは非対称にしてある**——`dup` と `fresh` は別の外部 id・別の行であり、
     * 期待値も `created`/`jobs` の両方で食い違う。件数だけを測ると「2件のうち1件が
     * created」という和が合ってしまう変異を見逃すため、**どのジョブがどの observation を
     * 指しているか**まで assert する。
     */
    it("createObservationWithOutbox は、別の行の作成が同時に起きても created を取り違えない（ADR 0054）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const dupInput = buildNewObservationFixture({
        tenantId: "tenant-1",
        externalId: "ext-adr54-existing",
      });

      const seed = await store.createObservationWithOutbox(ctx, dupInput, ["extract"]);
      expect(seed.created).toBe(true);

      const [dup, fresh] = await Promise.all([
        store.createObservationWithOutbox(ctx, dupInput, ["extract"]),
        store.createObservationWithOutbox(
          ctx,
          buildNewObservationFixture({ tenantId: "tenant-1", externalId: "ext-adr54-fresh" }),
          ["extract"],
        ),
      ]);

      expect({
        dupCreated: dup.created,
        dupJobs: dup.jobs.length,
        dupIsSeedRow: dup.observation.id === seed.observation.id,
        freshCreated: fresh.created,
        freshJobTargets: fresh.jobs.map((job) => job.payload.observationId),
        freshIsDistinctRow: fresh.observation.id !== seed.observation.id,
      }).toEqual({
        dupCreated: false,
        dupJobs: 0,
        dupIsSeedRow: true,
        freshCreated: true,
        freshJobTargets: [fresh.observation.id],
        freshIsDistinctRow: true,
      });
    });

    /**
     * ADR 0054 の不変条件のうち、**「判定と挿入の間に `await` を挟まない」側**を測る歯。
     *
     * 上の歯（別の行の同時作成）は「`created` を大域の件数差から導く」壊れ方を捕まえるが、
     * **判定と挿入の間に `await` 境界を入れる**壊れ方は捕まえない——鍵が違えば、
     * 事前の存在検査でも答えが合ってしまうからである。
     *
     * こちらは**同じ冪等キーを同時に2回**作らせる。判定と挿入が1つの同期区間に
     * 閉じていなければ、両方が「存在しない」を見てから両方が挿入・両方が `created: true` を
     * 返し、**同じ observation に対して `extract` ジョブが2件積まれる**（= LLM が2回叩かれる）。
     *
     * ⚠ どちらの呼び出しが作成側になるかは契約が決めていない。だから
     * **「片方だけが `created`」という非対称そのもの**を assert する（個々の呼び出しの
     * `created` を固定値と比べない）。ジョブの総数と宛先も併せて見る——件数だけだと
     * 「2件のうち1件が created」の和が合う変異を見逃す。
     */
    it("createObservationWithOutbox は、同じ冪等キーを同時に作っても created を1回しか返さない（ADR 0054）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const input = buildNewObservationFixture({
        tenantId: "tenant-1",
        externalId: "ext-adr54-race",
      });

      const [a, b] = await Promise.all([
        store.createObservationWithOutbox(ctx, input, ["extract"]),
        store.createObservationWithOutbox(ctx, input, ["extract"]),
      ]);

      const allJobs = [...a.jobs, ...b.jobs];
      expect({
        createdCount: [a.created, b.created].filter(Boolean).length,
        sameRow: a.observation.id === b.observation.id,
        totalJobs: allJobs.length,
        jobTargets: [...new Set(allJobs.map((job) => job.payload.observationId))],
        rowIsReadable: (await store.getObservation(ctx, a.observation.id))?.id,
      }).toEqual({
        createdCount: 1,
        sameRow: true,
        totalJobs: 1,
        jobTargets: [a.observation.id],
        rowIsReadable: a.observation.id,
      });
    });

    it("createObservationWithOutbox は jobKinds が空なら job を作らない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const { created, jobs } = await store.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
        [],
      );
      expect(created).toBe(true);
      expect(jobs).toEqual([]);
    });

    // -------------------------------------------------------------------
    // createMemory の冪等性（docs/architecture.md §3.5、§5.1）
    // -------------------------------------------------------------------

    it("createMemory は同じ抽出キーに対して冪等である（重複を作らない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const observation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const input = buildNewMemoryFixture({
        tenantId: "tenant-1",
        sourceObservationId: observation.id,
        extractorVersion: "v1",
        contentHash: "same-hash",
      });

      const first = await store.createMemory(ctx, input);
      const second = await store.createMemory(ctx, {
        ...input,
        content: "違う本文（無視され、first の内容が正になるべき）",
      });

      expect(second.id).toBe(first.id);
      expect(second.content).toBe(first.content);
    });

    it("createMemory は sourceObservationId/contentHash が異なれば別の Memory を作る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const observationA = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const observationB = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const first = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: observationA.id,
          extractorVersion: "v1",
          contentHash: "hash-1",
        }),
      );
      const second = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: observationB.id,
          extractorVersion: "v1",
          contentHash: "hash-2",
        }),
      );

      expect(second.id).not.toBe(first.id);
    });

    it("createMemory は extractorVersion が null でも冪等である（同じ Observation・同じ contentHash で重複を作らない）", async () => {
      // docs/memory-model.md §10 の一意制約は
      //   (tenant_id, source_observation_id, extractor_version, content_hash)
      //   WHERE source_observation_id IS NOT NULL
      // だが、Postgres は既定で NULL 同士を「異なる値」として扱うため、
      // extractor_version が NULL だと**この一意制約が発火しない**。
      // 実測（PG18.6）: extractor_version = NULL で同じ行を2回入れると2行できた。
      // roadmap.md 段階3 の完了条件「同じ Observation を二重に送っても Memory が
      // 重複して作られない」が、この経路だけ静かに崩れる。
      // インメモリ実装は JS の文字列キーで null を "" に潰すため**偶然に**冪等であり、
      // この分岐を検査しない限り両実装の食い違いは見えない。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const observation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const input = buildNewMemoryFixture({
        tenantId: "tenant-1",
        sourceObservationId: observation.id,
        extractorVersion: null,
        contentHash: "hash-null-extractor",
      });

      const first = await store.createMemory(ctx, input);
      const second = await store.createMemory(ctx, input);

      expect(second.id).toBe(first.id);
    });

    it("createMemory は sourceObservationId が無い場合、同じ contentHash でも常に新しい Memory を作る（一意制約の対象外）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const input = buildNewMemoryFixture({
        tenantId: "tenant-1",
        sourceObservationId: null,
        extractorVersion: null,
        contentHash: "same-hash-no-source",
        provenance: { kind: "imported", batchId: "batch-1" },
      });

      const first = await store.createMemory(ctx, input);
      const second = await store.createMemory(ctx, input);

      expect(second.id).not.toBe(first.id);
    });

    // -------------------------------------------------------------------
    // validFrom/validUntil（Issue #202、ADR 0145）
    // -------------------------------------------------------------------

    it("createMemory は validFrom/validUntil を書き込み、読み戻す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const validFrom = new Date("2025-01-01T00:00:00.000Z");
      const validUntil = new Date("2025-12-31T23:59:59.000Z");

      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", validFrom, validUntil }),
      );
      expect(created.validFrom?.getTime()).toBe(validFrom.getTime());
      expect(created.validUntil?.getTime()).toBe(validUntil.getTime());

      const reread = await store.get(ctx, created.id);
      expect(reread?.validFrom?.getTime()).toBe(validFrom.getTime());
      expect(reread?.validUntil?.getTime()).toBe(validUntil.getTime());
    });

    it("createMemory は validFrom/validUntil を省略すると null のまま保存・返却する（非破壊の既定値）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1" }),
      );
      expect(created.validFrom ?? null).toBeNull();
      expect(created.validUntil ?? null).toBeNull();

      const reread = await store.get(ctx, created.id);
      expect(reread?.validFrom ?? null).toBeNull();
      expect(reread?.validUntil ?? null).toBeNull();
    });

    it("createMemory は occurredAt と validFrom/validUntil を混同しない — 3つに別々の値を渡すと、別々に返る（Issue #202 受け入れ条件2）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const occurredAt = new Date("2024-06-01T00:00:00.000Z");
      const validFrom = new Date("2025-01-01T00:00:00.000Z");
      const validUntil = new Date("2025-12-31T23:59:59.000Z");

      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", occurredAt, validFrom, validUntil }),
      );

      // ⚠ 3つとも異なる値であり、どの2つも取り違えていないことを個別に確かめる。
      // `occurredAt` を `validFrom`/`validUntil` へエイリアスするような実装の誤りは、
      // この歯でだけ検出できる（round-trip だけを見る歯は、同じ値を書けば通ってしまう）。
      expect(created.occurredAt?.getTime()).toBe(occurredAt.getTime());
      expect(created.validFrom?.getTime()).toBe(validFrom.getTime());
      expect(created.validUntil?.getTime()).toBe(validUntil.getTime());
      expect(created.occurredAt?.getTime()).not.toBe(created.validFrom?.getTime());
      expect(created.validFrom?.getTime()).not.toBe(created.validUntil?.getTime());

      const reread = await store.get(ctx, created.id);
      expect(reread?.occurredAt?.getTime()).toBe(occurredAt.getTime());
      expect(reread?.validFrom?.getTime()).toBe(validFrom.getTime());
      expect(reread?.validUntil?.getTime()).toBe(validUntil.getTime());
    });

    // -------------------------------------------------------------------
    // decayBaseSeq/decayFloorSeq/halfLifeRecalls（活動時計の3つ組、
    // [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと3、
    // Issue #305）
    //
    // ⚠ **この3本は「前任の作業者が実際に踏んだ漏れ1」を直接検出するために置く**
    // （`InMemoryMemoryStore.createMemoryIdempotent`（`packages/testkit/src/__fixtures__/
    // in-memory-memory-store.ts`）が `decayBaseSeq`/`decayFloorSeq`/`halfLifeRecalls` を
    // 一切転記せず、型が optional なので TypeScript が黙って通してしまっていた）。
    // `validFrom`/`validUntil` の歯と同じ形（round-trip・省略時の既定値・他フィールドとの
    // 取り違え検出）をここでも置く。
    // -------------------------------------------------------------------

    it("createMemory は decayBaseSeq/decayFloorSeq/halfLifeRecalls を書き込み、読み戻す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          decayBaseSeq: 10,
          decayFloorSeq: 500,
          halfLifeRecalls: 360,
        }),
      );
      expect(created.decayBaseSeq).toBe(10);
      expect(created.decayFloorSeq).toBe(500);
      expect(created.halfLifeRecalls).toBe(360);

      const reread = await store.get(ctx, created.id);
      expect(reread?.decayBaseSeq).toBe(10);
      expect(reread?.decayFloorSeq).toBe(500);
      expect(reread?.halfLifeRecalls).toBe(360);
    });

    it("createMemory は decayBaseSeq/decayFloorSeq/halfLifeRecalls を省略すると null のまま保存・返却する（ADR 0165 決めたこと4）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1" }),
      );
      expect(created.decayBaseSeq ?? null).toBeNull();
      expect(created.decayFloorSeq ?? null).toBeNull();
      expect(created.halfLifeRecalls ?? null).toBeNull();

      const reread = await store.get(ctx, created.id);
      expect(reread?.decayBaseSeq ?? null).toBeNull();
      expect(reread?.decayFloorSeq ?? null).toBeNull();
      expect(reread?.halfLifeRecalls ?? null).toBeNull();
    });

    it("createMemory は decayBaseSeq/decayFloorSeq と壁時計の halfLifeHours/decayFloorAt を混同しない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const decayFloorAt = new Date("2026-06-01T00:00:00.000Z");

      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          halfLifeHours: 720,
          decayFloorAt,
          decayBaseSeq: 0,
          decayFloorSeq: 1000,
          halfLifeRecalls: 360,
        }),
      );

      // ⚠ 単位の違う4つの数値（720 / 1000 / 0 / 360）を混同していないことを個別に見る
      // ——`validFrom`/`validUntil` の歯と同じ理由（round-trip だけでは、フィールドを
      // 取り違えて代入していても「同じ値を書けば通ってしまう」ケースを見逃す）。
      expect(created.halfLifeHours).toBe(720);
      expect(created.decayFloorAt.getTime()).toBe(decayFloorAt.getTime());
      expect(created.decayBaseSeq).toBe(0);
      expect(created.decayFloorSeq).toBe(1000);
      expect(created.halfLifeRecalls).toBe(360);
    });

    // -------------------------------------------------------------------
    // listBySourceObservation（ADR 0028・runtime.reextract の前提）
    // -------------------------------------------------------------------

    it("listBySourceObservation は同じ Observation・同じ extractorVersion の Memory を列挙する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const observation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const a = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: observation.id,
          extractorVersion: "v1",
          contentHash: "hash-list-a",
        }),
      );
      const b = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: observation.id,
          extractorVersion: "v1",
          contentHash: "hash-list-b",
        }),
      );
      // 別の Observation・別の extractorVersion の Memory は混ざってはならない。
      const otherObservation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: otherObservation.id,
          extractorVersion: "v1",
          contentHash: "hash-list-other-observation",
        }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: observation.id,
          extractorVersion: "v2",
          contentHash: "hash-list-other-version",
        }),
      );

      const listed = await store.listBySourceObservation(ctx, observation.id, "v1");
      expect(listed.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    });

    it("listBySourceObservation はクロステナントの Memory を返さない（テナント分離）", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const observationA = await store.createObservation(
        ctxA,
        buildNewObservationFixture({ tenantId: "tenant-a" }),
      );
      await store.createMemory(
        ctxA,
        buildNewMemoryFixture({
          tenantId: "tenant-a",
          sourceObservationId: observationA.id,
          extractorVersion: "v1",
          contentHash: "hash-tenant-a",
        }),
      );

      // tenant-b からは同じ observationId を渡しても何も見えない
      // （観測そのものがテナント分離されている前提と一貫させる）。
      const listedFromB = await store.listBySourceObservation(ctxB, observationA.id, "v1");
      expect(listedFromB).toEqual([]);

      const listedFromA = await store.listBySourceObservation(ctxA, observationA.id, "v1");
      expect(listedFromA).toHaveLength(1);
    });

    it("listBySourceObservation は形式不正な observationId に対して例外を投げず空配列を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.listBySourceObservation(ctx, "does-not-exist", "v1")).resolves.toEqual([]);
    });

    it("listBySourceObservation は well-formed だが実在しない observationId に対して空配列を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.listBySourceObservation(ctx, randomUUID(), "v1")).resolves.toEqual([]);
    });

    // -------------------------------------------------------------------
    // createMemoryWithOutbox（roadmap.md 段階3・transactional outbox）
    // -------------------------------------------------------------------

    it("createMemoryWithOutbox は新規作成時に created: true と、jobKinds ぶんの job を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const { memory, created, jobs } = await store.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "hash-outbox-1" }),
        ["embed"],
      );
      expect(created).toBe(true);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.kind).toBe("embed");
      expect(jobs[0]?.payload.memoryId).toBe(memory.id);
    });

    it("createMemoryWithOutbox は抽出の冪等キーに衝突したら created: false・jobs: [] を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const observation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const input = buildNewMemoryFixture({
        tenantId: "tenant-1",
        sourceObservationId: observation.id,
        extractorVersion: "v1",
        contentHash: "hash-outbox-2",
      });

      const first = await store.createMemoryWithOutbox(ctx, input, ["embed"]);
      expect(first.created).toBe(true);

      const second = await store.createMemoryWithOutbox(ctx, input, ["embed"]);
      expect(second.created).toBe(false);
      expect(second.jobs).toEqual([]);
      expect(second.memory.id).toBe(first.memory.id);
    });

    /**
     * ADR 0054: `createMemoryWithOutbox` 側の同じ契約。上の
     * `createObservationWithOutbox` の歯と同じ理由・同じ形（そちらの doc を参照）。
     * こちらは冪等キーが `(sourceObservationId, extractorVersion, contentHash)` なので、
     * **同じ observation に紐づく別の contentHash** を同時に作ることで大域の件数を動かす。
     */
    it("createMemoryWithOutbox は、別の行の作成が同時に起きても created を取り違えない（ADR 0054）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const observation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const dupInput = buildNewMemoryFixture({
        tenantId: "tenant-1",
        sourceObservationId: observation.id,
        extractorVersion: "v1",
        contentHash: "hash-adr54-existing",
      });

      const seed = await store.createMemoryWithOutbox(ctx, dupInput, ["embed"]);
      expect(seed.created).toBe(true);

      const [dup, fresh] = await Promise.all([
        store.createMemoryWithOutbox(ctx, dupInput, ["embed"]),
        store.createMemoryWithOutbox(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            sourceObservationId: observation.id,
            extractorVersion: "v1",
            contentHash: "hash-adr54-fresh",
          }),
          ["embed"],
        ),
      ]);

      expect({
        dupCreated: dup.created,
        dupJobs: dup.jobs.length,
        dupIsSeedRow: dup.memory.id === seed.memory.id,
        freshCreated: fresh.created,
        freshJobTargets: fresh.jobs.map((job) => job.payload.memoryId),
        freshIsDistinctRow: fresh.memory.id !== seed.memory.id,
      }).toEqual({
        dupCreated: false,
        dupJobs: 0,
        dupIsSeedRow: true,
        freshCreated: true,
        freshJobTargets: [fresh.memory.id],
        freshIsDistinctRow: true,
      });
    });

    /**
     * ADR 0054: `createMemoryWithOutbox` 側の、同じ冪等キーの同時作成
     * （上の `createObservationWithOutbox` の歯と同じ理由・同じ形。そちらの doc を参照）。
     * こちらの冪等キーは `(sourceObservationId, extractorVersion, contentHash)` である。
     * 2回積まれれば **同じ記憶に対して `embed` ジョブが重複する**（埋め込み API が2回叩かれる）。
     */
    it("createMemoryWithOutbox は、同じ冪等キーを同時に作っても created を1回しか返さない（ADR 0054）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const observation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const input = buildNewMemoryFixture({
        tenantId: "tenant-1",
        sourceObservationId: observation.id,
        extractorVersion: "v1",
        contentHash: "hash-adr54-race",
      });

      const [a, b] = await Promise.all([
        store.createMemoryWithOutbox(ctx, input, ["embed"]),
        store.createMemoryWithOutbox(ctx, input, ["embed"]),
      ]);

      const allJobs = [...a.jobs, ...b.jobs];
      expect({
        createdCount: [a.created, b.created].filter(Boolean).length,
        sameRow: a.memory.id === b.memory.id,
        totalJobs: allJobs.length,
        jobTargets: [...new Set(allJobs.map((job) => job.payload.memoryId))],
        rowIsReadable: (await store.get(ctx, a.memory.id))?.id,
      }).toEqual({
        createdCount: 1,
        sameRow: true,
        totalJobs: 1,
        jobTargets: [a.memory.id],
        rowIsReadable: a.memory.id,
      });
    });

    // -------------------------------------------------------------------
    // setEmbeddingStatus（roadmap.md 段階3の完了条件: pending → ready | failed）
    // -------------------------------------------------------------------

    it("setEmbeddingStatus は embeddingStatus を 'ready' に遷移させる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", embeddingStatus: "pending" }),
      );
      expect(memory.embeddingStatus).toBe("pending");

      const updated = await store.setEmbeddingStatus(ctx, memory.id, "ready");
      expect(updated.embeddingStatus).toBe("ready");
    });

    it("setEmbeddingStatus は embeddingStatus を 'failed' にも遷移させる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));

      const updated = await store.setEmbeddingStatus(ctx, memory.id, "failed");
      expect(updated.embeddingStatus).toBe("failed");
    });

    it("setEmbeddingStatus は存在しない Memory に対して失敗する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // UUID の形をした id を渡す必要がある（NONEXISTENT_MEMORY_ID 定義参照）。
      // メッセージまで固定するのは、ガード節が抜けて null 参照の TypeError に
      // すり替わっても緑のままになる事故を防ぐため（NOT_FOUND_ERROR_MESSAGE 定義参照）。
      await expect(store.setEmbeddingStatus(ctx, NONEXISTENT_MEMORY_ID, "ready")).rejects.toThrow(
        NOT_FOUND_ERROR_MESSAGE,
      );
    });

    // 族B（無い == 例外）だが、mapping.ts の isUuidLike の doc コメントが定める基準
    // 「存在しない」と「壊れた入力」を区別せずに済ませたい口にはここも当たる——
    // 形式不正な id も「対象が無い」と同じ例外（今日と同じ Error）に寄せる。
    // ⚠ 引数無しの `.rejects.toThrow()` は使わない——TypeError やドライバの
    // パースエラーもそのパターンには一致してしまい、意図した「memory not found」の
    // 分岐を検査したことにならない（NOT_FOUND_ERROR_MESSAGE 定義参照）。
    it("setEmbeddingStatus は形式不正な id に対しても『memory not found』と同じ例外を投げる（ドライバのエラーを漏らさない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.setEmbeddingStatus(ctx, "does-not-exist", "ready")).rejects.toThrow(
        NOT_FOUND_ERROR_MESSAGE,
      );
    });

    it("⚠ setEmbeddingStatus は 'ready' を 'failed' へ巻き戻さない（ADR 0053）", async () => {
      // ⚠ `ready` は VectorStore.upsert が返った*後*にしか書かれない＝「ベクトル行が
      // 在る」の主張である。`failed` はリースを失った古いワーカーの catch からも書かれうる
      // （ADR 0032 の at-least-once）。上書きを許すと、ベクトル行が在るのに
      // embedding_status = 'failed' になり、recall が notIndexed.failed に計上して
      // 利用者に「埋め込みを疑え」と出す——それが塞ぐべき壊れ方である。
      //
      // ⚠ **例外を投げないことも歯の一部である。**唯一の `failed` の呼び出し口は
      // runtime.tick の `catch (err) { ...; throw err }` の中であり、そこで投げると
      // 元の埋め込みエラーが握り潰されて別の例外にすり替わる（ADR 0048 の reinforce と
      // 同じ理由の形）。下の `await` がそのまま通ることが、それを固定している。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", embeddingStatus: "pending" }),
      );

      const readied = await store.setEmbeddingStatus(ctx, memory.id, "ready");
      // 前提: 'ready' への遷移は実際に効いている。
      // ⚠ **この行はこの歯の捕獲力を増やしていない**（実測。PR 本文の変異 Mu4b）——
      // 下の `expect(rolledBack.embeddingStatus).toBe("ready")` は*正の*等値比較なので、
      // 実装が丸ごと壊れて何も書かなくなった場合（`pending` のまま）にも、この行が
      // 無くてもそれだけで赤くなる。この行が足しているのは**赤くなる位置**であって、
      // 赤くなるかどうかではない。⟹ 将来この歯を「巻き戻っていない」だけを見る形
      // （`.not.toBe("failed")` など）へ弱めたときに、初めてこの行が唯一の捕獲点になる。
      expect(readied.embeddingStatus).toBe("ready");

      // ⚠ プリミティブへ即座に写し取る。in-memory 実装は Map に入れた行オブジェクトへの
      // 参照をそのまま返すため、`readied`（＝行そのもの）を保持したまま後段で比べると
      // 「別の読み取り」ではなく「同じオブジェクトを2回見ている」だけになり、比較が常に
      // 真になって歯が死ぬ（reinforce の no-op の歯と同じ取り違え）。
      // **実測: この写し取りを `const readyRow = readied` へ置き換えると、`updatedAt` を
      // 触ってしまう変異が生き残る**（PR 本文の変異 Mu6''）。⟹ この行は効いている。
      const readyUpdatedAtMs = readied.updatedAt.getTime();

      // ⚠ `updatedAt` は壁時計（`new Date()`/`now()`）。2回の呼び出しは一瞬で終わるため、
      // ガードが外れて書き込んでしまう実装でもミリ秒の解像度に収まって偶然同じ値に
      // なりかねない。実際に時間を進め、「書けば必ず値が変わる」状況を作ってから
      // 「変わっていない」を確かめる。
      // **実測: この `await` を消すと、`updatedAt` を触ってしまう変異が生き残る**
      // （PR 本文の変異 Mu7）。⟹ この行は効いている。
      await new Promise((resolve) => setTimeout(resolve, 5));

      const rolledBack = await store.setEmbeddingStatus(ctx, memory.id, "failed");
      expect(rolledBack.embeddingStatus).toBe("ready");
      // 行そのものを触っていないことは updatedAt で確かめる。
      expect(rolledBack.updatedAt.getTime()).toBe(readyUpdatedAtMs);

      // 読み直しても同じ（返り値だけを繕う実装を弾く）。
      const reread = await store.get(ctx, memory.id);
      expect(reread?.embeddingStatus).toBe("ready");
      expect(reread?.updatedAt.getTime()).toBe(readyUpdatedAtMs);
    });

    it("setEmbeddingStatus は 'failed' を 'ready' へ進めることは妨げない（片側だけの規則、ADR 0053）", async () => {
      // ⚠ この歯は、規則が**片側だけ**であることを固定するためにある。実装が
      // 「pending 以外からは書かない」や「ready と failed を対称に禁じる」へずれても、
      // 上の歯（'ready' を 'failed' で上書きしない）だけでは緑のままになる。
      // B が後から成功した場合（failed → ready）は正しく反映されなければならない。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", embeddingStatus: "pending" }),
      );

      const failed = await store.setEmbeddingStatus(ctx, memory.id, "failed");
      // 前提: 'failed' への遷移は実際に効いている（上の歯と同じく、捕獲力ではなく
      // 赤くなる位置を足す行である。実測は PR 本文の変異 Mu4b）。
      expect(failed.embeddingStatus).toBe("failed");
      // ⚠ 上の歯と同じ理由でプリミティブへ写し取る（参照を持ち回らない）。
      const failedUpdatedAtMs = failed.updatedAt.getTime();

      await new Promise((resolve) => setTimeout(resolve, 5));

      const readied = await store.setEmbeddingStatus(ctx, memory.id, "ready");
      expect(readied.embeddingStatus).toBe("ready");
      // 行が実際に触られたこと（no-op ではないこと）を updatedAt で確かめる。
      expect(readied.updatedAt.getTime()).toBeGreaterThan(failedUpdatedAtMs);

      // 読み直しても同じ（返り値だけを繕う実装を弾く）。
      const reread = await store.get(ctx, memory.id);
      expect(reread?.embeddingStatus).toBe("ready");
    });

    // -------------------------------------------------------------------
    // recordUsage（D9・docs/architecture.md §3.5「挿入の成否で数える」）
    // -------------------------------------------------------------------

    it("recordUsage は同じ (recallId, memoryId) の再送に対して冪等である（D9）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      const recallId = await prepareRecallId(ctx);

      const first = await store.recordUsage(ctx, recallId, [memory.id]);
      expect(first.insertedMemoryIds).toEqual([memory.id]);

      const second = await store.recordUsage(ctx, recallId, [memory.id]);
      expect(second.insertedMemoryIds).toEqual([]);
    });

    it("recordUsage は複数 memoryId のうち新規に挿入されたものだけを返す（部分的な再送）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryA = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1" }),
      );
      const memoryB = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1" }),
      );
      const recallId = await prepareRecallId(ctx);

      const first = await store.recordUsage(ctx, recallId, [memoryA.id]);
      expect(first.insertedMemoryIds).toEqual([memoryA.id]);

      // memoryA は既に記録済み、memoryB は初めて。新規に挿入されたのは memoryB だけ。
      const second = await store.recordUsage(ctx, recallId, [memoryA.id, memoryB.id]);
      expect(second.insertedMemoryIds).toEqual([memoryB.id]);
    });

    it("recordUsage は空配列に対して何も挿入しない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const recallId = await prepareRecallId(ctx);

      const result = await store.recordUsage(ctx, recallId, []);
      expect(result.insertedMemoryIds).toEqual([]);
    });

    // -------------------------------------------------------------------
    // reinforce（docs/memory-model.md §7、ADR 0010）
    // -------------------------------------------------------------------

    it("reinforce は last_reinforced_at と decay_floor_at を更新する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      const before = memory.decayFloorAt.getTime();

      const reinforcedAt = new Date(memory.recordedAt.getTime() + 1000 * 60 * 60 * 24 * 30);
      const reinforced = await store.reinforce(ctx, memory.id, reinforcedAt);

      expect(reinforced.lastReinforcedAt?.getTime()).toBe(reinforcedAt.getTime());
      expect(reinforced.decayFloorAt.getTime()).not.toBe(before);
    });

    it("⚠ reinforce は strength を動かさない（ADR 0041）", async () => {
      // **「強化」の意味は `last_reinforced_at`（＝減衰の起点が動く）と
      // `decay_floor_at` の再計算に確定している。`strength` は初期値として設定できる欄であり、
      // `reinforce` では動かない。**
      //
      // ⚠ 初期値を **1 ではない値**にしてある。1 のままだと「`strength` を 1 で上書きする」
      // 実装や「`strength` に `decay` を掛ける」実装（1×何かが 1 に見える場合）を
      // この検査が通してしまう。0.42 は他のどの既定値とも一致しない。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const initialStrength = 0.42;
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", strength: initialStrength }),
      );
      expect(memory.strength).toBeCloseTo(initialStrength, 6);

      const reinforcedAt = new Date(memory.recordedAt.getTime() + 1000 * 60 * 60 * 24 * 30);
      const reinforced = await store.reinforce(ctx, memory.id, reinforcedAt);

      // 前提: reinforce 自体は効いている（何も起きていないなら「変わらない」は無意味な緑）。
      expect(reinforced.lastReinforcedAt?.getTime()).toBe(reinforcedAt.getTime());
      // 本題: strength は1ミリも動かない。
      expect(reinforced.strength).toBeCloseTo(initialStrength, 6);

      // 読み直しても同じ（返り値だけを繕う実装を弾く）。
      const reloaded = await store.get(ctx, memory.id);
      expect(reloaded?.strength).toBeCloseTo(initialStrength, 6);
    });

    it("⚠ createMemory は値域の外の strength を拒む（ADR 0078）", async () => {
      // **`strength` は `total = similarity × decay × tagMatch × freshness × strength` に
      // 掛かる係数であり、上限が無いと値を1つ大きく書いた Memory がそのテナントの想起を
      // 支配する**（ADR 0036 が `freshness` で塞いだのと同じ穴）。値域は `(0, 1]`。
      //
      // ⚠ **強制の責任は store の層に在る。**`MemorySchema` / `NewMemorySchema`（zod）は
      // `.parse()` される箇所が0件なので、型を締めても実行時には何も起きない。だから
      // 「adapter が拒むこと」を契約としてここで固定する。
      //
      // ⚠ **境界に float64 の ε を使わない。**`packages/postgres` の `strength` は `real`
      // （float4）で、`1 + Number.EPSILON` は格納時に `1.0` へ丸められて CHECK を通る
      // （実測）。一方 in-memory 実装は float64 で判定するので弾く。**ε を書くと
      // 2つの adapter が食い違い、この検査が「どちらかでしか成立しない」ものになる。**
      // ⟹ 両者が一致する `1.0001` を上限側の境界に使う（float4 でも 1 より大きいまま）。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      const outOfRange: Array<[string, number]> = [
        ["上限をわずかに超える", 1.0001],
        ["1 より大きい", 2],
        ["桁が違う", 1e6],
        ["ちょうど 0", 0],
        ["負", -1],
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
      ];

      // 🔴 **`decayFloorAt` を明示的に上書きする。**`buildNewMemoryFixture` は
      // `defaultDecayStrategy.floorAt()` で `decayFloorAt` を計算するが、`strength` が
      // `NaN` / `Infinity` のとき **`floorAt` は `Invalid Date` を返す**（`NaN` は
      // `strength <= threshold` の比較を素通りするため。実測）。それをそのまま渡すと
      // `packages/postgres` は **`timestamptz` 列のほうで**落ちる:
      //
      //   invalid input syntax for type timestamp with time zone: "0NaN-NaN-..."
      //
      // ⟹ **値域の歯が無くても赤くなる。**それでは「値域を検査した」ことにならないので、
      // ここでは妥当な `decayFloorAt` を与え、**落ちる理由を `strength` だけに絞る。**
      const validFloorAt = new Date("2026-06-01T00:00:00.000Z");

      for (const [label, strength] of outOfRange) {
        await expect(
          store.createMemory(
            ctx,
            buildNewMemoryFixture({ tenantId: "tenant-1", strength, decayFloorAt: validFloorAt }),
          ),
          `strength=${strength}（${label}）は拒まれなければならない`,
        ).rejects.toThrow();
      }

      // 前提: 値域の内側なら通る（「何を渡しても落ちる」実装を弾く）。
      // **上限ちょうど（1）を含める**——`< 1` と書いた実装をここで落とす。
      for (const strength of [1, 0.42, 1e-6]) {
        const memory = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", strength }),
        );
        expect(memory.strength).toBeCloseTo(strength, 6);
      }
    });

    it("⚠ createMemory は値域の外の halfLifeHours を拒む（ADR 0125 / Issue #231）", async () => {
      // **`halfLifeHours` は `decay`/`freshness` の式 `elapsedHours / halfLifeHours` の
      // 分母である。`0`・負・`NaN`・`Infinity` はこの式を壊し、`decay` が `NaN` や
      // `+Infinity` になる**（Issue #231。実測は `isHalfLifeHoursInRange` の doc に
      // 記録した——issue 本文の「`0` で `+Infinity` になる」という記述は不正確で、
      // 実際に `+Infinity` に発散するのは負の `halfLifeHours` のときである。
      // ただしどちらにせよ拒むべき値であることは変わらない）。
      //
      // ⚠ **強制の責任は store の層に在る。**`MemorySchema` / `NewMemorySchema`（zod）の
      // `halfLifeHours: z.number().positive()` は `.parse()` される箇所が0件なので、
      // 型を締めても実行時には何も起きない（ADR 0078 実測3と同じ理由）。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      const outOfRange: Array<[string, number]> = [
        ["ちょうど 0", 0],
        ["負の 0", -0],
        ["負", -1],
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
        ["-Infinity", Number.NEGATIVE_INFINITY],
      ];

      // 🔴 `decayFloorAt` を明示的に上書きする。`buildNewMemoryFixture` は
      // `defaultDecayStrategy.floorAt()` で `decayFloorAt` を計算するが、
      // `halfLifeHours` が `NaN`/`Infinity` のとき `floorAt` は `Invalid Date` を返す
      // （strength 版のテスト（ADR 0078）と同じ形の実測）。それをそのまま渡すと
      // `packages/postgres` は `timestamptz` 列のほうで落ち、「値域の歯が無くても赤く
      // なる」状態になる。ここでは妥当な `decayFloorAt` を与え、落ちる理由を
      // `halfLifeHours` だけに絞る。
      const validFloorAt = new Date("2026-06-01T00:00:00.000Z");

      for (const [label, halfLifeHours] of outOfRange) {
        await expect(
          store.createMemory(
            ctx,
            buildNewMemoryFixture({
              tenantId: "tenant-1",
              halfLifeHours,
              decayFloorAt: validFloorAt,
            }),
          ),
          `halfLifeHours=${halfLifeHours}（${label}）は拒まれなければならない`,
        ).rejects.toThrow();
      }

      // 前提: 値域の内側なら通る（「何を渡しても落ちる」実装を弾く）。
      // 上限は無い（有限であれば大きい値も許す）ことを `1e6` で確かめる。
      for (const halfLifeHours of [720, 1, 1e6]) {
        const memory = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", halfLifeHours }),
        );
        expect(memory.halfLifeHours).toBeCloseTo(halfLifeHours, 6);
      }
    });

    it("reinforce は存在しない Memory に対して失敗する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // UUID の形をした id を渡す必要がある（NONEXISTENT_MEMORY_ID 定義参照）。
      // メッセージまで固定するのは、ガード節が抜けて null 参照の TypeError に
      // すり替わっても緑のままになる事故を防ぐため（NOT_FOUND_ERROR_MESSAGE 定義参照）。
      await expect(store.reinforce(ctx, NONEXISTENT_MEMORY_ID, new Date())).rejects.toThrow(
        NOT_FOUND_ERROR_MESSAGE,
      );
    });

    // mapping.ts の isUuidLike の doc コメントが定める基準に当たる（setEmbeddingStatus と
    // 同じ理由）: 形式不正な id も「対象が無い」と同じ例外に寄せる。
    it("reinforce は形式不正な id に対しても『memory not found』と同じ例外を投げる（ドライバのエラーを漏らさない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.reinforce(ctx, "does-not-exist", new Date())).rejects.toThrow(
        NOT_FOUND_ERROR_MESSAGE,
      );
    });

    // -------------------------------------------------------------------
    // reinforce の単調性（`PostgresMemoryStore` は ADR 0048、in-memory 実装は
    // ADR 0049 でそれに揃えた——古い `at` は減衰の起点を巻き戻さない）
    // -------------------------------------------------------------------

    it("reinforce は減衰の起点を巻き戻さない（ADR 0048/0049）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      const hour = 1000 * 60 * 60;
      const early = new Date(memory.recordedAt.getTime() + hour);
      const late = new Date(memory.recordedAt.getTime() + 48 * hour);

      // 前提: 新しい at で強化すると実際に動く。これを先に固定しないと、reinforce が
      // 丸ごと壊れて何も書かなくなっても「巻き戻らない」だけを見る歯は緑のままになる。
      const forward = await store.reinforce(ctx, memory.id, late);
      expect(forward.lastReinforcedAt?.getTime()).toBe(late.getTime());
      const floorAfterLate = forward.decayFloorAt.getTime();

      // 本題: すでに late で強化済みのところへ、それより古い early を渡しても
      // last_reinforced_at/decay_floor_at は戻らない。
      const backward = await store.reinforce(ctx, memory.id, early);
      expect(backward.lastReinforcedAt?.getTime()).toBe(late.getTime());
      expect(backward.decayFloorAt.getTime()).toBe(floorAfterLate);

      // 読み直しても同じ（返り値だけを繕う実装を弾く）。
      const reread = await store.get(ctx, memory.id);
      expect(reread?.lastReinforcedAt?.getTime()).toBe(late.getTime());
      expect(reread?.decayFloorAt.getTime()).toBe(floorAfterLate);
    });

    it("⚠ reinforce は同じ at をもう一度渡すと no-op である（狭義の `<` の境界、ADR 0048/0049）", async () => {
      // ⚠ ここが `<` と `<=` の境界である。`<=` にすると同じ値を書き直すだけなので、
      // last_reinforced_at と decay_floor_at だけを見ていては区別が付かない
      // （どちらも同じ値になる）。区別が付くのは updated_at だけ——「べき等」を
      // 「同じ値になる」ではなく「行を触らない」の意味で固定する
      // （`packages/postgres/src/__tests__/memory-store-reinforce-monotonicity.test.ts`
      // の同種の歯と同じ形）。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      const hour = 1000 * 60 * 60;
      // 既定値（null）ではない、具体的な起点を先に作ってから境界を検査する。
      const at = new Date(memory.recordedAt.getTime() + 48 * hour);

      const first = await store.reinforce(ctx, memory.id, at);
      // 前提: 1回目は実際に効いている。
      expect(first.lastReinforcedAt?.getTime()).toBe(at.getTime());
      // ⚠ プリミティブへ即座に写し取る。in-memory 実装は Map に入れた行オブジェクトへの
      // 参照をそのまま返すため、`first` を後段の再代入まで保持すると「別の読み取り」では
      // なく「同じオブジェクトを2回見ている」だけになり、比較が常に真になって歯が死ぬ
      // （実際にこの取り違えで変異が生き残ることを確認した上での書き方）。
      const firstDecayFloorAt = first.decayFloorAt.getTime();
      const firstUpdatedAt = first.updatedAt.getTime();

      // ⚠ `updatedAt` は壁時計を使う（`new Date()`/`now()`）。in-memory の2回の呼び出しは
      // 同期的に一瞬で終わるため、ガードが外れて2回目も書き込んでしまう実装であっても、
      // 解像度（ミリ秒）の中に収まって偶然同じ値になりかねない——それでは境界を検査した
      // ことにならない。実際に時間を進めてから2回目を呼び、「書けば必ず値が変わる」
      // 状況を作ってから「変わっていない」を確かめる。
      await new Promise((resolve) => setTimeout(resolve, 5));

      const again = await store.reinforce(ctx, memory.id, at);
      expect(again.lastReinforcedAt?.getTime()).toBe(at.getTime());
      expect(again.decayFloorAt.getTime()).toBe(firstDecayFloorAt);
      // 行そのものを触っていないことは updatedAt で確かめる。
      expect(again.updatedAt.getTime()).toBe(firstUpdatedAt);

      // 読み直しても同じ（返り値だけを繕う実装を弾く）。
      const reread = await store.get(ctx, memory.id);
      expect(reread?.updatedAt.getTime()).toBe(firstUpdatedAt);
    });

    // -------------------------------------------------------------------
    // reinforce と活動時計（`ReinforceOptions.nowSeq`、[ADR 0165]
    // (../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16）
    //
    // ⚠ **この4本は「reinforce に活動時計の『いま』を渡す口が無かった穴」を直接検出する
    // ために置く。**穴が塞がれる前は、強化しても decayBaseSeq/decayFloorSeq が
    // 一切動かなかった（'activity' のテナントでは reinforce が忘却ゲートに対して
    // 完全な no-op になっていた）。
    // -------------------------------------------------------------------

    it("reinforce は opts.nowSeq を渡すと、halfLifeRecalls を持つ Memory の decayBaseSeq/decayFloorSeq を進める（ADR 0165 決めたこと16）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          decayBaseSeq: 0,
          decayFloorSeq: 10,
          halfLifeRecalls: 360,
        }),
      );
      const nowSeq = 1000;
      const at = new Date(memory.recordedAt.getTime() + 1000 * 60 * 60);

      const reinforced = await store.reinforce(ctx, memory.id, at, { nowSeq });

      const expectedDecayFloorSeq = defaultActivityDecayStrategy.floorAt({
        baseSeq: nowSeq,
        strength: memory.strength,
        halfLifeRecalls: memory.halfLifeRecalls!,
      });
      expect(reinforced.decayBaseSeq).toBe(nowSeq);
      expect(reinforced.decayFloorSeq).toBe(expectedDecayFloorSeq);

      // 読み直しても同じ（返り値だけを繕う実装を弾く）。
      const reread = await store.get(ctx, memory.id);
      expect(reread?.decayBaseSeq).toBe(nowSeq);
      expect(reread?.decayFloorSeq).toBe(expectedDecayFloorSeq);
    });

    it("⚠ reinforce は opts.nowSeq を省略すると decayBaseSeq/decayFloorSeq/halfLifeRecalls を据え置く（穴の回帰。黙って 0 として扱わない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          decayBaseSeq: 5,
          decayFloorSeq: 500,
          halfLifeRecalls: 360,
        }),
      );

      // 3引数呼び出し（opts を渡さない。既存の全呼び出しがこの形）。
      const reinforced = await store.reinforce(
        ctx,
        memory.id,
        new Date(memory.recordedAt.getTime() + 1000 * 60 * 60),
      );
      expect(reinforced.decayBaseSeq).toBe(5);
      expect(reinforced.decayFloorSeq).toBe(500);
      expect(reinforced.halfLifeRecalls).toBe(360);

      // opts は渡すが nowSeq だけ省略した場合も同じ——「opts 自体の有無」ではなく
      // 「nowSeq の有無」で分岐することを確かめる。
      const reinforcedAgain = await store.reinforce(
        ctx,
        memory.id,
        new Date(memory.recordedAt.getTime() + 2000 * 60 * 60),
        {},
      );
      expect(reinforcedAgain.decayBaseSeq).toBe(5);
      expect(reinforcedAgain.decayFloorSeq).toBe(500);

      // 読み直しても同じ（返り値だけを繕う実装を弾く）。
      const reread = await store.get(ctx, memory.id);
      expect(reread?.decayBaseSeq).toBe(5);
      expect(reread?.decayFloorSeq).toBe(500);
    });

    it("reinforce は halfLifeRecalls を持たない Memory では opts.nowSeq を渡しても活動時計側に触れない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      // 前提: この Memory はそもそも活動時計を使っていない。
      expect(memory.halfLifeRecalls ?? null).toBeNull();

      const reinforced = await store.reinforce(
        ctx,
        memory.id,
        new Date(memory.recordedAt.getTime() + 1000 * 60 * 60),
        { nowSeq: 1000 },
      );
      expect(reinforced.decayBaseSeq ?? null).toBeNull();
      expect(reinforced.decayFloorSeq ?? null).toBeNull();
      expect(reinforced.halfLifeRecalls ?? null).toBeNull();
    });

    it("reinforce は opts.nowSeq を渡しても、壁時計側（lastReinforcedAt/decayFloorAt）の更新は従来どおり（回帰）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          decayBaseSeq: 0,
          decayFloorSeq: 10,
          halfLifeRecalls: 360,
        }),
      );
      const at = new Date(memory.recordedAt.getTime() + 1000 * 60 * 60);

      const reinforced = await store.reinforce(ctx, memory.id, at, { nowSeq: 1000 });

      const expectedDecayFloorAt = defaultDecayStrategy.floorAt({
        recordedAt: memory.recordedAt,
        lastReinforcedAt: at,
        strength: memory.strength,
        halfLifeHours: memory.halfLifeHours,
      });
      expect(reinforced.lastReinforcedAt?.getTime()).toBe(at.getTime());
      expect(reinforced.decayFloorAt.getTime()).toBe(expectedDecayFloorAt.getTime());
    });

    // -------------------------------------------------------------------
    // updateStatus（docs/memory-model.md §5）
    // -------------------------------------------------------------------

    it("updateStatus は status を更新し、supersededById を任意で設定できる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const oldMemory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1" }),
      );
      const newMemory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1" }),
      );

      const updated = await store.updateStatus(ctx, oldMemory.id, "superseded", {
        supersededById: newMemory.id,
      });

      expect(updated.status).toBe("superseded");
      expect(updated.supersededById).toBe(newMemory.id);
    });

    it("updateStatus は opts を省略すると supersededById を変えない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));

      const updated = await store.updateStatus(ctx, memory.id, "archived");

      expect(updated.status).toBe("archived");
      expect(updated.supersededById ?? null).toBe(memory.supersededById ?? null);
    });

    it("updateStatus は存在しない Memory に対して失敗する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // UUID の形をした id を渡す必要がある（NONEXISTENT_MEMORY_ID 定義参照）。
      // メッセージまで固定するのは、ガード節が抜けて null 参照の TypeError に
      // すり替わっても緑のままになる事故を防ぐため（NOT_FOUND_ERROR_MESSAGE 定義参照）。
      await expect(store.updateStatus(ctx, NONEXISTENT_MEMORY_ID, "archived")).rejects.toThrow(
        NOT_FOUND_ERROR_MESSAGE,
      );
    });

    // mapping.ts の isUuidLike の doc コメントが定める基準に当たる（setEmbeddingStatus と
    // 同じ理由）: 形式不正な id も「対象が無い」と同じ例外に寄せる。
    it("updateStatus は形式不正な id に対しても『memory not found』と同じ例外を投げる（ドライバのエラーを漏らさない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.updateStatus(ctx, "does-not-exist", "archived")).rejects.toThrow(
        NOT_FOUND_ERROR_MESSAGE,
      );
    });

    // -------------------------------------------------------------------
    // updateStatus の expectedStatus（compare-and-swap、ADR 0030・安全弁3）
    // -------------------------------------------------------------------

    it("updateStatus は expectedStatus が現在の status と一致すれば更新する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      expect(memory.status).toBe("active");

      const updated = await store.updateStatus(ctx, memory.id, "superseded", {
        expectedStatus: "active",
      });

      expect(updated.status).toBe("superseded");
    });

    it("updateStatus は expectedStatus が現在の status と不一致なら MemoryStatusConflictError を投げ、行を一切変えない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      await store.updateStatus(ctx, memory.id, "archived"); // 現在の status を archived にしておく

      await expect(
        store.updateStatus(ctx, memory.id, "superseded", { expectedStatus: "active" }),
      ).rejects.toBeInstanceOf(MemoryStatusConflictError);

      // 読み直して、行が一切変わっていないことを確認する（黙って部分的に書かれていない）。
      const unchanged = await store.get(ctx, memory.id);
      expect(unchanged?.status).toBe("archived");
    });

    it("updateStatus は expectedStatus を渡しても、投げる MemoryStatusConflictError の observedStatus に現在の status が入る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      await store.updateStatus(ctx, memory.id, "archived");

      let caught: unknown;
      await store
        .updateStatus(ctx, memory.id, "superseded", { expectedStatus: "active" })
        .catch((error: unknown) => {
          caught = error;
        });

      expect(caught).toBeInstanceOf(MemoryStatusConflictError);
      const conflict = caught as MemoryStatusConflictError;
      expect(conflict.memoryId).toBe(memory.id);
      expect(conflict.expectedStatus).toBe("active");
      expect(conflict.observedStatus).toBe("archived");
    });

    it("updateStatus は expectedStatus を省略すると、今日どおり status に関係なく更新する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      await store.updateStatus(ctx, memory.id, "archived");

      // expectedStatus 無し——現在の status（archived）と違う値を期待していないので通る。
      const updated = await store.updateStatus(ctx, memory.id, "forgotten");
      expect(updated.status).toBe("forgotten");
    });

    it("updateStatus は存在しない id に expectedStatus を渡しても、競合ではなく『対象が無い』の例外になる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      // UUID の形をした id を渡す必要がある（NONEXISTENT_MEMORY_ID 定義参照）。
      // `.rejects.not.toBeInstanceOf(MemoryStatusConflictError)` だけでは
      // 「競合ではない」までしか測れず、ガード節が抜けて null 参照の TypeError に
      // すり替わっても（TypeError も MemoryStatusConflictError ではないので）緑のまま
      // になる。ADR 0030 の主張どおり「競合ではなく『対象が無い』」であることまで
      // 押さえるため、メッセージも NOT_FOUND_ERROR_MESSAGE に固定する。
      const rejection = store.updateStatus(ctx, NONEXISTENT_MEMORY_ID, "superseded", {
        expectedStatus: "active",
      });
      await expect(rejection).rejects.not.toBeInstanceOf(MemoryStatusConflictError);
      await expect(rejection).rejects.toThrow(NOT_FOUND_ERROR_MESSAGE);
    });

    // -------------------------------------------------------------------
    // updateStatusWithEvent（status 更新とイベント追記を同一トランザクションで、ADR 0031）
    //
    // 🔴 守る不変条件: memories.status の更新が永続化されたことと、対応するイベントが
    // 永続化されたことは、同値である。以下の各ケースで「Memory の状態」と「積まれた
    // イベントの数」を必ず並べて assert する——どちらか一方だけを見ると、この不変条件が
    // 崩れていても検査をすり抜けてしまう。
    // -------------------------------------------------------------------

    function buildSupersedeEvent(ctx: Ctx, memoryId: MemoryId, digest: string): NewMemoryEvent {
      return {
        tenantId: ctx.tenantId,
        memoryId,
        kind: "superseded",
        actor: { type: "system" },
        digestSnapshot: digest,
        sizeBeforeBytes: null,
        meta: { reason: "conformance-test" },
      };
    }

    it("updateStatusWithEvent は成功時、Memory を更新し、かつイベントを1件積む", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      expect(memory.status).toBe("active");

      const { memory: updated, event } = await store.updateStatusWithEvent(
        ctx,
        memory.id,
        "superseded",
        { expectedStatus: "active" },
        buildSupersedeEvent(ctx, memory.id, memory.digest),
      );

      expect(updated.status).toBe("superseded");
      expect(event.kind).toBe("superseded");
      expect(event.memoryId).toBe(memory.id);

      const events = await listEventsForMemory(ctx, memory.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("superseded");
    });

    it("updateStatusWithEvent は CAS に弾かれたら MemoryStatusConflictError を投げ、Memory は一切変わらず、イベントも1件も積まれない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      await store.updateStatus(ctx, memory.id, "archived"); // 現在の status を archived にしておく

      await expect(
        store.updateStatusWithEvent(
          ctx,
          memory.id,
          "superseded",
          { expectedStatus: "active" },
          buildSupersedeEvent(ctx, memory.id, memory.digest),
        ),
      ).rejects.toBeInstanceOf(MemoryStatusConflictError);

      // 行が一切変わっていない（黙って部分的に書かれていない）。
      const unchanged = await store.get(ctx, memory.id);
      expect(unchanged?.status).toBe("archived");

      // イベントも1件も積まれていない。
      const events = await listEventsForMemory(ctx, memory.id);
      expect(events).toEqual([]);
    });

    it("updateStatusWithEvent は対象が無ければ『memory not found』の例外を投げ、イベントも積まれない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // 別 PR が直した既存の "does-not-exist" 検査とは別に、well-formed だが実在しない
      // UUID を使う（`randomUUID()`）——`.rejects.toThrow()` を引数無しで使うと TypeError
      // でも通ってしまうため、メッセージまで固定する。
      const missingId = randomUUID();

      await expect(
        store.updateStatusWithEvent(
          ctx,
          missingId,
          "superseded",
          {},
          buildSupersedeEvent(ctx, missingId, "digest"),
        ),
      ).rejects.toThrow(/memory not found for tenant/);

      const events = await listEventsForMemory(ctx, missingId);
      expect(events).toEqual([]);
    });

    // mapping.ts の isUuidLike の doc コメントが定める基準に当たる（他の族B口と
    // 同じ理由）: 形式不正な id も「対象が無い」と同じ例外に寄せる。
    // 🔴 例外が飛ぶだけでなく、イベントが1件も積まれていないことまで見る——
    // ガードをトランザクションの外に置いても中に置いても結果（イベント0件）は
    // 同じだが、`listEventsForMemory` を使わないと「例外は正しいメッセージだが
    // 実は先に1件書き込んでからロールバックし損ねている」ような事故を見逃す。
    it("updateStatusWithEvent は形式不正な id に対しても『memory not found』と同じ例外を投げ、イベントも積まれない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const malformedId = "does-not-exist";

      await expect(
        store.updateStatusWithEvent(
          ctx,
          malformedId,
          "superseded",
          {},
          buildSupersedeEvent(ctx, malformedId, "digest"),
        ),
      ).rejects.toThrow(NOT_FOUND_ERROR_MESSAGE);

      const events = await listEventsForMemory(ctx, malformedId);
      expect(events).toEqual([]);
    });

    it("updateStatusWithEvent は expectedStatus を省略すると、今日の updateStatus どおり無条件に更新し、イベントも積む", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      await store.updateStatus(ctx, memory.id, "archived");

      const { memory: updated } = await store.updateStatusWithEvent(
        ctx,
        memory.id,
        "forgotten",
        {},
        {
          tenantId: ctx.tenantId,
          memoryId: memory.id,
          kind: "forgotten",
          actor: { type: "human" },
          digestSnapshot: memory.digest,
          sizeBeforeBytes: null,
          meta: {},
        },
      );

      expect(updated.status).toBe("forgotten");
      const events = await listEventsForMemory(ctx, memory.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("forgotten");
    });

    // -------------------------------------------------------------------
    // supersedeWithNewMemories（news の作成と supersede を1トランザクションで、
    // Issue #134 / ADR 0100）。docs/memory-model.md §11 行5 が要求する「旧行の status 更新と
    // 新 Memory の作成は1トランザクションで完結させる」の、`updateStatusWithEvent`
    // （ADR 0031）が範囲外にしていた後半を埋める。🔴 任意メソッド——`supportsSupersede-
    // WithNewMemories` が false の adapter では、メソッドそのものが存在しないことだけを
    // 検査する。
    // -------------------------------------------------------------------

    if (supportsSupersedeWithNewMemories) {
      it("supersedeWithNewMemories は news を作り（3件）、created を news と同じ順序で返し、supersededByIndex が指す行へ寄せる", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const oldA = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "old-a" }),
        );
        const oldB = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "old-b" }),
        );

        // 🔴 news は**3件**でなければならない（ADR 0100 の穴①）。`created[i]` が `news[i]` に
        // 対応していることは型が何も保証しておらず、並びがずれると `superseded_by_id` に
        // 別の記憶の id が書かれたまま検査が緑で通る。1件では順序という概念が無く、2件では
        // 「逆順にする」変異が「入れ替える」変異と区別できない——3件にして、かつ
        // **異なる索引（0 と 2）へ寄せる**ことで、並びの取り違えを一意に捕まえる。
        const result = await store.supersedeWithNewMemories!(
          ctx,
          [
            {
              input: buildNewMemoryFixture({
                tenantId: "tenant-1",
                content: "news-1 の本文",
                contentHash: "news-1",
              }),
              jobKinds: ["embed"],
            },
            {
              input: buildNewMemoryFixture({
                tenantId: "tenant-1",
                content: "news-2 の本文",
                contentHash: "news-2",
              }),
              jobKinds: [],
            },
            {
              input: buildNewMemoryFixture({
                tenantId: "tenant-1",
                content: "news-3 の本文",
                contentHash: "news-3",
              }),
              jobKinds: [],
            },
          ],
          [
            {
              id: oldA.id,
              supersededByIndex: 0,
              expectedStatus: "active",
              event: buildSupersedeEvent(ctx, oldA.id, oldA.digest),
            },
            {
              id: oldB.id,
              supersededByIndex: 2,
              expectedStatus: "active",
              event: buildSupersedeEvent(ctx, oldB.id, oldB.digest),
            },
          ],
        );

        // 🔴 穴①: `created` は `news` と同じ順序・同じ長さで返る。
        expect(result.created).toHaveLength(3);
        expect(result.created.map((c) => c.memory.contentHash)).toEqual([
          "news-1",
          "news-2",
          "news-3",
        ]);
        expect(result.created.map((c) => c.memory.content)).toEqual([
          "news-1 の本文",
          "news-2 の本文",
          "news-3 の本文",
        ]);
        expect(result.created.every((c) => c.created)).toBe(true);
        expect(result.created[0]?.jobs).toHaveLength(1);
        expect(result.created[1]?.jobs).toHaveLength(0);
        expect(result.created[2]?.jobs).toHaveLength(0);

        // 索引 0 と 2 が別の行を指していること自体を固定する——さもないと下の2つの
        // assertion が「同じ id を2回見ている」だけになり、並びの取り違えを見逃す。
        const anchor0 = result.created[0]!.memory.id;
        const anchor2 = result.created[2]!.memory.id;
        expect(anchor0).not.toBe(anchor2);

        expect(result.conflicted).toEqual([]);
        expect(result.superseded).toHaveLength(2);

        const updatedA = await store.get(ctx, oldA.id);
        const updatedB = await store.get(ctx, oldB.id);
        expect(updatedA?.status).toBe("superseded");
        expect(updatedA?.supersededById).toBe(anchor0);
        expect(updatedB?.status).toBe("superseded");
        expect(updatedB?.supersededById).toBe(anchor2);

        expect(await listEventsForMemory(ctx, oldA.id)).toHaveLength(1);
        expect(await listEventsForMemory(ctx, oldB.id)).toHaveLength(1);
      });

      it("supersedeWithNewMemories は CAS に弾かれた対象を conflicted に積み、他の news/supersede は commit される", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const oldOk = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "old-ok" }),
        );
        const oldConflicted = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "old-conflicted" }),
        );
        await store.updateStatus(ctx, oldConflicted.id, "archived");
        // ⚠ ここは**リテラルで書く**。`oldConflicted.status` を読んで期待値にしてはいけない
        // ——in-memory は Map の行の参照をそのまま返すので `updateStatus` の後に読むと
        // `"archived"` に見えるが、postgres は切り離された行を返すので `"active"` のまま
        // であり、**同じ式が adapter ごとに別の期待値になる**（CI の postgres ジョブで
        // 実際に落ちた: `expected 'archived' to be 'active'`）。
        // 「CAS に弾かれた対象は一切変わっていない」の正しい期待値は、直前に自分で書いた
        // `"archived"` そのものである。
        const observedBeforeStatus = "archived";

        const result = await store.supersedeWithNewMemories!(
          ctx,
          [
            {
              input: buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "news-conflict" }),
              jobKinds: [],
            },
          ],
          [
            {
              id: oldOk.id,
              supersededByIndex: 0,
              expectedStatus: "active",
              event: buildSupersedeEvent(ctx, oldOk.id, oldOk.digest),
            },
            {
              id: oldConflicted.id,
              supersededByIndex: 0,
              expectedStatus: "active",
              event: buildSupersedeEvent(ctx, oldConflicted.id, oldConflicted.digest),
            },
          ],
        );

        // CAS に弾かれた対象は conflicted に積まれる——例外にはならない。
        expect(result.conflicted).toEqual([{ id: oldConflicted.id, observedStatus: "archived" }]);
        // 他の news・supersede は commit される。
        expect(result.created).toHaveLength(1);
        expect(result.created[0]?.created).toBe(true);
        expect(result.superseded).toHaveLength(1);

        const updatedOk = await store.get(ctx, oldOk.id);
        expect(updatedOk?.status).toBe("superseded");
        expect(updatedOk?.supersededById).toBe(result.created[0]!.memory.id);

        // 弾かれた対象は一切変わっていない（プリミティブに写し取った値と比較する）。
        const stillConflicted = await store.get(ctx, oldConflicted.id);
        expect(stillConflicted?.status).toBe(observedBeforeStatus);
        expect(await listEventsForMemory(ctx, oldConflicted.id)).toEqual([]);
      });

      it("supersedeWithNewMemories は supersede 対象がそもそも存在しなければ throw し、news の作成も含めてロールバックする", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const missingId = randomUUID();
        const observation = await store.createObservation(
          ctx,
          buildNewObservationFixture({ tenantId: "tenant-1" }),
        );
        const newsInput = buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: observation.id,
          extractorVersion: "conformance-supersede-with-new-memories-v1",
          contentHash: "rollback-check-not-found",
        });

        await expect(
          store.supersedeWithNewMemories!(
            ctx,
            [{ input: newsInput, jobKinds: [] }],
            [
              {
                id: missingId,
                supersededByIndex: 0,
                expectedStatus: "active",
                event: buildSupersedeEvent(ctx, missingId, "digest"),
              },
            ],
          ),
        ).rejects.toThrow(NOT_FOUND_ERROR_MESSAGE);

        // news が本当にロールバックされたことの確認: 同じ冪等キーでもう一度
        // createMemoryWithOutbox を呼ぶと、ロールバックされていれば新規作成
        // （created: true）になる。ロールバックされていなければ既存行に衝突して
        // created: false になる。
        const { created } = await store.createMemoryWithOutbox(ctx, newsInput, []);
        expect(created).toBe(true);
      });

      it("supersedeWithNewMemories は範囲外の supersededByIndex を RangeError で落とし、news の作成もロールバックする", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const oldA = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "old-a-range" }),
        );
        const observation = await store.createObservation(
          ctx,
          buildNewObservationFixture({ tenantId: "tenant-1" }),
        );
        const newsInput = buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: observation.id,
          extractorVersion: "conformance-supersede-with-new-memories-v1",
          contentHash: "rollback-check-out-of-range",
        });

        // 🔴 穴②: 「呼び手が壊れた索引を渡した」は、「CAS で弾かれた」とも「対象の行が
        // 無い」とも別の失敗である。⛔ 潰さない——`RangeError` であること・メッセージまで
        // 固定して、`conflicted` に紛れ込む実装や「memory not found」に化ける実装を落とす。
        await expect(
          store.supersedeWithNewMemories!(
            ctx,
            [{ input: newsInput, jobKinds: [] }],
            [
              {
                id: oldA.id,
                supersededByIndex: 1,
                expectedStatus: "active",
                event: buildSupersedeEvent(ctx, oldA.id, oldA.digest),
              },
            ],
          ),
        ).rejects.toThrow(/supersededByIndex out of range/);

        // 対象は一切変わっていない。
        const unchanged = await store.get(ctx, oldA.id);
        expect(unchanged?.status).toBe("active");
        expect(await listEventsForMemory(ctx, oldA.id)).toEqual([]);

        // news の作成もロールバックされている（同じ冪等キーで created: true になる）。
        const { created } = await store.createMemoryWithOutbox(ctx, newsInput, []);
        expect(created).toBe(true);
      });
    } else {
      it("supersedeWithNewMemories は任意メソッドであり、この adapter は実装していない", async () => {
        const store = await createStore();
        expect(store.supersedeWithNewMemories).toBeUndefined();
      });
    }

    // -------------------------------------------------------------------
    // purgeExpiredEvents（Issue #210、ADR 0115）。🔴 任意メソッド——
    // `supportsPurgeExpiredEvents` が false の adapter では、メソッドそのものが
    // 存在しないことだけを検査する。
    // -------------------------------------------------------------------

    /**
     * `updateStatusWithEvent` を、特定の `at`/`kind`/`memoryId` を持つ `memory_events` 行を
     * 1件積むためだけの道具として使う（`buildSupersedeEvent` と同じ発想。`MemoryStore`
     * interface には「任意の kind/at を持つイベントを1件足す」専用の口が無いため）。
     * 対象の `targetMemoryId` の `status` も同時に書き換わるが、この適合テストでは
     * `memory_events` の中身だけを見るので無害——複数回呼んでも `expectedStatus` を
     * 渡さないので CAS には引っかからない。
     */
    async function seedEvent(
      store: MemoryStore,
      ctx: Ctx,
      targetMemoryId: MemoryId,
      opts: { at: Date; kind?: NewMemoryEvent["kind"]; memoryId?: MemoryId | null },
    ): Promise<void> {
      await store.updateStatusWithEvent!(
        ctx,
        targetMemoryId,
        "archived",
        {},
        {
          tenantId: ctx.tenantId,
          memoryId: opts.memoryId !== undefined ? opts.memoryId : targetMemoryId,
          kind: opts.kind ?? "updated",
          at: opts.at,
          actor: { type: "system" },
          meta: { reason: "conformance-purge-fixture" },
        },
      );
    }

    if (supportsPurgeExpiredEvents) {
      it("purgeExpiredEvents は olderThan より古い行だけを消す（境界 at === olderThan は対象外）", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const memory = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "purge-boundary" }),
        );
        const cutoff = new Date("2024-06-01T00:00:00.000Z");
        await seedEvent(store, ctx, memory.id, { at: new Date(cutoff.getTime() - 2000) }); // 古い→対象
        await seedEvent(store, ctx, memory.id, { at: new Date(cutoff.getTime() - 1000) }); // 古い→対象
        await seedEvent(store, ctx, memory.id, { at: cutoff }); // 境界ちょうど→対象外
        await seedEvent(store, ctx, memory.id, { at: new Date(cutoff.getTime() + 1000) }); // 新しい→対象外

        const result = await store.purgeExpiredEvents!(ctx, { olderThan: cutoff, limit: 10 });

        expect(result.purged).toBe(2);
        expect(result.reachedLimit).toBe(false);
        expect(result.dryRun).toBe(false);
        expect(result.oldestPurgedAt).toEqual(new Date(cutoff.getTime() - 2000));
        expect(result.newestPurgedAt).toEqual(new Date(cutoff.getTime() - 1000));

        const remaining = await listEventsForMemory(ctx, memory.id);
        expect(remaining.map((e) => e.at.getTime()).sort()).toEqual(
          [cutoff.getTime(), cutoff.getTime() + 1000].sort(),
        );
      });

      it("purgeExpiredEvents はテナント越境しない", async () => {
        const store = await createStore();
        const ctx1: Ctx = { tenantId: "tenant-purge-1" };
        const ctx2: Ctx = { tenantId: "tenant-purge-2" };
        const memory1 = await store.createMemory(
          ctx1,
          buildNewMemoryFixture({ tenantId: "tenant-purge-1", contentHash: "purge-cross-1" }),
        );
        const memory2 = await store.createMemory(
          ctx2,
          buildNewMemoryFixture({ tenantId: "tenant-purge-2", contentHash: "purge-cross-2" }),
        );
        const oldAt = new Date("2024-01-01T00:00:00.000Z");
        await seedEvent(store, ctx1, memory1.id, { at: oldAt });
        await seedEvent(store, ctx2, memory2.id, { at: oldAt });

        const cutoff = new Date("2024-06-01T00:00:00.000Z");
        const result = await store.purgeExpiredEvents!(ctx1, { olderThan: cutoff, limit: 10 });

        expect(result.purged).toBe(1);
        expect(await listEventsForMemory(ctx1, memory1.id)).toEqual([]);
        // tenant-purge-2 の行は無事（越境して消えていない）。
        expect(await listEventsForMemory(ctx2, memory2.id)).toHaveLength(1);
      });

      it("purgeExpiredEvents は limit を超えた対象を reachedLimit: true で知らせ、超えない呼び出しでは false になる", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const memory = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "purge-limit" }),
        );
        const base = new Date("2024-01-01T00:00:00.000Z").getTime();
        // 5件、すべて cutoff より古い。
        for (let i = 0; i < 5; i++) {
          await seedEvent(store, ctx, memory.id, { at: new Date(base + i * 1000) });
        }
        const cutoff = new Date(base + 10_000);

        const first = await store.purgeExpiredEvents!(ctx, { olderThan: cutoff, limit: 3 });
        expect(first.purged).toBe(3);
        expect(first.reachedLimit).toBe(true);
        // 最も古い3件（i=0,1,2）が消え、i=3,4 が残る。
        expect(first.oldestPurgedAt).toEqual(new Date(base));
        expect(first.newestPurgedAt).toEqual(new Date(base + 2000));

        const second = await store.purgeExpiredEvents!(ctx, { olderThan: cutoff, limit: 10 });
        expect(second.purged).toBe(2);
        expect(second.reachedLimit).toBe(false);

        expect(await listEventsForMemory(ctx, memory.id)).toEqual([]);
      });

      it("purgeExpiredEvents は dryRun のとき1行も消さず、events_purged も1行も積まない", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const memory = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "purge-dry-run" }),
        );
        const oldAt = new Date("2024-01-01T00:00:00.000Z");
        await seedEvent(store, ctx, memory.id, { at: oldAt });
        const cutoff = new Date("2024-06-01T00:00:00.000Z");

        const purgedEventsBefore = await listPurgedEvents(ctx);

        const result = await store.purgeExpiredEvents!(ctx, {
          olderThan: cutoff,
          limit: 10,
          dryRun: true,
        });

        expect(result.dryRun).toBe(true);
        expect(result.purged).toBe(1); // 「消していたら1件消えていた」というプレビュー
        expect(result.oldestPurgedAt).toEqual(oldAt);
        expect(result.newestPurgedAt).toEqual(oldAt);

        // 1行も消えていない。
        expect(await listEventsForMemory(ctx, memory.id)).toHaveLength(1);
        // events_purged も1行も積まれていない。
        expect(await listPurgedEvents(ctx)).toEqual(purgedEventsBefore);
      });

      it("purgeExpiredEvents が積む events_purged は memoryId が null で、件数と期間を meta に持つ", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const memory = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "purge-summary" }),
        );
        const oldest = new Date("2024-01-01T00:00:00.000Z");
        const newest = new Date("2024-01-02T00:00:00.000Z");
        await seedEvent(store, ctx, memory.id, { at: oldest });
        await seedEvent(store, ctx, memory.id, { at: newest });
        const cutoff = new Date("2024-06-01T00:00:00.000Z");

        await store.purgeExpiredEvents!(ctx, { olderThan: cutoff, limit: 10 });

        const purgedEvents = await listPurgedEvents(ctx);
        expect(purgedEvents).toHaveLength(1);
        const summary = purgedEvents[0]!;
        expect(summary.kind).toBe("events_purged");
        expect(summary.memoryId).toBeNull();
        expect(summary.meta.purgedCount).toBe(2);
        expect(new Date(summary.meta.oldestPurgedAt as string).getTime()).toBe(oldest.getTime());
        expect(new Date(summary.meta.newestPurgedAt as string).getTime()).toBe(newest.getTime());
      });

      it("purgeExpiredEvents は kind='events_purged' 自身を対象から除外する（無限後退を避ける）", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const memory = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "purge-no-regress" }),
        );
        const veryOld = new Date("2020-01-01T00:00:00.000Z");
        // 古い events_purged 行を直接仕込む（本来は掃除ジョブ自身が積むが、ここでは
        // 「以前の掃除で積まれた行が、今回の cutoff の範囲内にある」状況を再現する）。
        await seedEvent(store, ctx, memory.id, {
          at: veryOld,
          kind: "events_purged",
          memoryId: null,
        });
        // 掃除対象になりうる普通のイベントも1件。
        await seedEvent(store, ctx, memory.id, { at: veryOld });

        const cutoff = new Date("2024-06-01T00:00:00.000Z");
        const result = await store.purgeExpiredEvents!(ctx, { olderThan: cutoff, limit: 10 });

        // 対象は普通のイベント1件だけ——events_purged は除外される。
        expect(result.purged).toBe(1);

        const purgedEvents = await listPurgedEvents(ctx);
        // 仕込んだ古い events_purged（1件）+ 今回の掃除が積んだ新しい events_purged（1件）= 2件。
        // 仕込んだ方が消えていたら1件のままになる。
        expect(purgedEvents).toHaveLength(2);
        expect(purgedEvents.some((e) => e.at.getTime() === veryOld.getTime())).toBe(true);
      });
    } else {
      it("purgeExpiredEvents は任意メソッドであり、この adapter は実装していない", async () => {
        const store = await createStore();
        expect(store.purgeExpiredEvents).toBeUndefined();
      });
    }

    // -------------------------------------------------------------------
    // archiveDecayed（ADR 0114: docs/memory-model.md §11 行8 の掃引、任意メソッド）
    // -------------------------------------------------------------------

    if (supportsArchiveDecayed) {
      it("archiveDecayed は status='active' かつ decayFloorAt <= now（境界を含む）の Memory だけを archived にし、archived イベントを積む", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const now = new Date("2026-06-01T00:00:00.000Z");

        const decayed = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-target",
            decayFloorAt: new Date(now.getTime() - 1_000),
          }),
        );
        // 境界そのもの（decayFloorAt === now）も対象に含む——`<=`、境界を含む。
        const boundary = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-boundary",
            decayFloorAt: now,
          }),
        );
        const notYetDecayed = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-not-yet",
            decayFloorAt: new Date(now.getTime() + 1_000),
          }),
        );

        const result = await store.archiveDecayed!(ctx, { now, limit: 10 });

        const decayedAfter = await store.get(ctx, decayed.id);
        const boundaryAfter = await store.get(ctx, boundary.id);
        const notYetAfter = await store.get(ctx, notYetDecayed.id);
        const decayedEvents = await listEventsForMemory(ctx, decayed.id);
        const notYetEvents = await listEventsForMemory(ctx, notYetDecayed.id);

        expect({
          archivedIds: new Set(result.archived.map((a) => a.memoryId)),
          reachedLimit: result.reachedLimit,
          decayedStatus: decayedAfter?.status,
          boundaryStatus: boundaryAfter?.status,
          notYetStatus: notYetAfter?.status,
          decayedEventKinds: decayedEvents.map((e) => e.kind),
          // digestSnapshot は「更新前」の digest と一致すること（docs/memory-model.md §9）。
          decayedEventDigestSnapshot: decayedEvents[0]?.digestSnapshot,
          notYetEvents,
        }).toEqual({
          archivedIds: new Set([decayed.id, boundary.id]),
          reachedLimit: false,
          decayedStatus: "archived",
          boundaryStatus: "archived",
          notYetStatus: "active",
          decayedEventKinds: ["archived"],
          decayedEventDigestSnapshot: decayed.digest,
          notYetEvents: [],
        });
      });

      it("archiveDecayed は active 以外（contested/superseded/forgotten/既に archived）を対象にしない", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const now = new Date("2026-06-01T00:00:00.000Z");
        const past = new Date(now.getTime() - 1_000);
        const statuses = ["contested", "superseded", "forgotten", "archived"] as const;
        // ADR 0140: status='contested' は contestedWithId 無しでは作れない。この歯の
        // 主題は archiveDecayed の status ゲートであって contested の一対一ではないので、
        // 対向として使うだけの companion を先に作る。**decayFloorAt を `now` より先に
        // 置く**——既定の fixture の decayFloorAt は `past` より古く、companion が active の
        // ままだと archiveDecayed 自身の対象に紛れ込み、この歯が検査したい「対象が
        // ちょうど4件（各 status に1件ずつ）」という前提を壊す。
        const future = new Date(now.getTime() + 1_000);
        const contestedCompanion = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-contested-companion",
            decayFloorAt: future,
          }),
        );

        const created = [];
        for (const [i, status] of statuses.entries()) {
          created.push(
            await store.createMemory(
              ctx,
              buildNewMemoryFixture({
                tenantId: "tenant-1",
                contentHash: `archive-decayed-status-${i}`,
                status,
                contestedWithId: status === "contested" ? contestedCompanion.id : undefined,
                decayFloorAt: past,
              }),
            ),
          );
        }

        const result = await store.archiveDecayed!(ctx, { now, limit: 10 });

        const afterStatuses = [];
        for (const memory of created) {
          afterStatuses.push((await store.get(ctx, memory.id))?.status);
        }

        expect({ archived: result.archived, afterStatuses }).toEqual({
          archived: [],
          afterStatuses: [...statuses],
        });
      });

      it("archiveDecayed は decayFloorAt 昇順（最も古く遠ざかったものから）で limit 件までに絞る", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const now = new Date("2026-06-01T00:00:00.000Z");
        // オフセットを作成順とわざと入れ替える——挿入順ではなく decayFloorAt の値で
        // ソートされていることを確かめるため。
        const offsetsSeconds = [3, 1, 2];
        const memories = [];
        for (const [i, offsetSeconds] of offsetsSeconds.entries()) {
          memories.push(
            await store.createMemory(
              ctx,
              buildNewMemoryFixture({
                tenantId: "tenant-1",
                contentHash: `archive-decayed-order-${i}`,
                decayFloorAt: new Date(now.getTime() - offsetSeconds * 1_000),
              }),
            ),
          );
        }
        // 昇順で期待される順序: 3秒前(memories[0]) → 2秒前(memories[2]) → 1秒前(memories[1])。

        const result = await store.archiveDecayed!(ctx, { now, limit: 2 });

        expect({
          archivedIds: result.archived.map((a) => a.memoryId),
          reachedLimit: result.reachedLimit,
        }).toEqual({
          archivedIds: [memories[0]!.id, memories[2]!.id],
          reachedLimit: true,
        });
      });

      it("archiveDecayed は対象がちょうど limit 件なら reachedLimit が true になる（『まだあるかもしれない』の意味であり、実際にまだあるとは限らない）", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const now = new Date("2026-06-01T00:00:00.000Z");
        for (let i = 0; i < 2; i += 1) {
          await store.createMemory(
            ctx,
            buildNewMemoryFixture({
              tenantId: "tenant-1",
              contentHash: `archive-decayed-exact-${i}`,
              decayFloorAt: new Date(now.getTime() - 1_000),
            }),
          );
        }

        const result = await store.archiveDecayed!(ctx, { now, limit: 2 });

        expect({ count: result.archived.length, reachedLimit: result.reachedLimit }).toEqual({
          count: 2,
          reachedLimit: true,
        });
      });

      it("archiveDecayed は対象が0件でも例外を投げない", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };

        const result = await store.archiveDecayed!(ctx, {
          now: new Date("2026-06-01T00:00:00.000Z"),
          limit: 10,
        });

        expect(result).toEqual({ archived: [], reachedLimit: false });
      });

      it("archiveDecayed は他テナントの Memory を対象にしない", async () => {
        const store = await createStore();
        const ctxA: Ctx = { tenantId: "tenant-a" };
        const ctxB: Ctx = { tenantId: "tenant-b" };
        const now = new Date("2026-06-01T00:00:00.000Z");
        const past = new Date(now.getTime() - 1_000);

        const memoryA = await store.createMemory(
          ctxA,
          buildNewMemoryFixture({
            tenantId: "tenant-a",
            contentHash: "archive-decayed-tenant-a",
            decayFloorAt: past,
          }),
        );
        const memoryB = await store.createMemory(
          ctxB,
          buildNewMemoryFixture({
            tenantId: "tenant-b",
            contentHash: "archive-decayed-tenant-b",
            decayFloorAt: past,
          }),
        );

        const result = await store.archiveDecayed!(ctxA, { now, limit: 10 });

        const afterA = await store.get(ctxA, memoryA.id);
        const afterB = await store.get(ctxB, memoryB.id);

        expect({
          archivedIds: result.archived.map((a) => a.memoryId),
          statusA: afterA?.status,
          statusB: afterB?.status,
        }).toEqual({ archivedIds: [memoryA.id], statusA: "archived", statusB: "active" });
      });

      it("archiveDecayed を同じ範囲へ二度呼んでも、一度 archived になった行は二度拾われない", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const now = new Date("2026-06-01T00:00:00.000Z");
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-repeat",
            decayFloorAt: new Date(now.getTime() - 1_000),
          }),
        );

        const first = await store.archiveDecayed!(ctx, { now, limit: 10 });
        const second = await store.archiveDecayed!(ctx, { now, limit: 10 });

        expect({ firstCount: first.archived.length, second }).toEqual({
          firstCount: 1,
          second: { archived: [], reachedLimit: false },
        });
      });

      // -----------------------------------------------------------------
      // [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと15
      // （Issue #305）: `opts.clock` の2軸。
      //
      // ⚠ **境界の非対称を1バイトも変えずに写す**（決めたこと14）: ゲート
      // （`VectorFilter.decayFloorSeqAfter`、`vector-store-conformance.ts`）は狭義の `>`
      // （境界は落ちる）、掃引はここで見るとおり境界を含む `<=`。片方だけ `>=` にする
      // 実装ミスは、境界1件のズレとして歯に出ないまま紛れ込みうる——だから両方に
      // 同じ形の境界の歯を置く。
      // -----------------------------------------------------------------

      it("archiveDecayed(clock: 'activity') は decayFloorSeq <= nowSeq（境界を含む）の Memory だけを対象にする。decayFloorSeq が NULL の行は対象にしない", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const now = new Date("2026-06-01T00:00:00.000Z");
        const nowSeq = 1000;

        const decayed = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-seq-target",
            decayFloorAt: now, // 壁時計は無関係であることを示すため、あえて境界に置く。
            decayFloorSeq: nowSeq - 1,
          }),
        );
        // 境界そのもの（decayFloorSeq === nowSeq）も対象に含む——`<=`、境界を含む
        // （`decayFloorAtAfter`/`decay_floor_at <= now` の境界の歯と同じ形）。
        const boundary = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-seq-boundary",
            decayFloorAt: now,
            decayFloorSeq: nowSeq,
          }),
        );
        const notYetDecayed = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-seq-not-yet",
            decayFloorAt: now,
            decayFloorSeq: nowSeq + 1,
          }),
        );
        // decayFloorSeq が NULL（この軸を使っていない）の行は 'activity' 単独では対象外
        // （ADR 0165 決めたこと4「NULL はこの軸には床が無い」——掃引側も NULL を拾わない）。
        const nullSeq = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-seq-null",
            decayFloorAt: now,
          }),
        );

        const result = await store.archiveDecayed!(ctx, {
          now,
          nowSeq,
          clock: "activity",
          limit: 10,
        });

        const archivedIds = new Set(result.archived.map((a) => a.memoryId));
        expect(archivedIds).toEqual(new Set([decayed.id, boundary.id]));
        expect((await store.get(ctx, notYetDecayed.id))?.status).toBe("active");
        expect((await store.get(ctx, nullSeq.id))?.status).toBe("active");
      });

      /**
       * ⭐ ADR 0165 決めたこと8: **`limit` が効くとき、`'activity'` は活動軸の昇順で選ぶ。**
       *
       * **なぜ歯にするか**: `packages/postgres` 側では、この並び順が
       * `idx_memories_recall_gate_seq` を掃引で引けるかどうかを決めている。
       * 【実測】2026-09-16、掃引を `decay_floor_at` 順のままにしていたとき、CI の
       * `archive-decayed-index.test.ts`「適用可能性（活動時計）」が実際に赤くなった
       * （プランナが壁時計側の索引を選び、`decay_floor_seq` が Filter に落ちた）。
       * ⟹ **この歯が緑であることは、向こうの索引が引けることの前提条件である。**
       *
       * ⚠ **返り値 `archived` の並び順は `decayFloorAt` 昇順のまま**（全 clock 共通）。
       * ここが固定しているのは「*どの行が選ばれるか*」であって「どの順で返るか」ではない。
       * だから **`decayFloorAt` を活動軸と逆向きに置いて**、両者が混ざらないようにしてある。
       */
      it("archiveDecayed(clock: 'activity') は limit が効くとき decayFloorSeq 昇順で選ぶ（decayFloorAt 昇順ではない）", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const now = new Date("2026-06-01T00:00:00.000Z");
        const nowSeq = 1000;

        // ⭐ 活動軸の昇順と壁時計の昇順が **逆向き** になるように置く。
        //   seq が小さい（＝もっとも沈んでいる）ものほど decayFloorAt が新しい。
        const seqFirst = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-seq-order-1",
            decayFloorAt: new Date(now.getTime() - 1_000),
            decayFloorSeq: 10,
          }),
        );
        const seqSecond = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-seq-order-2",
            decayFloorAt: new Date(now.getTime() - 2_000),
            decayFloorSeq: 20,
          }),
        );
        const seqThird = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-seq-order-3",
            decayFloorAt: new Date(now.getTime() - 3_000),
            decayFloorSeq: 30,
          }),
        );

        const result = await store.archiveDecayed!(ctx, {
          now,
          nowSeq,
          clock: "activity",
          limit: 2,
        });

        // 活動軸の昇順で 10, 20 が選ばれる。
        // ⛔ 壁時計の昇順なら seqThird（-3000）と seqSecond（-2000）が選ばれるはずで、
        //    この歯はそれを排除している。
        expect(new Set(result.archived.map((a) => a.memoryId))).toEqual(
          new Set([seqFirst.id, seqSecond.id]),
        );
        expect((await store.get(ctx, seqThird.id))?.status).toBe("active");
        expect(result.reachedLimit).toBe(true);

        // 返り値の並びは `decayFloorAt` 昇順のまま（選び方とは別の契約）。
        expect(result.archived.map((a) => a.memoryId)).toEqual([seqSecond.id, seqFirst.id]);
      });

      it("archiveDecayed(clock: 'either') は AND——両方の軸で沈んでいる Memory だけを対象にする（ゲートの OR とは逆向き）", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const now = new Date("2026-06-01T00:00:00.000Z");
        const nowSeq = 1000;
        const decayedAt = new Date(now.getTime() - 1_000);
        const notYetAt = new Date(now.getTime() + 1_000);

        const bothDecayed = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-either-both",
            decayFloorAt: decayedAt,
            decayFloorSeq: nowSeq - 1,
          }),
        );
        const onlyWallDecayed = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-either-wall-only",
            decayFloorAt: decayedAt,
            decayFloorSeq: nowSeq + 1,
          }),
        );
        const onlySeqDecayed = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "archive-decayed-either-seq-only",
            decayFloorAt: notYetAt,
            decayFloorSeq: nowSeq - 1,
          }),
        );

        const result = await store.archiveDecayed!(ctx, {
          now,
          nowSeq,
          clock: "either",
          limit: 10,
        });

        expect(new Set(result.archived.map((a) => a.memoryId))).toEqual(new Set([bothDecayed.id]));
        expect((await store.get(ctx, onlyWallDecayed.id))?.status).toBe("active");
        expect((await store.get(ctx, onlySeqDecayed.id))?.status).toBe("active");
      });
    } else {
      it("archiveDecayed は任意メソッドであり、この adapter は実装していない", async () => {
        const store = await createStore();
        expect(store.archiveDecayed).toBeUndefined();
      });
    }

    // -------------------------------------------------------------------
    // purgeMemory（Issue #198 / ADR 0124: 物理削除、任意メソッド）
    // -------------------------------------------------------------------

    if (supportsPurgeMemory) {
      it("purgeMemory は forgotten な Memory の content/digest をトゥームストーンで上書きし、purgedAt を設定し、status は動かさず、purged イベントを積む", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const memory = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "purge-memory-basic",
            status: "forgotten",
            content: "秘密の本文",
            digest: "元の要旨",
          }),
        );

        const { memory: returned, event } = await store.purgeMemory!(
          ctx,
          memory.id,
          { content: "[purged]", digest: "[purged]" },
          {
            tenantId: "tenant-1",
            memoryId: memory.id,
            kind: "purged",
            actor: { type: "system" },
            digestSnapshot: memory.digest,
            meta: {},
          },
        );

        const after = await store.get(ctx, memory.id);
        const events = await listEventsForMemory(ctx, memory.id);

        expect({
          returnedContent: returned.content,
          returnedDigest: returned.digest,
          returnedStatus: returned.status,
          returnedPurgedAt: returned.purgedAt instanceof Date,
          afterContent: after?.content,
          afterDigest: after?.digest,
          afterStatus: after?.status,
          afterPurgedAt: after?.purgedAt instanceof Date,
          eventKind: event.kind,
          eventDigestSnapshot: event.digestSnapshot,
          eventKinds: events.map((e) => e.kind),
        }).toEqual({
          returnedContent: "[purged]",
          returnedDigest: "[purged]",
          returnedStatus: "forgotten",
          returnedPurgedAt: true,
          afterContent: "[purged]",
          afterDigest: "[purged]",
          afterStatus: "forgotten",
          afterPurgedAt: true,
          eventKind: "purged",
          eventDigestSnapshot: "元の要旨",
          eventKinds: ["purged"],
        });
      });

      it.each(["active", "archived", "superseded", "contested"] as const)(
        "purgeMemory は status=%s な Memory を対象にしない（MemoryPurgeConflictError）",
        async (status) => {
          const store = await createStore();
          const ctx: Ctx = { tenantId: "tenant-1" };
          // ADR 0140: status='contested' は contestedWithId 無しでは作れない。この歯の
          // 主題は purgeMemory の CAS であって contested の一対一ではないので、
          // 対向として使うだけの companion を必要な場合にだけ用意する。
          const companion =
            status === "contested"
              ? await store.createMemory(
                  ctx,
                  buildNewMemoryFixture({
                    tenantId: "tenant-1",
                    contentHash: `purge-memory-status-${status}-companion`,
                  }),
                )
              : undefined;
          const memory = await store.createMemory(
            ctx,
            buildNewMemoryFixture({
              tenantId: "tenant-1",
              contentHash: `purge-memory-status-${status}`,
              status,
              contestedWithId: companion?.id,
            }),
          );

          await expect(
            store.purgeMemory!(
              ctx,
              memory.id,
              { content: "[purged]", digest: "[purged]" },
              {
                tenantId: "tenant-1",
                memoryId: memory.id,
                kind: "purged",
                actor: { type: "system" },
                digestSnapshot: memory.digest,
                meta: {},
              },
            ),
          ).rejects.toThrow(MemoryPurgeConflictError);

          const after = await store.get(ctx, memory.id);
          expect(after?.status).toBe(status);
          expect(after?.content).toBe(memory.content);
        },
      );

      it("purgeMemory は既に purge 済みの Memory を対象にしない（MemoryPurgeConflictError、べき等性の要）", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const memory = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "purge-memory-already-purged",
            status: "forgotten",
          }),
        );
        const event: NewMemoryEvent = {
          tenantId: "tenant-1",
          memoryId: memory.id,
          kind: "purged",
          actor: { type: "system" },
          digestSnapshot: memory.digest,
          meta: {},
        };
        await store.purgeMemory!(
          ctx,
          memory.id,
          { content: "[purged]", digest: "[purged]" },
          event,
        );

        await expect(
          store.purgeMemory!(ctx, memory.id, { content: "[purged]", digest: "[purged]" }, event),
        ).rejects.toThrow(MemoryPurgeConflictError);

        const events = await listEventsForMemory(ctx, memory.id);
        expect(events.filter((e) => e.kind === "purged")).toHaveLength(1); // 2件目は積まれない
      });

      it("purgeMemory は対象が存在しなければ「memory not found」を投げる", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };

        await expect(
          store.purgeMemory!(
            ctx,
            NONEXISTENT_MEMORY_ID,
            { content: "[purged]", digest: "[purged]" },
            {
              tenantId: "tenant-1",
              memoryId: NONEXISTENT_MEMORY_ID,
              kind: "purged",
              actor: { type: "system" },
              digestSnapshot: null,
              meta: {},
            },
          ),
        ).rejects.toThrow(/memory not found/);
      });

      it("purgeMemory は他テナントの Memory を対象にしない（memory not found）", async () => {
        const store = await createStore();
        const ctxA: Ctx = { tenantId: "tenant-a" };
        const ctxB: Ctx = { tenantId: "tenant-b" };
        const memoryA = await store.createMemory(
          ctxA,
          buildNewMemoryFixture({
            tenantId: "tenant-a",
            contentHash: "purge-memory-tenant-a",
            status: "forgotten",
          }),
        );

        await expect(
          store.purgeMemory!(
            ctxB,
            memoryA.id,
            { content: "[purged]", digest: "[purged]" },
            {
              tenantId: "tenant-b",
              memoryId: memoryA.id,
              kind: "purged",
              actor: { type: "system" },
              digestSnapshot: memoryA.digest,
              meta: {},
            },
          ),
        ).rejects.toThrow(/memory not found/);

        const afterA = await store.get(ctxA, memoryA.id);
        expect(afterA?.content).toBe(memoryA.content); // tenant-a 側は無傷
      });
    } else {
      it("purgeMemory は任意メソッドであり、この adapter は実装していない", async () => {
        const store = await createStore();
        expect(store.purgeMemory).toBeUndefined();
      });
    }

    // -------------------------------------------------------------------
    // ADR 0140（Issue #243 続き・ADR 0136 決定3の実装）:
    // `status: 'contested'` を対向（`contestedWithId`）無しで書くことを、書き込み側で
    // 拒否する。`updateStatus`/`updateStatusWithEvent` には `contestedWithId` を渡す
    // 引数がそもそも無いため、この2メソッドは status='contested' を対象にした呼び出しを
    // **常に**拒否する。`createMemory`/`createMemoryWithOutbox`/`supersedeWithNewMemories`
    // （`news` 側）は `contestedWithId` が `null`/`undefined` のときにだけ拒否する——
    // 対向を明示した作成（既存 Memory を指す `contestedWithId` 付き）は引き続き許される。
    // -------------------------------------------------------------------

    it("createMemory は status='contested' かつ contestedWithId 無し を ContestedWithoutCompanionError で拒否する（何も書かれない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      await expect(
        store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            status: "contested",
            contentHash: "lone-contested-create",
          }),
        ),
      ).rejects.toBeInstanceOf(ContestedWithoutCompanionError);

      // 何も書かれていないことを、別クエリ（aggregateScope）で確かめる——例外の型だけでなく
      // 副作用の不在まで見る。
      const aggregate = await store.aggregateScope(ctx, {});
      expect(aggregate.totalInScope).toBe(0);
    });

    it("createMemory は status='contested' かつ contestedWithId が既存 Memory を指すなら受け付ける", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const companion = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "companion-for-create-ok" }),
      );

      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          status: "contested",
          contestedWithId: companion.id,
          contentHash: "contested-with-companion",
        }),
      );

      expect(memory.status).toBe("contested");
      expect(memory.contestedWithId).toBe(companion.id);
    });

    it("createMemoryWithOutbox は status='contested' かつ contestedWithId 無し を ContestedWithoutCompanionError で拒否する（jobs も積まれない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      await expect(
        store.createMemoryWithOutbox(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            status: "contested",
            contentHash: "lone-contested-create-outbox",
          }),
          ["embed"],
        ),
      ).rejects.toBeInstanceOf(ContestedWithoutCompanionError);

      const aggregate = await store.aggregateScope(ctx, {});
      expect(aggregate.totalInScope).toBe(0);
    });

    it("updateStatus は status='contested' への書き込みを常に ContestedWithoutCompanionError で拒否する（対象は無傷）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "update-status-contested" }),
      );

      await expect(store.updateStatus(ctx, memory.id, "contested")).rejects.toBeInstanceOf(
        ContestedWithoutCompanionError,
      );

      const after = await store.get(ctx, memory.id);
      expect(after?.status).toBe("active"); // 無傷
      expect(after?.contestedWithId ?? null).toBeNull();
    });

    it("updateStatusWithEvent は status='contested' への書き込みを常に ContestedWithoutCompanionError で拒否し、イベントも1件も積まれない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          contentHash: "update-status-with-event-contested",
        }),
      );

      await expect(
        store.updateStatusWithEvent(
          ctx,
          memory.id,
          "contested",
          {},
          buildSupersedeEvent(ctx, memory.id, memory.digest),
        ),
      ).rejects.toBeInstanceOf(ContestedWithoutCompanionError);

      const after = await store.get(ctx, memory.id);
      expect(after?.status).toBe("active"); // 無傷
      const events = await listEventsForMemory(ctx, memory.id);
      expect(events).toHaveLength(0);
    });

    if (supportsSupersedeWithNewMemories) {
      it("supersedeWithNewMemories は news のいずれかが status='contested' かつ contestedWithId 無し なら ContestedWithoutCompanionError で拒否し、news も supersede も一切起きない", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const oldMemory = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: "supersede-guard-old",
          }),
        );

        await expect(
          store.supersedeWithNewMemories!(
            ctx,
            [
              // 🔴 先に有効な news を1件置く——違反する要素（index 1）へ到達する前に
              // 有効な要素（index 0）が書き込まれてしまう実装（事前検査を素通りし、
              // ループの途中で初めて落ちる）を、この順序でなければ見逃す。
              {
                input: buildNewMemoryFixture({
                  tenantId: "tenant-1",
                  contentHash: "supersede-guard-valid-news",
                }),
                jobKinds: [],
              },
              {
                input: buildNewMemoryFixture({
                  tenantId: "tenant-1",
                  status: "contested",
                  contentHash: "supersede-guard-lone-contested",
                }),
                jobKinds: [],
              },
            ],
            [
              {
                id: oldMemory.id,
                supersededByIndex: 0,
                expectedStatus: "active",
                event: buildSupersedeEvent(ctx, oldMemory.id, oldMemory.digest),
              },
            ],
          ),
        ).rejects.toBeInstanceOf(ContestedWithoutCompanionError);

        // supersede 対象も無傷（ロールバック済みと同じに見える）。
        const afterOld = await store.get(ctx, oldMemory.id);
        expect(afterOld?.status).toBe("active");
        // news 側（有効だった index 0 も含めて）も一切作られていない——事前検査が
        // 全要素を見てから初めて書き込みを始めることの歯。
        const aggregate = await store.aggregateScope(ctx, {});
        expect(aggregate.totalInScope).toBe(1); // oldMemory だけ
      });
    }

    // -------------------------------------------------------------------
    // markContestedPair（Issue #197 / ADR 0134: 矛盾の検出・明示的操作、任意メソッド）
    // -------------------------------------------------------------------

    if (supportsMarkContestedPair) {
      it("markContestedPair は両側 active な Memory を contested にし、contestedWithId を相互に設定し、両側に1件ずつイベントを積む", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const a = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "mark-contested-a" }),
        );
        const b = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "mark-contested-b" }),
        );

        const result = await store.markContestedPair!(
          ctx,
          {
            id: a.id,
            event: {
              tenantId: "tenant-1",
              memoryId: a.id,
              kind: "updated",
              actor: { type: "system" },
              digestSnapshot: a.digest,
              meta: { reason: "contested" },
            },
          },
          {
            id: b.id,
            event: {
              tenantId: "tenant-1",
              memoryId: b.id,
              kind: "updated",
              actor: { type: "system" },
              digestSnapshot: b.digest,
              meta: { reason: "contested" },
            },
          },
        );

        const afterA = await store.get(ctx, a.id);
        const afterB = await store.get(ctx, b.id);
        const eventsA = await listEventsForMemory(ctx, a.id);
        const eventsB = await listEventsForMemory(ctx, b.id);

        expect({
          returnedFirstStatus: result.first.status,
          returnedFirstContestedWith: result.first.contestedWithId,
          returnedSecondStatus: result.second.status,
          returnedSecondContestedWith: result.second.contestedWithId,
          afterAStatus: afterA?.status,
          afterAContestedWith: afterA?.contestedWithId,
          afterBStatus: afterB?.status,
          afterBContestedWith: afterB?.contestedWithId,
          eventsAKinds: eventsA.map((e) => e.kind),
          eventsBKinds: eventsB.map((e) => e.kind),
        }).toEqual({
          returnedFirstStatus: "contested",
          returnedFirstContestedWith: b.id,
          returnedSecondStatus: "contested",
          returnedSecondContestedWith: a.id,
          afterAStatus: "contested",
          afterAContestedWith: b.id,
          afterBStatus: "contested",
          afterBContestedWith: a.id,
          eventsAKinds: ["updated"],
          eventsBKinds: ["updated"],
        });
      });

      it("markContestedPair は first.id === second.id を RangeError で落とし、何も書き込まない", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const a = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "mark-contested-same-id" }),
        );
        const event: NewMemoryEvent = {
          tenantId: "tenant-1",
          memoryId: a.id,
          kind: "updated",
          actor: { type: "system" },
          digestSnapshot: a.digest,
          meta: {},
        };

        await expect(
          store.markContestedPair!(ctx, { id: a.id, event }, { id: a.id, event }),
        ).rejects.toThrow(RangeError);

        const after = await store.get(ctx, a.id);
        expect(after?.status).toBe("active");
        expect(after?.contestedWithId ?? null).toBeNull();
      });

      it.each(["superseded", "contested", "archived", "forgotten"] as const)(
        "markContestedPair は片方が status=%s だと対象にせず（MemoryStatusConflictError）、両側とも無傷のまま",
        async (status) => {
          const store = await createStore();
          const ctx: Ctx = { tenantId: "tenant-1" };
          const a = await store.createMemory(
            ctx,
            buildNewMemoryFixture({
              tenantId: "tenant-1",
              contentHash: `mark-contested-status-active-${status}`,
            }),
          );
          // ADR 0140: status='contested' は contestedWithId 無しでは作れない。この歯の
          // 主題は markContestedPair の CAS（対象が active でない）であって contested の
          // 一対一ではないので、対向として使うだけの第三の companion を必要な場合にだけ
          // 用意する（a・b とは無関係——a・b 自体のペア構成をこの companion で乱さない）。
          const bContestedCompanion =
            status === "contested"
              ? await store.createMemory(
                  ctx,
                  buildNewMemoryFixture({
                    tenantId: "tenant-1",
                    contentHash: `mark-contested-status-other-${status}-companion`,
                  }),
                )
              : undefined;
          const b = await store.createMemory(
            ctx,
            buildNewMemoryFixture({
              tenantId: "tenant-1",
              contentHash: `mark-contested-status-other-${status}`,
              status,
              contestedWithId: bContestedCompanion?.id,
            }),
          );
          const event = (memoryId: MemoryId): NewMemoryEvent => ({
            tenantId: "tenant-1",
            memoryId,
            kind: "updated",
            actor: { type: "system" },
            digestSnapshot: "digest",
            meta: {},
          });

          await expect(
            store.markContestedPair!(
              ctx,
              { id: a.id, event: event(a.id) },
              { id: b.id, event: event(b.id) },
            ),
          ).rejects.toThrow(MemoryStatusConflictError);

          const afterA = await store.get(ctx, a.id);
          const afterB = await store.get(ctx, b.id);
          expect(afterA?.status).toBe("active");
          expect(afterA?.contestedWithId ?? null).toBeNull();
          expect(afterB?.status).toBe(status);
          const eventsA = await listEventsForMemory(ctx, a.id);
          const eventsB = await listEventsForMemory(ctx, b.id);
          expect(eventsA).toHaveLength(0);
          expect(eventsB).toHaveLength(0);
        },
      );

      it("markContestedPair は対象が存在しなければ「memory not found」を投げ、存在する側も無傷のまま", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const a = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "mark-contested-not-found" }),
        );
        const event = (memoryId: MemoryId): NewMemoryEvent => ({
          tenantId: "tenant-1",
          memoryId,
          kind: "updated",
          actor: { type: "system" },
          digestSnapshot: "digest",
          meta: {},
        });

        await expect(
          store.markContestedPair!(
            ctx,
            { id: a.id, event: event(a.id) },
            { id: NONEXISTENT_MEMORY_ID, event: event(NONEXISTENT_MEMORY_ID) },
          ),
        ).rejects.toThrow(NOT_FOUND_ERROR_MESSAGE);

        const afterA = await store.get(ctx, a.id);
        expect(afterA?.status).toBe("active");
        expect(afterA?.contestedWithId ?? null).toBeNull();
        expect(await listEventsForMemory(ctx, a.id)).toHaveLength(0);
      });

      it("markContestedPair は他テナントの Memory を対象にしない（memory not found）", async () => {
        const store = await createStore();
        const ctxA: Ctx = { tenantId: "tenant-a" };
        const ctxB: Ctx = { tenantId: "tenant-b" };
        const memoryA = await store.createMemory(
          ctxA,
          buildNewMemoryFixture({ tenantId: "tenant-a", contentHash: "mark-contested-tenant-a" }),
        );
        const memoryB = await store.createMemory(
          ctxB,
          buildNewMemoryFixture({ tenantId: "tenant-b", contentHash: "mark-contested-tenant-b" }),
        );
        const event = (memoryId: MemoryId): NewMemoryEvent => ({
          tenantId: "tenant-b",
          memoryId,
          kind: "updated",
          actor: { type: "system" },
          digestSnapshot: "digest",
          meta: {},
        });

        await expect(
          store.markContestedPair!(
            ctxB,
            { id: memoryA.id, event: event(memoryA.id) },
            { id: memoryB.id, event: event(memoryB.id) },
          ),
        ).rejects.toThrow(NOT_FOUND_ERROR_MESSAGE);

        const afterA = await store.get(ctxA, memoryA.id);
        expect(afterA?.status).toBe("active"); // tenant-a 側は無傷
        expect(afterA?.contestedWithId ?? null).toBeNull();
      });
    } else {
      it("markContestedPair は任意メソッドであり、この adapter は実装していない", async () => {
        const store = await createStore();
        expect(store.markContestedPair).toBeUndefined();
      });
    }

    // -------------------------------------------------------------------
    // resolveContestedPair（Issue #197 / ADR 0150: markContestedPair の解決側、任意メソッド）
    // -------------------------------------------------------------------

    if (supportsResolveContestedPair) {
      /**
       * `store.markContestedPair!` で実際に相互参照する `contested` の対を作る。
       * **この歯は `supportsMarkContestedPair` も同時に `true` であることを前提にする**
       * ——`resolveContestedPair` を実装する2つの adapter（testkit の in-memory・
       * postgres）は、どちらも `markContestedPair` を実装済みである。`contestedWithId` を
       * 作成後に書ける口は今日この2つしか無いため、この前提を外すと対の作り方が無くなる。
       */
      async function createContestedPair(
        store: MemoryStore,
        ctx: Ctx,
        aContentHash: string,
        bContentHash: string,
      ): Promise<{ a: MemoryId; b: MemoryId }> {
        const a = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: aContentHash }),
        );
        const b = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: bContentHash }),
        );
        const event = (memoryId: MemoryId): NewMemoryEvent => ({
          tenantId: ctx.tenantId,
          memoryId,
          kind: "updated",
          actor: { type: "system" },
          digestSnapshot: "digest",
          meta: { reason: "contested" },
        });
        await store.markContestedPair!(
          ctx,
          { id: a.id, event: event(a.id) },
          { id: b.id, event: event(b.id) },
        );
        return { a: a.id, b: b.id };
      }

      function buildResolveEvent(
        ctx: Ctx,
        memoryId: MemoryId,
        kind: "updated" | "superseded",
      ): NewMemoryEvent {
        return {
          tenantId: ctx.tenantId,
          memoryId,
          kind,
          actor: { type: "system" },
          digestSnapshot: "digest",
          sizeBeforeBytes: null,
          meta: { reason: "contested_resolved" },
        };
      }

      it("resolveContestedPair(supersede) は勝者を active、敗者を superseded + supersededById にし、contestedWithId を両側とも null に戻し、両側に1件ずつイベントを積む", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const { a, b } = await createContestedPair(
          store,
          ctx,
          "resolve-contested-supersede-a",
          "resolve-contested-supersede-b",
        );

        const result = await store.resolveContestedPair!(
          ctx,
          { id: a, status: "active", event: buildResolveEvent(ctx, a, "updated") },
          {
            id: b,
            status: "superseded",
            supersededById: a,
            event: buildResolveEvent(ctx, b, "superseded"),
          },
        );

        const afterA = await store.get(ctx, a);
        const afterB = await store.get(ctx, b);
        const eventsA = await listEventsForMemory(ctx, a);
        const eventsB = await listEventsForMemory(ctx, b);

        expect({
          returnedFirstStatus: result.first.status,
          returnedFirstContestedWith: result.first.contestedWithId,
          returnedSecondStatus: result.second.status,
          returnedSecondContestedWith: result.second.contestedWithId,
          returnedSecondSupersededBy: result.second.supersededById,
          afterAStatus: afterA?.status,
          afterAContestedWith: afterA?.contestedWithId,
          afterBStatus: afterB?.status,
          afterBContestedWith: afterB?.contestedWithId,
          afterBSupersededBy: afterB?.supersededById,
          eventsAKinds: eventsA.map((e) => e.kind),
          eventsBKinds: eventsB.map((e) => e.kind),
        }).toEqual({
          returnedFirstStatus: "active",
          returnedFirstContestedWith: null,
          returnedSecondStatus: "superseded",
          returnedSecondContestedWith: null,
          returnedSecondSupersededBy: a,
          afterAStatus: "active",
          afterAContestedWith: null,
          afterBStatus: "superseded",
          afterBContestedWith: null,
          afterBSupersededBy: a,
          // markContestedPair が積んだ 'updated' が既に1件あるので、resolve 後は2件。
          eventsAKinds: ["updated", "updated"],
          eventsBKinds: ["updated", "superseded"],
        });
      });

      it("resolveContestedPair(both_active) は両側とも active にし、contestedWithId を両側とも null に戻す", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const { a, b } = await createContestedPair(
          store,
          ctx,
          "resolve-contested-both-active-a",
          "resolve-contested-both-active-b",
        );

        const result = await store.resolveContestedPair!(
          ctx,
          { id: a, status: "active", event: buildResolveEvent(ctx, a, "updated") },
          { id: b, status: "active", event: buildResolveEvent(ctx, b, "updated") },
        );

        expect(result.first.status).toBe("active");
        expect(result.first.contestedWithId).toBeNull();
        expect(result.second.status).toBe("active");
        expect(result.second.contestedWithId).toBeNull();

        const afterA = await store.get(ctx, a);
        const afterB = await store.get(ctx, b);
        expect(afterA?.status).toBe("active");
        expect(afterA?.contestedWithId ?? null).toBeNull();
        expect(afterB?.status).toBe("active");
        expect(afterB?.contestedWithId ?? null).toBeNull();
      });

      it("resolveContestedPair は first.id === second.id を RangeError で落とし、何も書き込まない", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const { a } = await createContestedPair(
          store,
          ctx,
          "resolve-contested-same-id-a",
          "resolve-contested-same-id-b",
        );
        const event = buildResolveEvent(ctx, a, "updated");

        await expect(
          store.resolveContestedPair!(
            ctx,
            { id: a, status: "active", event },
            { id: a, status: "active", event },
          ),
        ).rejects.toThrow(RangeError);

        const after = await store.get(ctx, a);
        expect(after?.status).toBe("contested");
      });

      it.each(["active", "superseded", "archived", "forgotten"] as const)(
        "resolveContestedPair は片方が status=%s（contested でない）だと MemoryStatusConflictError で弾かれ、両側とも無傷のまま",
        async (status) => {
          const store = await createStore();
          const ctx: Ctx = { tenantId: "tenant-1" };
          const { a, b } = await createContestedPair(
            store,
            ctx,
            `resolve-contested-status-a-${status}`,
            `resolve-contested-status-b-${status}`,
          );
          // b を対から外に出す（`updateStatus` は `contestedWithId` を書けないため、b は
          // `contestedWithId` が残ったままの status だけ動く——これは
          // `resolveContestedPair` の CAS 検査対象を作るためだけの下ごしらえであり、
          // その残留自体は本歯の主題ではない）。
          await store.updateStatus(ctx, b, status);

          await expect(
            store.resolveContestedPair!(
              ctx,
              { id: a, status: "active", event: buildResolveEvent(ctx, a, "updated") },
              { id: b, status: "active", event: buildResolveEvent(ctx, b, "updated") },
            ),
          ).rejects.toThrow(MemoryStatusConflictError);

          const afterA = await store.get(ctx, a);
          const afterB = await store.get(ctx, b);
          expect(afterA?.status).toBe("contested");
          expect(afterA?.contestedWithId).toBe(b);
          expect(afterB?.status).toBe(status);
        },
      );

      it("resolveContestedPair は対象が存在しなければ「memory not found」を投げ、存在する側も無傷のまま", async () => {
        const store = await createStore();
        const ctx: Ctx = { tenantId: "tenant-1" };
        const { a } = await createContestedPair(
          store,
          ctx,
          "resolve-contested-not-found-a",
          "resolve-contested-not-found-b",
        );

        await expect(
          store.resolveContestedPair!(
            ctx,
            { id: a, status: "active", event: buildResolveEvent(ctx, a, "updated") },
            {
              id: NONEXISTENT_MEMORY_ID,
              status: "active",
              event: buildResolveEvent(ctx, NONEXISTENT_MEMORY_ID, "updated"),
            },
          ),
        ).rejects.toThrow(NOT_FOUND_ERROR_MESSAGE);

        const afterA = await store.get(ctx, a);
        expect(afterA?.status).toBe("contested");
        expect(afterA?.contestedWithId).not.toBeNull();
      });

      it("resolveContestedPair は他テナントの Memory を対象にしない（memory not found）", async () => {
        const store = await createStore();
        const ctxA: Ctx = { tenantId: "tenant-a" };
        const ctxB: Ctx = { tenantId: "tenant-b" };
        const { a: memoryAId, b: memoryAPartnerId } = await createContestedPair(
          store,
          ctxA,
          "resolve-contested-tenant-a-1",
          "resolve-contested-tenant-a-2",
        );
        const memoryB = await store.createMemory(
          ctxB,
          buildNewMemoryFixture({
            tenantId: "tenant-b",
            contentHash: "resolve-contested-tenant-b",
          }),
        );

        await expect(
          store.resolveContestedPair!(
            ctxB,
            {
              id: memoryAId,
              status: "active",
              event: buildResolveEvent(ctxB, memoryAId, "updated"),
            },
            {
              id: memoryB.id,
              status: "active",
              event: buildResolveEvent(ctxB, memoryB.id, "updated"),
            },
          ),
        ).rejects.toThrow(NOT_FOUND_ERROR_MESSAGE);

        const afterA = await store.get(ctxA, memoryAId);
        expect(afterA?.status).toBe("contested"); // tenant-a 側は無傷
        expect(afterA?.contestedWithId).toBe(memoryAPartnerId);
      });
    } else {
      it("resolveContestedPair は任意メソッドであり、この adapter は実装していない", async () => {
        const store = await createStore();
        expect(store.resolveContestedPair).toBeUndefined();
      });
    }

    // -------------------------------------------------------------------
    // 明示的な復帰（archived → active。Issue #195、ADR 0122）
    //
    // 🔴 `restoreArchived` は `MemoryStore` の新しい任意メソッドではない
    // （`Runtime.restoreArchived` の doc コメント参照）——`archived` → `active` への
    // compare-and-swap は既存の必須メソッド `updateStatusWithEvent`（ADR 0031）で
    // 表現できるため、ここでは `supportsArchiveDecayed` のような分岐を持たない。
    // **この歯は両方の adapter（postgres・in-memory）で常に走る**——`archiveDecayed`
    // を経由せず、`buildNewMemoryFixture({ status: 'archived' })` で直接 archived な
    // Memory を用意し、`updateStatusWithEvent` に新しい event kind `'restored'`
    // （ADR 0122 が `MemoryEventKind` へ足した値）を渡せることそのものを検査する
    // ——DB 側の CHECK 制約（`migrations/0011_memory_events_kind_restored.sql`）が
    // 実際にこの値を受け付けることを postgres 側で確認する場でもある。
    // -------------------------------------------------------------------

    function buildRestoredEvent(ctx: Ctx, memoryId: MemoryId, digest: string): NewMemoryEvent {
      return {
        tenantId: ctx.tenantId,
        memoryId,
        kind: "restored",
        actor: { type: "system" },
        digestSnapshot: digest,
        sizeBeforeBytes: null,
        meta: {},
      };
    }

    it("updateStatusWithEvent は kind='restored' で archived な Memory を active へ戻せる（往復の店側半分）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", status: "archived" }),
      );
      expect(memory.status).toBe("archived");

      const { memory: restored, event } = await store.updateStatusWithEvent(
        ctx,
        memory.id,
        "active",
        { expectedStatus: "archived" },
        buildRestoredEvent(ctx, memory.id, memory.digest),
      );

      expect(restored.status).toBe("active");
      expect(event.kind).toBe("restored");
      expect(event.memoryId).toBe(memory.id);

      const events = await listEventsForMemory(ctx, memory.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("restored");

      const reread = await store.get(ctx, memory.id);
      expect(reread?.status).toBe("active");
    });

    it("kind='restored' の compare-and-swap は archived 以外を対象にできない（active に戻っている行を二重に戻さない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", status: "active" }),
      );

      await expect(
        store.updateStatusWithEvent(
          ctx,
          memory.id,
          "active",
          { expectedStatus: "archived" },
          buildRestoredEvent(ctx, memory.id, memory.digest),
        ),
      ).rejects.toBeInstanceOf(MemoryStatusConflictError);

      const events = await listEventsForMemory(ctx, memory.id);
      expect(events).toEqual([]);
    });

    // -------------------------------------------------------------------
    // aggregateScope（docs/recall.md §5 目次帯・第3階・「スコープの外延」マネージャー決定）
    // -------------------------------------------------------------------

    it("aggregateScope は subject ごとの件数を countKind 付きで返す（groups の総和 == totalInScope）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", subjectId: "user-1" }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", subjectId: "user-1" }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", subjectId: "user-2" }),
      );

      const aggregate = await store.aggregateScope(ctx, {});
      const byKey = new Map(aggregate.groups.map((g) => [g.key, g]));

      expect(byKey.get("user-1")?.count).toBe(2);
      expect(byKey.get("user-2")?.count).toBe(1);
      expect(aggregate.totalInScope).toBe(3);
      const sumOfGroups = aggregate.groups.reduce((sum, g) => sum + g.count, 0);
      expect(sumOfGroups).toBe(aggregate.totalInScope);
      for (const group of aggregate.groups) {
        expect(["exact", "lower_bound", "unknown"]).toContain(group.countKind);
      }
    });

    it("aggregateScope は subject_id が null の群を key: null として数える（D12）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", subjectId: null }),
      );

      const aggregate = await store.aggregateScope(ctx, {});
      expect(aggregate.groups).toContainEqual(
        expect.objectContaining({ axis: "subject", key: null, count: 1 }),
      );
    });

    it("aggregateScope は scope.subjectId で絞り込める", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", subjectId: "user-1" }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", subjectId: "user-2" }),
      );

      const aggregate = await store.aggregateScope(ctx, { subjectId: "user-1" });
      expect(aggregate.totalInScope).toBe(1);
    });

    it("aggregateScope は status='archived' を totalInScope に含めず filteredArchived に計上する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", status: "active" }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", status: "archived" }),
      );

      const aggregate = await store.aggregateScope(ctx, {});
      expect(aggregate.totalInScope).toBe(1);
      expect(aggregate.filteredArchived.count).toBe(1);
      expect(aggregate.filteredSuperseded.count).toBe(0);
      expect(aggregate.filteredForgotten.count).toBe(0);
    });

    it("aggregateScope は status='superseded' と status='forgotten' を別々に計上する（ADR 0027、束ねない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      // 件数をわざと非対称にする（3 と 5）。これは実測の歯である
      // （オーナー指摘: `count(*) OVER ()` が `hnsw.ef_search` の設定値をそのまま返して
      // `exact` を名乗っていた事故が ADR 0008 の前例にある。「数えられるはずだ」は設計の
      // 主張であって値の主張ではないので、既知の真値と突き合わせて確かめる）。
      // 1件ずつでは、取り違え（superseded と forgotten を入れ替えて数える）も
      // 束ねたまま（両方を1つの filteredStatus のような欄に合算する）も検出できない。
      // 3 と 5 なら、束ねれば合計8になり、取り違えれば 5/3 と出る——どちらも必ず落ちる。
      const SUPERSEDED_COUNT = 3;
      const FORGOTTEN_COUNT = 5;
      for (let i = 0; i < SUPERSEDED_COUNT; i++) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", status: "superseded" }),
        );
      }
      for (let i = 0; i < FORGOTTEN_COUNT; i++) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", status: "forgotten" }),
        );
      }
      // active / archived も混ぜて、フィルタの取り違え（例えば status='active' まで
      // superseded/forgotten の列に混入する）が起きていないことも同時に検査する。
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", status: "active" }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", status: "archived" }),
      );

      const aggregate = await store.aggregateScope(ctx, {});
      expect(aggregate.totalInScope).toBe(1);
      expect(aggregate.filteredArchived.count).toBe(1);
      expect(aggregate.filteredSuperseded.count).toBe(SUPERSEDED_COUNT);
      expect(aggregate.filteredForgotten.count).toBe(FORGOTTEN_COUNT);
      // `countKind: 'exact'` という名乗り自体を歯にする（オーナー指摘の核）。
      expect(aggregate.filteredSuperseded.countKind).toBe("exact");
      expect(aggregate.filteredForgotten.countKind).toBe("exact");
    });

    it("aggregateScope は status='contested' を totalInScope に含める（段1と同じゲート）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // ADR 0140: `status: 'contested'` は `contestedWithId` 無しでは作れない
      // （`ContestedWithoutCompanionError`）。この歯の主題は aggregateScope の
      // ゲートであって contested の一対一ではないので、対向として使うだけの
      // companion を先に作る（companion 自身も active として totalInScope に入る）。
      const companion = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "contested-scope-companion" }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          status: "contested",
          contestedWithId: companion.id,
          contentHash: "contested-scope-subject",
        }),
      );

      const aggregate = await store.aggregateScope(ctx, {});
      // companion（active）+ 本体（contested）の2件とも status IN ('active','contested') の
      // ゲートに入る。
      expect(aggregate.totalInScope).toBe(2);
    });

    it("aggregateScope は occurredAfter の外にある Memory を filteredPeriod に計上し、totalInScope から除く", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          occurredAt: new Date("2020-01-01T00:00:00.000Z"),
        }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          occurredAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
      );

      const aggregate = await store.aggregateScope(ctx, {
        occurredAfter: new Date("2025-01-01T00:00:00.000Z"),
      });
      expect(aggregate.totalInScope).toBe(1);
      expect(aggregate.filteredPeriod.count).toBe(1);
    });

    // -----------------------------------------------------------------------
    // period の境界（ADR 0039）
    //
    // **同じ規則が4箇所で実装されている**——`recall-runtime.ts` の候補フィルタ、
    // `PostgresMemoryStore.aggregateScope`、`InMemoryMemoryStore.aggregateScope`、
    // `packages/core` のテスト用 `FakeMemoryStore.aggregateScope`。
    // 2026-09-06 時点では4つとも境界を含む（`>=` / `<=`）が、**それを測る歯が無かった。**
    // ⟹ 将来どれか1つを直したとき、他が追随しないと**返る件数と `omitted` の内訳が
    // 食い違い、`omitted` が嘘をつく。**
    //
    // ⚠ この適合テストが届くのは adapter の2つ（postgres / in-memory）だけである。
    // `recall-runtime.ts` と `packages/core` の fake には届かない（届かない理由と、
    // そちらを別に測っていることは ADR 0039 に書いた）。
    //
    // ⚠ フィクスチャは非対称にする。**「境界1件 / 内側3件 / 外側5件」**にしてあるのは、
    // 対称な件数（例: 内1・外1）だと**規則を丸ごと反転させても同じ数が出て、
    // 変異が素通りする**ためである（既存の歯がまさにその形だった——内1・外1で
    // `totalInScope=1, filteredPeriod=1`。反転しても同じ値になる）。
    // -----------------------------------------------------------------------

    /** 境界1件・内側 `inside` 件・外側 `outside` 件を作る。件数は必ず互いに違える。 */
    async function seedPeriodFixture(
      store: MemoryStore,
      ctx: Ctx,
      opts: { boundary: Date; inside: Date; outside: Date; inside_n: number; outside_n: number },
    ): Promise<void> {
      const make = async (occurredAt: Date, tag: string, n: number) => {
        for (let i = 0; i < n; i += 1) {
          await store.createMemory(
            ctx,
            buildNewMemoryFixture({
              tenantId: ctx.tenantId,
              occurredAt,
              contentHash: `period-${tag}-${i}`,
            }),
          );
        }
      };
      await make(opts.boundary, "boundary", 1);
      await make(opts.inside, "inside", opts.inside_n);
      await make(opts.outside, "outside", opts.outside_n);
    }

    const PERIOD_CUTOFF = new Date("2026-06-01T00:00:00.000Z");
    const PERIOD_BEFORE_CUTOFF = new Date("2026-05-01T00:00:00.000Z");
    const PERIOD_AFTER_CUTOFF = new Date("2026-07-01T00:00:00.000Z");

    it("aggregateScope の occurredAfter は境界を含む（occurredAt === occurredAfter は残る）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await seedPeriodFixture(store, ctx, {
        boundary: PERIOD_CUTOFF,
        inside: PERIOD_AFTER_CUTOFF,
        outside: PERIOD_BEFORE_CUTOFF,
        inside_n: 3,
        outside_n: 5,
      });

      const aggregate = await store.aggregateScope(ctx, { occurredAfter: PERIOD_CUTOFF });
      // 境界1 + 内側3 = 4 が残り、外側5が落ちる。4 !== 5 なので、規則を反転させても
      // 境界を外しても、この2つの数の組は一致しない。
      expect(aggregate.totalInScope).toBe(4);
      expect(aggregate.filteredPeriod.count).toBe(5);
    });

    it("aggregateScope の occurredBefore は境界を含む（occurredAt === occurredBefore は残る）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await seedPeriodFixture(store, ctx, {
        boundary: PERIOD_CUTOFF,
        inside: PERIOD_BEFORE_CUTOFF,
        outside: PERIOD_AFTER_CUTOFF,
        inside_n: 3,
        outside_n: 5,
      });

      const aggregate = await store.aggregateScope(ctx, { occurredBefore: PERIOD_CUTOFF });
      expect(aggregate.totalInScope).toBe(4);
      expect(aggregate.filteredPeriod.count).toBe(5);
    });

    it("⚠ 鳴ってはいけない側: occurredAfter も occurredBefore も渡さなければ period は一切絞らない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await seedPeriodFixture(store, ctx, {
        boundary: PERIOD_CUTOFF,
        inside: PERIOD_AFTER_CUTOFF,
        outside: PERIOD_BEFORE_CUTOFF,
        inside_n: 3,
        outside_n: 5,
      });

      const aggregate = await store.aggregateScope(ctx, {});
      // 9件すべてが残り、filteredPeriod は 0。これを測らないと、
      // 「常に絞る」側へ倒しても誰も気づかない。
      expect(aggregate.totalInScope).toBe(9);
      expect(aggregate.filteredPeriod.count).toBe(0);
    });

    it("aggregateScope の period は、occurredAt が null の Memory には recordedAt を当てる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // occurredAt は渡さない（null のまま）。recordedAt だけを内側/外側に置く。
      // 件数を 2 対 7 と違えてあるので、取り違えても束ねても別の値になる。
      for (let i = 0; i < 2; i += 1) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            recordedAt: PERIOD_AFTER_CUTOFF,
            contentHash: `period-null-inside-${i}`,
          }),
        );
      }
      for (let i = 0; i < 7; i += 1) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            recordedAt: PERIOD_BEFORE_CUTOFF,
            contentHash: `period-null-outside-${i}`,
          }),
        );
      }

      const aggregate = await store.aggregateScope(ctx, { occurredAfter: PERIOD_CUTOFF });
      expect(aggregate.totalInScope).toBe(2);
      expect(aggregate.filteredPeriod.count).toBe(7);
    });

    // -----------------------------------------------------------------------
    // aggregateScope の validAt ゲート（Issue #280、Issue #202 第2弾）
    //
    // `period` と同じ4箇所の複製先——`recall-runtime.ts` の候補フィルタ、
    // `PostgresMemoryStore.aggregateScope`、`InMemoryMemoryStore.aggregateScope`、
    // `packages/core` のテスト用 `FakeMemoryStore.aggregateScope`——を持つ。この適合テストが
    // 届くのは adapter の2つ（postgres / in-memory）だけである（period と同じ限界）。
    // -----------------------------------------------------------------------

    const VALID_AT = new Date("2026-06-01T00:00:00.000Z");

    it("aggregateScope は validUntil が validAt 以前の Memory を totalInScope から除き、filteredExpired に計上する（境界も落ちる、狭義の `>` の逆）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // 境界ちょうど（validUntil === validAt）は「もう真ではない」側——expired に入る。
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", validUntil: VALID_AT }),
      );
      for (let i = 0; i < 4; i += 1) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            validUntil: new Date(VALID_AT.getTime() - 1000),
            contentHash: `expired-${i}`,
          }),
        );
      }
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          validUntil: new Date(VALID_AT.getTime() + 1000),
        }),
      );

      const aggregate = await store.aggregateScope(ctx, { validAt: VALID_AT });
      expect(aggregate.totalInScope).toBe(1);
      expect(aggregate.filteredExpired.count).toBe(5);
      expect(aggregate.filteredExpired.countKind).toBe("exact");
      expect(aggregate.filteredNotYetValid.count).toBe(0);
    });

    it("aggregateScope は validFrom が validAt より後の Memory を totalInScope から除き、filteredNotYetValid に計上する（境界は含まれる側）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // 境界ちょうど（validFrom === validAt）は「もう真になっている」側——in scope。
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", validFrom: VALID_AT }),
      );
      for (let i = 0; i < 6; i += 1) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            validFrom: new Date(VALID_AT.getTime() + 1000),
            contentHash: `not-yet-valid-${i}`,
          }),
        );
      }

      const aggregate = await store.aggregateScope(ctx, { validAt: VALID_AT });
      expect(aggregate.totalInScope).toBe(1);
      expect(aggregate.filteredNotYetValid.count).toBe(6);
      expect(aggregate.filteredNotYetValid.countKind).toBe("exact");
      expect(aggregate.filteredExpired.count).toBe(0);
    });

    it("⚠ 鳴ってはいけない側: validAt を渡さなければ validity は一切絞らない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          validFrom: new Date("2099-01-01T00:00:00.000Z"),
          contentHash: "far-future",
        }),
      );

      const aggregate = await store.aggregateScope(ctx, {});
      expect(aggregate.totalInScope).toBe(2);
      expect(aggregate.filteredExpired.count).toBe(0);
      expect(aggregate.filteredNotYetValid.count).toBe(0);
    });

    it("aggregateScope は validFrom/validUntil が両方 null の Memory を、どの validAt でも in scope のまま数える（マネージャー決定1）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", validFrom: null, validUntil: null }),
      );

      const aggregate = await store.aggregateScope(ctx, {
        validAt: new Date("2099-01-01T00:00:00.000Z"),
      });
      expect(aggregate.totalInScope).toBe(1);
      expect(aggregate.filteredExpired.count).toBe(0);
      expect(aggregate.filteredNotYetValid.count).toBe(0);
    });

    // -----------------------------------------------------------------------
    // ⭐ 忘却ゲート（Issue #329 / ADR 0173）
    //
    // `aggregateScope` が数える `filteredDecayed` は、**段1の押し下げ
    // （`VectorFilter.decayFloorAtAfter`/`decayFloorSeqAfter`/`decayFloorAnyAxis`、
    // `vector-store.ts`）とまったく同じ述語**でなければならない——ここがずれると
    // 「段1で落ちた数」と「集約が数えた数」が黙って食い違い、`omitted` が嘘をつく。
    // ⚠ **ここは `validAt` と決定的に違う点が1つある**: 減衰しきった Memory は
    // `totalInScope` からも群カウントからも**除かれない**（スコープ内に在る）。
    // ⟹ 下の歯はすべて `totalInScope` を併せて固定する。
    // -----------------------------------------------------------------------

    const DECAY_AT = new Date("2026-06-01T00:00:00.000Z");

    it("aggregateScope は decayFloorAt が decayFloorAtAfter 以下の Memory を filteredDecayed に数える（境界も沈む側、狭義の `>`）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // 境界ちょうど（decayFloorAt === decayFloorAtAfter）は「沈んでいる」側
      // ——`VectorFilter.decayFloorAtAfter` が狭義の `>`（`decay_floor_at > $n`）だから。
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", decayFloorAt: DECAY_AT }),
      );
      for (let i = 0; i < 3; i += 1) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            decayFloorAt: new Date(DECAY_AT.getTime() - 1000),
            contentHash: `decayed-${i}`,
          }),
        );
      }
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          decayFloorAt: new Date(DECAY_AT.getTime() + 1000),
          contentHash: "alive",
        }),
      );

      const aggregate = await store.aggregateScope(ctx, { decayFloorAtAfter: DECAY_AT });
      expect(aggregate.filteredDecayed.count).toBe(4);
      expect(aggregate.filteredDecayed.countKind).toBe("exact");
      // ⭐ `expired` と違い、**totalInScope からは除かれない**（5件すべてスコープ内）。
      expect(aggregate.totalInScope).toBe(5);
      expect(aggregate.groups.reduce((sum, g) => sum + g.count, 0)).toBe(5);
    });

    it("⚠ 鳴ってはいけない側: decayFloorAtAfter/decayFloorSeqAfter をどちらも渡さなければ filteredDecayed は 0（includeFullyDecayed: true の経路）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          decayFloorAt: new Date("2000-01-01T00:00:00.000Z"),
          // ⚠ 負の値は使えない——`memories_decay_seq_non_negative`（CHECK 制約）で
          // 本物の Postgres が弾く。【実測】2026-09-16、この歯を `-1` で書いて実際に踏んだ。
          // 「どの軸でも沈んでいる」を表すには 0 で足りる（`decayFloorSeqAfter` を
          // 渡さないので、そもそもこの列は読まれない、というのがこの歯の主張である）。
          decayFloorSeq: 0,
        }),
      );

      const aggregate = await store.aggregateScope(ctx, {});
      expect(aggregate.filteredDecayed.count).toBe(0);
      expect(aggregate.totalInScope).toBe(1);
    });

    it("aggregateScope は活動時計の軸（decayFloorSeqAfter）だけで数え、壁時計を見ない（ADR 0165 決めたこと1の 'activity'）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const farPast = new Date("2000-01-01T00:00:00.000Z");
      // 壁時計では全員沈んでいる。活動時計の軸だけで判定されなければならない。
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          decayFloorAt: farPast,
          decayFloorSeq: 10, // 10 > 10 は false ⟹ 沈んでいる（境界も沈む側）
          contentHash: "seq-boundary",
        }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          decayFloorAt: farPast,
          decayFloorSeq: 9,
          contentHash: "seq-below",
        }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          decayFloorAt: farPast,
          decayFloorSeq: 11,
          contentHash: "seq-above",
        }),
      );
      // ⭐ decayFloorSeq が NULL（この軸に床が無い）は沈まない（ADR 0165 決めたこと4）
      // ——壁時計では沈んでいるのに、である。軸を取り違えた実装はここで赤くなる。
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          decayFloorAt: farPast,
          decayFloorSeq: null,
          contentHash: "seq-null",
        }),
      );

      const aggregate = await store.aggregateScope(ctx, { decayFloorSeqAfter: 10 });
      expect(aggregate.filteredDecayed.count).toBe(2);
      expect(aggregate.filteredDecayed.countKind).toBe("exact");
      expect(aggregate.totalInScope).toBe(4);
    });

    it("⭐ decayFloorAnyAxis: true は2軸の OR（どちらかが生きていれば沈まない。'either' の4象限）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const alivePast = new Date(DECAY_AT.getTime() + 1000);
      const deadPast = new Date(DECAY_AT.getTime() - 1000);
      // (壁=生, 活=生) / (壁=生, 活=死) / (壁=死, 活=生) / (壁=死, 活=死)
      const quadrants: [string, Date, number][] = [
        ["alive-alive", alivePast, 11],
        ["alive-dead", alivePast, 9],
        ["dead-alive", deadPast, 11],
        ["dead-dead", deadPast, 9],
      ];
      for (const [name, decayFloorAt, decayFloorSeq] of quadrants) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            decayFloorAt,
            decayFloorSeq,
            contentHash: name,
          }),
        );
      }

      // OR（'either'）: 両方沈んだ1件だけが数えられる。
      const either = await store.aggregateScope(ctx, {
        decayFloorAtAfter: DECAY_AT,
        decayFloorSeqAfter: 10,
        decayFloorAnyAxis: true,
      });
      expect(either.filteredDecayed.count).toBe(1);

      // ⚠ 対照: `decayFloorAnyAxis` を渡さなければ AND（両軸とも生きていなければ沈む）
      // ——`vector-store.ts` が2条件を AND で積むのと同じ。**AND/OR を取り違えた実装は
      // この2つの期待値が入れ替わる。**
      const both = await store.aggregateScope(ctx, {
        decayFloorAtAfter: DECAY_AT,
        decayFloorSeqAfter: 10,
      });
      expect(both.filteredDecayed.count).toBe(3);
      expect(either.totalInScope).toBe(4);
      expect(both.totalInScope).toBe(4);
    });

    it("⭐ filteredDecayed は scope に従う: subjectId / period で絞ると、その中の減衰件数だけを数える", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const decayed = new Date(DECAY_AT.getTime() - 1000);
      const inPeriod = new Date("2026-03-01T00:00:00.000Z");
      const outOfPeriod = new Date("2025-03-01T00:00:00.000Z");
      // alice: 期間内に2件、期間外に1件（いずれも減衰済み）。bob: 期間内に1件（減衰済み）。
      for (const [subjectId, occurredAt, hash] of [
        ["alice", inPeriod, "alice-in-1"],
        ["alice", inPeriod, "alice-in-2"],
        ["alice", outOfPeriod, "alice-out"],
        ["bob", inPeriod, "bob-in"],
      ] as [string, Date, string][]) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            subjectId,
            occurredAt,
            decayFloorAt: decayed,
            contentHash: hash,
          }),
        );
      }

      const wholeTenant = await store.aggregateScope(ctx, { decayFloorAtAfter: DECAY_AT });
      expect(wholeTenant.filteredDecayed.count).toBe(4);

      const bySubject = await store.aggregateScope(ctx, {
        subjectId: "alice",
        decayFloorAtAfter: DECAY_AT,
      });
      expect(bySubject.filteredDecayed.count).toBe(3);

      const byPeriod = await store.aggregateScope(ctx, {
        occurredAfter: new Date("2026-01-01T00:00:00.000Z"),
        decayFloorAtAfter: DECAY_AT,
      });
      expect(byPeriod.filteredDecayed.count).toBe(3);
      expect(byPeriod.filteredPeriod.count).toBe(1);

      const both = await store.aggregateScope(ctx, {
        subjectId: "alice",
        occurredAfter: new Date("2026-01-01T00:00:00.000Z"),
        decayFloorAtAfter: DECAY_AT,
      });
      expect(both.filteredDecayed.count).toBe(2);
      expect(both.totalInScope).toBe(2);
    });

    it("⚠ filteredDecayed は scope の外（archived / period 外 / expired）を数えない——二重計上しない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const decayed = new Date(DECAY_AT.getTime() - 1000);
      const archived = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          decayFloorAt: decayed,
          contentHash: "archived-and-decayed",
        }),
      );
      await store.updateStatus(ctx, archived.id, "archived");
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          decayFloorAt: decayed,
          validUntil: new Date(DECAY_AT.getTime() - 5000),
          contentHash: "expired-and-decayed",
        }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          decayFloorAt: decayed,
          contentHash: "plain-decayed",
        }),
      );

      const aggregate = await store.aggregateScope(ctx, {
        validAt: DECAY_AT,
        decayFloorAtAfter: DECAY_AT,
      });
      // archived と expired は既に別の札で名乗っている——`decayed` にも数えると
      // 呼び出し側から見て同じ Memory が2回落ちたことになる。
      expect(aggregate.filteredArchived.count).toBe(1);
      expect(aggregate.filteredExpired.count).toBe(1);
      expect(aggregate.filteredDecayed.count).toBe(1);
      expect(aggregate.totalInScope).toBe(1);
    });

    // -------------------------------------------------------------------
    // ⭐ 被覆の算術（Issue #352 / ADR 0174）
    //
    // `FilteredOmission.condition` は2群に分かれる——(甲) スコープを定義するゲートで
    // 落ちた＝`totalInScope` の**外**（`scopeRelation: "outside_scope"`。
    // archived/superseded/forgotten/period/expired/not_yet_valid）と、
    // (乙) スコープ内に居るまま到達しなかった＝`totalInScope` の**内**
    // （`scopeRelation: "within_scope"`。decayed）。
    //
    // **2群を名乗るだけでは、札と実際の数え方がずれても誰も気づかない。**
    // 型（`FILTERED_CONDITION_SCOPE_RELATION`）が「decayed は within_scope」と
    // 名乗っていても、`aggregateScope` の実装が実際にそう数えているかは別の検査を
    // 要る——ここではその**算術**を、既知の内訳を持つ fixture で検査する:
    //
    //   1. (乙) within_scope の filtered 件数は `totalInScope` の**部分集合**である
    //      （`count <= totalInScope`、かつ引くと実際に返りうる件数になる）。
    //   2. テナント内の全件数 = `totalInScope` + Σ(`outside_scope` の filtered 件数)。
    //
    // 各群を1件以上踏ませる（スコープ内で減衰していないもの5件・減衰しきったもの4件・
    // expired 3件・archived 2件・superseded/forgotten/period/not_yet_valid 各1件）。
    // -------------------------------------------------------------------

    it("⭐ 被覆の算術: within_scope(decayed) は totalInScope の部分集合、outside_scope の総和 + totalInScope = テナント全件数", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const decayGate = new Date("2026-06-01T00:00:00.000Z");
      const validAt = new Date("2026-06-01T00:00:00.000Z");
      const periodCutoff = new Date("2026-01-01T00:00:00.000Z");
      const inPeriod = new Date("2026-03-01T00:00:00.000Z");

      // (甲) outside_scope 群 — スコープを定義するゲートで落ちる。
      const ARCHIVED_N = 2;
      for (let i = 0; i < ARCHIVED_N; i += 1) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            status: "archived",
            occurredAt: inPeriod,
            contentHash: `coverage-archived-${i}`,
          }),
        );
      }
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          status: "superseded",
          occurredAt: inPeriod,
          contentHash: "coverage-superseded",
        }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          status: "forgotten",
          occurredAt: inPeriod,
          contentHash: "coverage-forgotten",
        }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          occurredAt: new Date("2020-01-01T00:00:00.000Z"), // periodCutoff より前 ⟹ 外
          contentHash: "coverage-period",
        }),
      );
      const EXPIRED_N = 3;
      for (let i = 0; i < EXPIRED_N; i += 1) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            occurredAt: inPeriod,
            validUntil: new Date(validAt.getTime() - 1000),
            contentHash: `coverage-expired-${i}`,
          }),
        );
      }
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          occurredAt: inPeriod,
          validFrom: new Date(validAt.getTime() + 1000),
          contentHash: "coverage-not-yet-valid",
        }),
      );

      // (乙) within_scope 群 — スコープ内に居るまま、到達しにくさ（decayed）で落ちる。
      const DECAYED_N = 4;
      for (let i = 0; i < DECAYED_N; i += 1) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            occurredAt: inPeriod,
            decayFloorAt: new Date(decayGate.getTime() - 1000),
            contentHash: `coverage-decayed-${i}`,
          }),
        );
      }
      // スコープ内で、減衰していない（まだ生きている）記憶。
      const ALIVE_N = 5;
      for (let i = 0; i < ALIVE_N; i += 1) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            occurredAt: inPeriod,
            decayFloorAt: new Date(decayGate.getTime() + 1000),
            contentHash: `coverage-alive-${i}`,
          }),
        );
      }

      const TOTAL_CREATED =
        ARCHIVED_N +
        1 /* superseded */ +
        1 /* forgotten */ +
        1 /* period */ +
        EXPIRED_N +
        1 /* not_yet_valid */ +
        DECAYED_N +
        ALIVE_N; // = 18

      const aggregate = await store.aggregateScope(ctx, {
        occurredAfter: periodCutoff,
        validAt,
        decayFloorAtAfter: decayGate,
      });

      // 前提: 各群が実際に1件以上踏まれていること（fixture がずれていないことの検算）。
      expect(aggregate.filteredArchived.count).toBe(ARCHIVED_N);
      expect(aggregate.filteredSuperseded.count).toBe(1);
      expect(aggregate.filteredForgotten.count).toBe(1);
      expect(aggregate.filteredPeriod.count).toBe(1);
      expect(aggregate.filteredExpired.count).toBe(EXPIRED_N);
      expect(aggregate.filteredNotYetValid.count).toBe(1);
      expect(aggregate.filteredDecayed.count).toBe(DECAYED_N);
      expect(aggregate.totalInScope).toBe(DECAYED_N + ALIVE_N);

      // --- 1. (乙) within_scope: filteredDecayed は totalInScope の部分集合 ---
      expect(FILTERED_CONDITION_SCOPE_RELATION.decayed).toBe("within_scope");
      expect(aggregate.filteredDecayed.count).toBeLessThanOrEqual(aggregate.totalInScope);
      // 引くと、実際に返りうる件数（=生きている記憶の件数）になる。
      const aliveInScope = aggregate.totalInScope - aggregate.filteredDecayed.count;
      expect(aliveInScope).toBe(ALIVE_N);

      // --- 2. (甲) outside_scope: totalInScope + Σ(outside_scope の filtered 件数) = 全件数 ---
      const OUTSIDE_SCOPE_COUNTS: Record<
        "archived" | "superseded" | "forgotten" | "period" | "expired" | "not_yet_valid",
        number
      > = {
        archived: aggregate.filteredArchived.count,
        superseded: aggregate.filteredSuperseded.count,
        forgotten: aggregate.filteredForgotten.count,
        period: aggregate.filteredPeriod.count,
        expired: aggregate.filteredExpired.count,
        not_yet_valid: aggregate.filteredNotYetValid.count,
      };
      for (const condition of Object.keys(
        OUTSIDE_SCOPE_COUNTS,
      ) as (keyof typeof OUTSIDE_SCOPE_COUNTS)[]) {
        // この等式は、各 condition が実際に "outside_scope" を名乗っている前提の上でだけ成り立つ
        // ——`FILTERED_CONDITION_SCOPE_RELATION` の値を1つでも取り違えると、この前提が崩れる
        // ことをまず固定してから、和を取る。
        expect(FILTERED_CONDITION_SCOPE_RELATION[condition]).toBe("outside_scope");
      }
      const outsideScopeTotal = Object.values(OUTSIDE_SCOPE_COUNTS).reduce(
        (sum, count) => sum + count,
        0,
      );
      expect(aggregate.totalInScope + outsideScopeTotal).toBe(TOTAL_CREATED);
    });

    it("aggregateScope は notIndexed を理由ごと（pending/failed/skipped）に分けて数え、totalInScope からは除かない", async () => {
      // 各理由の件数を**すべて異なる数**にする。同数だと、理由の取り違え
      // （例: failed を数えるべきところで skipped を数える）が起きても
      // 値が偶然一致して検出できない。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const counts = { pending: 1, failed: 2, skipped: 3, ready: 4 } as const;
      for (const [embeddingStatus, n] of Object.entries(counts)) {
        for (let i = 0; i < n; i += 1) {
          await store.createMemory(
            ctx,
            buildNewMemoryFixture({
              tenantId: "tenant-1",
              embeddingStatus: embeddingStatus as EmbeddingStatus,
            }),
          );
        }
      }

      const aggregate = await store.aggregateScope(ctx, {});
      // 索引に載っていないものも in-scope である（目次帯には現れる）。
      expect(aggregate.totalInScope).toBe(10);
      expect(aggregate.notIndexed.pending.count).toBe(1);
      expect(aggregate.notIndexed.failed.count).toBe(2);
      expect(aggregate.notIndexed.skipped.count).toBe(3);
    });

    // -------------------------------------------------------------------
    // aggregateScope の digestBand（ADR 0073 決定7、目次帯・第2階）
    //
    // `opts.digestBand` を渡したときの `ScopeAggregate.digests`/`digestEligible` を検査する。
    // `PostgresMemoryStore`・`InMemoryMemoryStore` の両方にこの歯が当たる（`packages/core` の
    // `FakeMemoryStore` は `packages/testkit` に依存できないため、この適合テストは届かない
    // ——別途 `packages/core/src/__tests__/*.ts` の歯で検査されているはず）。
    // -------------------------------------------------------------------

    it("aggregateScope の digestBand: excludeMemoryIds に渡した id は digests に含まれない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const excluded = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "digest-band-exclude-1" }),
      );
      const kept = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "digest-band-exclude-2" }),
      );

      const aggregate = await store.aggregateScope(
        ctx,
        {},
        {
          digestBand: { limit: 10, excludeMemoryIds: [excluded.id] },
        },
      );
      const ids = aggregate.digests.map((d) => d.memoryId);
      expect(ids).not.toContain(excluded.id);
      expect(ids).toContain(kept.id);
    });

    it("aggregateScope の digestBand: digestEligible.count はスコープ内かつ除外されていないものの総数と一致する（limit を小さくしても減らない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const TOTAL = 5;
      for (let i = 0; i < TOTAL; i += 1) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: `digest-band-eligible-${i}` }),
        );
      }

      const withHighLimit = await store.aggregateScope(
        ctx,
        {},
        {
          digestBand: { limit: 100, excludeMemoryIds: [] },
        },
      );
      expect(withHighLimit.digestEligible.count).toBe(TOTAL);
      expect(withHighLimit.digestEligible.countKind).toBe("exact");

      const withLowLimit = await store.aggregateScope(
        ctx,
        {},
        {
          digestBand: { limit: 2, excludeMemoryIds: [] },
        },
      );
      // limit を小さくしても digestEligible.count は減らない——limit を掛ける前の件数だから。
      expect(withLowLimit.digestEligible.count).toBe(TOTAL);
    });

    it("aggregateScope の digestBand: digests.length は limit を超えない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const LIMIT = 2;
      for (let i = 0; i < 5; i += 1) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: `digest-band-limit-${i}` }),
        );
      }

      const aggregate = await store.aggregateScope(
        ctx,
        {},
        {
          digestBand: { limit: LIMIT, excludeMemoryIds: [] },
        },
      );
      expect(aggregate.digests.length).toBeLessThanOrEqual(LIMIT);
      expect(aggregate.digests).toHaveLength(LIMIT);
    });

    it("aggregateScope の digestBand: digests.length は digestEligible.count を超えない（excludeMemoryIds で候補を絞り、limit では律速しない非自明な入力）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const TOTAL = 5;
      const createdIds: MemoryId[] = [];
      for (let i = 0; i < TOTAL; i += 1) {
        const memory = await store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contentHash: `digest-band-eligible-vs-count-${i}`,
          }),
        );
        createdIds.push(memory.id);
      }
      // 何件か除外することで digestEligible.count をスコープ内総数（TOTAL）より小さくする
      // ——既存の歯（digestEligible.count === TOTAL）と重ならない、非自明な入力にするため。
      const excluded = createdIds.slice(0, 2);

      const aggregate = await store.aggregateScope(
        ctx,
        {},
        {
          // limit は候補数より大きく取る——digests.length <= limit（既存の歯）に寄りかからず、
          // digests.length <= digestEligible.count を独立に検査するため。
          digestBand: { limit: 100, excludeMemoryIds: excluded },
        },
      );

      expect(aggregate.digestEligible.count).toBe(TOTAL - excluded.length);
      expect(aggregate.digests.length).toBeLessThanOrEqual(aggregate.digestEligible.count);
    });

    it("aggregateScope の digestBand: (occurredAt ?? recordedAt) の降順に並ぶ（occurredAt が null の行を含む）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const older = new Date("2020-01-01T00:00:00.000Z");
      const middle = new Date("2026-01-01T00:00:00.000Z");
      const newest = new Date("2026-06-01T00:00:00.000Z");

      const mOld = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          occurredAt: older,
          contentHash: "digest-band-order-old",
        }),
      );
      // occurredAt が null の行——recordedAt (middle) が実効時刻として使われるはず。
      const mNullOccurred = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          occurredAt: null,
          recordedAt: middle,
          contentHash: "digest-band-order-null-occurred",
        }),
      );
      const mNewest = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          occurredAt: newest,
          contentHash: "digest-band-order-newest",
        }),
      );

      const aggregate = await store.aggregateScope(
        ctx,
        {},
        {
          digestBand: { limit: 10, excludeMemoryIds: [] },
        },
      );
      expect(aggregate.digests.map((d) => d.memoryId)).toEqual([
        mNewest.id,
        mNullOccurred.id,
        mOld.id,
      ]);
    });

    it("aggregateScope の digestBand: 同値のときは id の降順で決定的に並ぶ", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const same = new Date("2026-03-01T00:00:00.000Z");
      const m1 = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          occurredAt: same,
          contentHash: "digest-band-tie-1",
        }),
      );
      const m2 = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          occurredAt: same,
          contentHash: "digest-band-tie-2",
        }),
      );

      const expectedOrder = [m1.id, m2.id].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

      const aggregate = await store.aggregateScope(
        ctx,
        {},
        {
          digestBand: { limit: 10, excludeMemoryIds: [] },
        },
      );
      expect(aggregate.digests.map((d) => d.memoryId)).toEqual(expectedOrder);
    });

    it("aggregateScope の digestBand: archived/superseded/forgotten の Memory は digests にも digestEligible にも乗らない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const active = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          status: "active",
          contentHash: "digest-band-status-active",
        }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          status: "archived",
          contentHash: "digest-band-status-archived",
        }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          status: "superseded",
          contentHash: "digest-band-status-superseded",
        }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          status: "forgotten",
          contentHash: "digest-band-status-forgotten",
        }),
      );

      const aggregate = await store.aggregateScope(
        ctx,
        {},
        {
          digestBand: { limit: 10, excludeMemoryIds: [] },
        },
      );
      expect(aggregate.digests.map((d) => d.memoryId)).toEqual([active.id]);
      expect(aggregate.digestEligible.count).toBe(1);
    });

    it("aggregateScope の digestBand: period の外の Memory は digests にも digestEligible にも乗らない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const inside = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          occurredAt: PERIOD_AFTER_CUTOFF,
          contentHash: "digest-band-period-inside",
        }),
      );
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          occurredAt: PERIOD_BEFORE_CUTOFF,
          contentHash: "digest-band-period-outside",
        }),
      );

      const aggregate = await store.aggregateScope(
        ctx,
        { occurredAfter: PERIOD_CUTOFF },
        { digestBand: { limit: 10, excludeMemoryIds: [] } },
      );
      expect(aggregate.digests.map((d) => d.memoryId)).toEqual([inside.id]);
      expect(aggregate.digestEligible.count).toBe(1);
    });

    it("aggregateScope の digestBand: opts を渡さなければ digests は空・digestEligible.count は0", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "digest-band-no-opts" }),
      );

      const aggregate = await store.aggregateScope(ctx, {});
      expect(aggregate.digests).toEqual([]);
      expect(aggregate.digestEligible).toEqual({ count: 0, countKind: "exact" });
    });

    it("aggregateScope の digestBand: embedding_status が ready でない Memory も帯に乗る（スコープ内だから）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const pending = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          embeddingStatus: "pending",
          contentHash: "digest-band-embed-pending",
        }),
      );
      const failed = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          embeddingStatus: "failed",
          contentHash: "digest-band-embed-failed",
        }),
      );
      const skipped = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          embeddingStatus: "skipped",
          contentHash: "digest-band-embed-skipped",
        }),
      );
      const ready = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          embeddingStatus: "ready",
          contentHash: "digest-band-embed-ready",
        }),
      );

      const aggregate = await store.aggregateScope(
        ctx,
        {},
        {
          digestBand: { limit: 10, excludeMemoryIds: [] },
        },
      );
      const ids = aggregate.digests.map((d) => d.memoryId);
      expect(ids).toContain(pending.id);
      expect(ids).toContain(failed.id);
      expect(ids).toContain(skipped.id);
      expect(ids).toContain(ready.id);
      expect(aggregate.digestEligible.count).toBe(4);
    });

    it("aggregateScope の digestBand: 別テナントの Memory は乗らない", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      await store.createMemory(
        ctxA,
        buildNewMemoryFixture({ tenantId: "tenant-a", contentHash: "digest-band-tenant-a" }),
      );
      const memoryB = await store.createMemory(
        ctxB,
        buildNewMemoryFixture({ tenantId: "tenant-b", contentHash: "digest-band-tenant-b" }),
      );

      const aggregateB = await store.aggregateScope(
        ctxB,
        {},
        {
          digestBand: { limit: 10, excludeMemoryIds: [] },
        },
      );
      expect(aggregateB.digests.map((d) => d.memoryId)).toEqual([memoryB.id]);
      expect(aggregateB.digestEligible.count).toBe(1);
    });

    // -------------------------------------------------------------------
    // createRecall（recall 段6「記録」。docs/recall.md §2 段6、ADR 0008）
    // -------------------------------------------------------------------

    it("createRecall は recallId を発行する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const recallId = await store.createRecall(ctx, {
        tenantId: "tenant-1",
        subjectId: null,
        query: { text: "hello" },
        budget: null,
        omitted: [],
        usage: {
          chars: 0,
          estimatedTokens: 0,
          counter: "heuristic",
          byTier: { full: 0, digest: 0, index: 0 },
          indexChars: 0,
        },
        indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
        explain: { stages: [] },
        returnedMemories: [],
      });
      expect(typeof recallId).toBe("string");
      expect(recallId.length).toBeGreaterThan(0);
    });

    // -------------------------------------------------------------------
    // getRecall（Issue #298 / ADR 0155: createRecall と対になる読む口）
    // -------------------------------------------------------------------

    it("getRecall は createRecall が書いた行を、内訳つきで読み戻す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "hash-get-recall-1" }),
      );
      const companion = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "hash-get-recall-2" }),
      );

      const recallId = await store.createRecall(ctx, {
        tenantId: "tenant-1",
        subjectId: "subject-1",
        query: { text: "hello" },
        budget: { maxMemoryChars: 1000 },
        omitted: [],
        usage: {
          chars: 12,
          estimatedTokens: 3,
          counter: "heuristic",
          byTier: { full: 1, digest: 0, index: 0 },
          indexChars: 0,
        },
        indexBand: { groups: [], totalInScope: 1, countKind: "exact" },
        explain: { stages: [] },
        returnedMemories: [
          {
            memoryId: memory.id,
            score: {
              similarity: 0.9,
              decay: 1,
              tagMatch: 0,
              freshness: 1,
              strength: 1,
              total: 0.9,
            },
            retrievedVia: "ann",
          },
          {
            memoryId: companion.id,
            score: {
              decay: 1,
              tagMatch: 0,
              freshness: 1,
              strength: 1,
              total: 0,
            },
            retrievedVia: "mandatory_companion",
            companionOf: memory.id,
          },
        ],
      });

      const recall = await store.getRecall(ctx, recallId);
      expect(recall).not.toBeNull();
      expect(recall?.recallId).toBe(recallId);
      expect(recall?.tenantId).toBe("tenant-1");
      expect(recall?.subjectId).toBe("subject-1");
      expect(recall?.returnedMemories.breakdownCaptured).toBe(true);
      expect(recall?.returnedMemories.memories).toEqual([
        {
          memoryId: memory.id,
          score: { similarity: 0.9, decay: 1, tagMatch: 0, freshness: 1, strength: 1, total: 0.9 },
          retrievedVia: "ann",
        },
        {
          memoryId: companion.id,
          score: { decay: 1, tagMatch: 0, freshness: 1, strength: 1, total: 0 },
          retrievedVia: "mandatory_companion",
          companionOf: memory.id,
        },
      ]);
      expect(recall?.createdAt).toBeInstanceOf(Date);
    });

    it("getRecall は存在しない recallId に対して null を返す（例外にしない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.getRecall(ctx, randomUUID())).resolves.toBeNull();
    });

    it("getRecall は別テナントの recallId に対して null を返す（tenant scoping、ADR 0007）", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const recallId = await store.createRecall(ctxA, {
        tenantId: "tenant-a",
        subjectId: null,
        query: { text: "hello" },
        budget: null,
        omitted: [],
        usage: {
          chars: 0,
          estimatedTokens: 0,
          counter: "heuristic",
          byTier: { full: 0, digest: 0, index: 0 },
          indexChars: 0,
        },
        indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
        explain: { stages: [] },
        returnedMemories: [],
      });
      await expect(store.getRecall(ctxB, recallId)).resolves.toBeNull();
    });

    it("getRecall は0件しか返さなかった recall を { breakdownCaptured: true, memories: [] } として読み戻す（ADR 0008 の族: 「無い」と「空」を同じ顔にしない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const recallId = await store.createRecall(ctx, {
        tenantId: "tenant-1",
        subjectId: null,
        query: { text: "hello" },
        budget: null,
        omitted: [],
        usage: {
          chars: 0,
          estimatedTokens: 0,
          counter: "heuristic",
          byTier: { full: 0, digest: 0, index: 0 },
          indexChars: 0,
        },
        indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
        explain: { stages: [] },
        returnedMemories: [],
      });
      const recall = await store.getRecall(ctx, recallId);
      expect(recall?.returnedMemories).toEqual({ breakdownCaptured: true, memories: [] });
    });

    // -------------------------------------------------------------------
    // 外部キー相当（ADR 0047）: `memories.source_observation_id` /
    // `superseded_by_id` / `contested_with_id` → 実在する行への参照、
    // `recall_usages.recall_id`/`memory_id` → 実在する行への参照。
    //
    // `packages/postgres/migrations/0001_init.sql` が実際に持つ外部キーであり、
    // Postgres は既にこれを制約として強制している。ここで検査するのは
    // 「in-memory 実装も同じ非対称を強制すること」——**存在だけ**を見る（一対一等の
    // 整合までは踏み込まない、ADR 0047「線を引いた場所」）。
    //
    // ⚠ すべて非対称: 「実在しない参照では失敗する」と「実在する参照では成功する」を
    // 同じ検査の中で見る。片方だけだと「常に失敗する」実装／「常に無視する」実装の
    // どちらかを緑にしてしまう。
    //
    // ⚠ `.rejects.toThrow()` を引数なしで使っている。Postgres 側はドライバの外部キー
    // 違反（`code: '23503'`、`packages/postgres/src/__tests__/foreign-key-violation.
    // postgres.test.ts` が識別できる印まで検査する）、in-memory 側はこのリポジトリが
    // 書いた `Error` であり、メッセージの文言を1つに揃える理由が無い
    // （`packages/postgres` は Postgres 自身の文言をそのまま漏らす設計——ADR 0047
    // 「Postgres 側は変更しない」）。ここで測りたいのは「存在しない参照を渡すと必ず失敗し、
    // 実在する参照では必ず成功する」という一点であり、メッセージの一致ではない。
    // -------------------------------------------------------------------

    it("createMemory は実在しない sourceObservationId に対して失敗し、実在する observation では成功する（外部キー、ADR 0047）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      await expect(
        store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            sourceObservationId: randomUUID(),
            contentHash: "hash-fk-source-observation-missing",
          }),
        ),
      ).rejects.toThrow();

      const observation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: "tenant-1" }),
      );
      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          sourceObservationId: observation.id,
          contentHash: "hash-fk-source-observation-ok",
        }),
      );
      expect(created.sourceObservationId).toBe(observation.id);
    });

    it("createMemory は実在しない supersededById に対して失敗し、実在する Memory では成功する（外部キー、ADR 0047）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      await expect(
        store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            supersededById: randomUUID(),
            contentHash: "hash-fk-superseded-by-missing",
          }),
        ),
      ).rejects.toThrow();

      const target = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          contentHash: "hash-fk-superseded-by-target",
        }),
      );
      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          supersededById: target.id,
          contentHash: "hash-fk-superseded-by-ok",
        }),
      );
      expect(created.supersededById).toBe(target.id);
    });

    it("createMemory は実在しない contestedWithId に対して失敗し、実在する Memory では成功する（外部キー、ADR 0047）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      await expect(
        store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: "tenant-1",
            contestedWithId: randomUUID(),
            contentHash: "hash-fk-contested-with-missing",
          }),
        ),
      ).rejects.toThrow();

      const target = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          contentHash: "hash-fk-contested-with-target",
        }),
      );
      const created = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          contestedWithId: target.id,
          contentHash: "hash-fk-contested-with-ok",
        }),
      );
      expect(created.contestedWithId).toBe(target.id);
    });

    it("updateStatus は実在しない supersededById に対して失敗し、実在する Memory では成功する（外部キー、ADR 0047）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));

      await expect(
        store.updateStatus(ctx, memory.id, "superseded", { supersededById: randomUUID() }),
      ).rejects.toThrow();

      const target = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          contentHash: "hash-fk-update-status-superseded-by-target",
        }),
      );
      const updated = await store.updateStatus(ctx, memory.id, "superseded", {
        supersededById: target.id,
      });
      expect(updated.supersededById).toBe(target.id);
    });

    it("updateStatusWithEvent は実在しない supersededById に対して失敗し、実在する Memory では成功する（外部キー、ADR 0047）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));

      await expect(
        store.updateStatusWithEvent(
          ctx,
          memory.id,
          "superseded",
          { supersededById: randomUUID() },
          buildSupersedeEvent(ctx, memory.id, memory.digest),
        ),
      ).rejects.toThrow();

      const target = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: "tenant-1",
          contentHash: "hash-fk-update-status-with-event-superseded-by-target",
        }),
      );
      const { memory: updated } = await store.updateStatusWithEvent(
        ctx,
        memory.id,
        "superseded",
        { supersededById: target.id },
        buildSupersedeEvent(ctx, memory.id, memory.digest),
      );
      expect(updated.supersededById).toBe(target.id);
    });

    it("recordUsage は実在しない recallId に対して失敗し、実在する recallId では成功する（外部キー、ADR 0047）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));

      await expect(store.recordUsage(ctx, randomUUID(), [memory.id])).rejects.toThrow();

      const recallId = await prepareRecallId(ctx);
      const result = await store.recordUsage(ctx, recallId, [memory.id]);
      expect(result.insertedMemoryIds).toEqual([memory.id]);
    });

    it("recordUsage は実在しない memoryId を含むと全体が失敗し、実在する memoryId だけなら成功する（外部キー、ADR 0047）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      const recallId = await prepareRecallId(ctx);

      // ⚠ 実在する id と実在しない id を混ぜる。全体が失敗し、実在するほうも
      // 部分的に挿入されないことまでは、このテストでは踏み込まない
      // （「存在」だけを見る、ADR 0047の線）。
      await expect(store.recordUsage(ctx, recallId, [memory.id, randomUUID()])).rejects.toThrow();

      const result = await store.recordUsage(ctx, recallId, [memory.id]);
      expect(result.insertedMemoryIds).toEqual([memory.id]);
    });

    // -------------------------------------------------------------------
    // requeueEmbedJobs（ADR 0079: 索引に載っていない Memory を積み直す）
    //
    // ここで検査するのは「`embeddingStatus` が `pending` に戻ったか」ではなく
    // **「もう一度処理されるようになったか」**である——だから毎回
    // `claimEmbedJobs` まで見る（`claimEmbedJobs` の doc コメント参照）。
    // -------------------------------------------------------------------

    /**
     * 🔴 **`new Date()` をそのまま `now` に渡さないこと。**
     *
     * `claimBatch` は `available_at <= now` で絞る。`requeueEmbedJobs` が積んだ行の
     * `available_at` は **DB 側の `now()`（マイクロ秒精度）**で書かれるのに対し、
     * JavaScript の `Date` は**ミリ秒までしか持たない**——同じミリ秒の中で
     * `available_at = 12:00:00.123456`、`new Date()` = `12:00:00.123`（切り捨て）に
     * なると、**積んだばかりの行が `available_at <= now` を満たさず claim できない。**
     *
     * ⚠ **これは実際に CI で踏んだ。**同じ検査が `packages/postgres` のジョブでは緑、
     * ルートの test 門の DB 段では赤という**割れ方**をした（ADR 0079「測ったこと」）。
     * ミリ秒の端数次第で結果が変わるので、**再実行すれば直るように見える種類の赤**である。
     *
     * ⟹ 少しだけ未来を渡す。`leaseMs`（60秒）よりずっと小さいので、**既に claim 済みの
     * 行がリース切れとして再取得されることはない**（`claimed_at <= now - leaseMs` は
     * 成立しない）。
     */
    const CLAIM_NOW_SKEW_MS = 1_000;

    async function claimedMemoryIds(ctx: Ctx): Promise<unknown[]> {
      const jobs = await claimEmbedJobs(ctx, new Date(Date.now() + CLAIM_NOW_SKEW_MS));
      return jobs.map((job) => job.payload.memoryId);
    }

    it("requeueEmbedJobs は failed の Memory を pending へ戻し、運搬役が claim できる embed ジョブを積む", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      await store.setEmbeddingStatus(ctx, memory.id, "failed");

      // 前提: この時点で claim できる embed ジョブは無い（`createMemory` は outbox に
      // 積まない＝「失敗が終端に達し、運ぶものが何も残っていない」状態と同じ形）。
      expect(await claimedMemoryIds(ctx)).toEqual([]);

      const result = await store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 10 });

      // ⚠ 3つを1つの `toEqual` に並べる。分けて書くと、片方（outbox への INSERT）を
      // 落とした変異が「pending には戻っている」だけで緑になりうる。
      expect({
        requeued: result.requeued,
        requeuedIds: result.memoryIds,
        embeddingStatus: (await store.get(ctx, memory.id))?.embeddingStatus,
        claimable: await claimedMemoryIds(ctx),
      }).toEqual({
        requeued: 1,
        requeuedIds: [memory.id],
        embeddingStatus: "pending",
        claimable: [memory.id],
      });
    });

    it("requeueEmbedJobs は pending の Memory も積み直せる（待っても解けない pending が在りうるため、ADR 0079）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      // `runtime.tick` の `processEmbedJob` は `memoryStore.get` を `try` の外で呼び、
      // `catch` の中の `setEmbeddingStatus(..., 'failed')` 自体も例外を投げうる。
      // どちらを通っても **outbox 行だけが終端になり、Memory は `pending` のまま**
      // 残る——`recall` はその行を `notIndexed.pending`（＝「待て」）として数え続ける。
      // ⚠ この状況が実際に発生することは観測していない（ADR 0079「確かめていないこと」）。
      // ここで作っているのは、その状態と**同じ形**（pending・claim できるジョブ無し）である。
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", embeddingStatus: "pending" }),
      );
      expect(await claimedMemoryIds(ctx)).toEqual([]);

      const result = await store.requeueEmbedJobs(ctx, { statuses: ["pending"], limit: 10 });

      expect({
        requeued: result.requeued,
        embeddingStatus: (await store.get(ctx, memory.id))?.embeddingStatus,
        claimable: await claimedMemoryIds(ctx),
      }).toEqual({
        requeued: 1,
        embeddingStatus: "pending",
        claimable: [memory.id],
      });
    });

    it("requeueEmbedJobs は statuses に無い embeddingStatus を対象にしない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const pendingMemory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "requeue-status-pending" }),
      );
      const readyMemory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "requeue-status-ready" }),
      );
      await store.setEmbeddingStatus(ctx, readyMemory.id, "ready");

      // `failed` だけを対象にする。`pending` も `ready` も残る。
      const result = await store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 10 });

      expect({
        requeued: result.requeued,
        pendingUntouched: (await store.get(ctx, pendingMemory.id))?.embeddingStatus,
        readyUntouched: (await store.get(ctx, readyMemory.id))?.embeddingStatus,
        claimable: await claimedMemoryIds(ctx),
      }).toEqual({
        requeued: 0,
        pendingUntouched: "pending",
        readyUntouched: "ready",
        claimable: [],
      });
    });

    it("requeueEmbedJobs は memoryIds で対象を絞れるが、statuses の条件は外れない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const failedMemory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "requeue-ids-failed" }),
      );
      const readyMemory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "requeue-ids-ready" }),
      );
      await store.setEmbeddingStatus(ctx, failedMemory.id, "failed");
      await store.setEmbeddingStatus(ctx, readyMemory.id, "ready");

      // `ready` の行を名指ししても対象にならない（積は取るが `statuses` は外れない）。
      const result = await store.requeueEmbedJobs(ctx, {
        statuses: ["failed"],
        memoryIds: [readyMemory.id],
        limit: 10,
      });

      expect({
        requeued: result.requeued,
        readyUntouched: (await store.get(ctx, readyMemory.id))?.embeddingStatus,
        claimable: await claimedMemoryIds(ctx),
      }).toEqual({ requeued: 0, readyUntouched: "ready", claimable: [] });
    });

    it("requeueEmbedJobs は limit を超えて積み直さない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      for (const suffix of ["a", "b", "c"]) {
        const memory = await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: `requeue-limit-${suffix}` }),
        );
        await store.setEmbeddingStatus(ctx, memory.id, "failed");
      }

      const result = await store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 2 });

      // ⚠ `requeued` だけでなく「積まれたジョブの数」と「まだ failed のまま残った数」も
      // 並べる——`limit` を無視する変異は、返り値だけを見る歯では捕まえられない
      // （`requeued` を `Math.min(..., limit)` で作り直せば緑になりうる）。
      const allMemories = await store.getMany(ctx, result.memoryIds);
      const claimable = await claimedMemoryIds(ctx);
      expect({
        requeued: result.requeued,
        requeuedIdCount: result.memoryIds.length,
        claimableCount: claimable.length,
        allRequeuedArePending: allMemories.every((m) => m.embeddingStatus === "pending"),
        claimableMatchesRequeued: [...claimable].sort().join(","),
        requeuedSorted: [...result.memoryIds].sort().join(","),
      }).toEqual({
        requeued: 2,
        requeuedIdCount: 2,
        claimableCount: 2,
        allRequeuedArePending: true,
        claimableMatchesRequeued: [...result.memoryIds].sort().join(","),
        requeuedSorted: [...result.memoryIds].sort().join(","),
      });
    });

    it("requeueEmbedJobs は archived / superseded / forgotten を対象にしない（aggregateScope の notIndexed と同じ集合）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "requeue-archived" }),
      );
      await store.setEmbeddingStatus(ctx, memory.id, "failed");
      await store.updateStatus(ctx, memory.id, "archived");

      const result = await store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 10 });

      expect({ requeued: result.requeued, claimable: await claimedMemoryIds(ctx) }).toEqual({
        requeued: 0,
        claimable: [],
      });
    });

    it("requeueEmbedJobs は他テナントの Memory を積み直さない（docs/architecture.md §3.7）", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const memoryA = await store.createMemory(
        ctxA,
        buildNewMemoryFixture({ tenantId: "tenant-a" }),
      );
      await store.setEmbeddingStatus(ctxA, memoryA.id, "failed");

      const result = await store.requeueEmbedJobs(ctxB, { statuses: ["failed"], limit: 10 });

      expect({
        requeued: result.requeued,
        stillFailed: (await store.get(ctxA, memoryA.id))?.embeddingStatus,
        claimableInB: await claimedMemoryIds(ctxB),
      }).toEqual({ requeued: 0, stillFailed: "failed", claimableInB: [] });
    });

    it("requeueEmbedJobs は対象が0件でも例外を投げない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      const result = await store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 10 });
      expect(result).toEqual({ requeued: 0, memoryIds: [] });
    });

    it("requeueEmbedJobs は形式不正な memoryId だけを渡されたら 0 件で返す（getMany と同じ「静かに落とす」）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      await store.setEmbeddingStatus(ctx, memory.id, "failed");

      const result = await store.requeueEmbedJobs(ctx, {
        statuses: ["failed"],
        memoryIds: ["does-not-exist"],
        limit: 10,
      });

      expect({
        requeued: result.requeued,
        stillFailed: (await store.get(ctx, memory.id))?.embeddingStatus,
      }).toEqual({ requeued: 0, stillFailed: "failed" });
    });

    it("requeueEmbedJobs はべき等ではない——2回呼べば embed ジョブは2件積まれる（ADR 0079 の契約）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" }));
      await store.setEmbeddingStatus(ctx, memory.id, "failed");

      await store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: 10 });
      // 2回目は既に `pending` なので `statuses` に `pending` を含めて呼ぶ。
      await store.requeueEmbedJobs(ctx, { statuses: ["pending"], limit: 10 });

      const jobs = await claimEmbedJobs(ctx, new Date(Date.now() + CLAIM_NOW_SKEW_MS));
      expect(jobs.map((job) => job.payload.memoryId)).toEqual([memory.id, memory.id]);
    });
  });
}
