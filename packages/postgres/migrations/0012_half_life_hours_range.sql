-- 0012_half_life_hours_range.sql
--
-- `halfLifeHours` に値域 `(0, ∞)`（有限の正の実数）を強制する（ADR 0125 / Issue #231）。
-- 対象は2列: `tenant_settings.default_half_life_hours` と `memories.half_life_hours`。
-- どちらも同じ意味の値であり、どちらも `defaultDecayStrategy` の割り算
-- `elapsedHours / halfLifeHours` に直接入る（`packages/core/src/strategies/decay.ts`）。
--
-- **なぜ `0` と負を弾くか。**`halfLifeHours` が `0` 付近・負だと、`decay` の式
-- `strength * 0.5 ** (elapsedHours / halfLifeHours)` の指数が発散し、`decay` が
-- `0` や `NaN`、あるいは `+Infinity` になる（`halfLifeHours` の符号と `elapsedHours` の
-- 符号の組み合わせで結果が変わる。詳細は `packages/core/src/interfaces/tenant-settings-store.ts`
-- の `isHalfLifeHoursInRange` の doc に実測を記録した）。`decay` は `total` に直接掛かる
-- 項であり（ADR 0109: `total` は210行すべてで `similarity × decay²` にビット単位で一致）、
-- 壊れれば想起の順位がそのまま壊れる。
--
-- **なぜ `NaN` と `Infinity` も上限側の CHECK で弾くか（実測はしていない。以下は
-- PostgreSQL のドキュメントに書かれた順序づけの仕様に基づく推論であり、この環境には
-- Postgres が無いため実行して確かめていない——CI が実際の判定者になる）。**
-- PostgreSQL の浮動小数点型は `NaN` を「他のすべての値（`Infinity` を含む）より大きい」
-- ものとして順序づける。つまり `NaN > 0` は TRUE になる——単独の下限チェックだけでは
-- `NaN` を弾けない。**下限と上限の両方を AND で書く**ことで、`NaN` は上限側
-- （`< 'Infinity'::real`）で落ちる（`memories_strength_range` が `strength` に対して
-- 使ったのと同じ「向き」のトリック。マイグレーション 0006 参照）。
--
-- **なぜ上限を「有限であること」（`Infinity` を含まない）にするか。**
-- `halfLifeHours = Infinity` は式の上では発散しない（`decay` は常に `1` に固定される
-- ——「二度と減衰しない」という一貫した意味を持つ）。**それでも上限から除いたのは、
-- 「半減期」という語そのものが有限の時間を意味しており、無限の半減期という値に
-- いま使う理由が無いためである。** ADR 0078 が採った「迷ったら厳しい側に置く
-- （緩めるのは後から非破壊、締めるのは後から破壊的）」という判断をそのまま踏襲した。
--
-- **既存データの扱い（⛔ 黙って丸めない）。**
-- このマイグレーションは検証つきで足す（`NOT VALID` にしない）。既存行が値域の外に
-- あれば、ここで**失敗する**。それは意図した振る舞いである——`NOT VALID` にすると
-- 「新しい行は守られるが、古い行は範囲外のまま黙って残る」状態になり、すでに
-- `decay`/`decay_floor_at` の計算が壊れている行を見逃す。採らなかった案とその理由は
-- ADR 0125 に書いた。
--
-- ⚠ 検証つきの `ADD CONSTRAINT` は表を走査し、その間 ACCESS EXCLUSIVE ロックを取る。
-- 行数の多い表では停止時間になりうる（ADR 0078 と同じ注意）。

ALTER TABLE tenant_settings
  ADD CONSTRAINT tenant_settings_default_half_life_range
  CHECK (default_half_life_hours > 0 AND default_half_life_hours < 'Infinity'::real);

ALTER TABLE memories
  ADD CONSTRAINT memories_half_life_range
  CHECK (half_life_hours > 0 AND half_life_hours < 'Infinity'::real);
