-- 0014_observations_valid_from_until.sql
--
-- Issue #280（Issue #202 第2弾）: `observations` に `valid_from`/`valid_until` を足す。
--
-- ## なぜ要るか
--
-- `Observation.validFrom`/`validUntil`（`@mnemora/core`）は `ObserveXxxInput.validFrom`/
-- `validUntil` を `occurredAt` と同じ経路で運ぶ（`packages/core/src/observation.ts` の
-- `Observation.validFrom` の doc コメント参照）。`occurredAt` が `observations.occurred_at`
-- 列を持つのと同じ理由——**`extract: 'deferred'` を選んだ場合、抽出は outbox 経由で
-- 後から `processExtractJob`（`runtime.ts`）が拾い、そこでは `MemoryStore.getObservation`
-- で DB から読み直した `Observation` しか手元に無い**（元の `ObserveXxxInput` はとうに
-- 捨てられている）。この列が無いと、deferred 抽出経路では `validFrom`/`validUntil` が
-- 消える。
--
-- ## `memories.valid_from`/`valid_until` との違い
--
-- `memories` 側は Phase 1 の時点（`0001_init.sql`）から既にこの2列を持っていた
-- （ADR 0145 参照）。`observations` 側は今回が初めての追加である——Phase 1 の設計時点で
-- `Observation` に相当欄を持たせる想定が無かった。

ALTER TABLE observations
  ADD COLUMN valid_from  timestamptz NULL,
  ADD COLUMN valid_until timestamptz NULL;
