-- 0015_decay_activity_clock.sql
--
-- 減衰の時計を2本にする（ADR 0165 / Issue #305）。
-- 壁時計（`decay_floor_at`、単位は時刻）に加えて、**活動時計**（`decay_floor_seq`、
-- 単位は「そのテナントで recall() が起きた回数」）を持つ。
--
-- **オーナーの指示（逐語、2026-09-16）**: 「どっちもあっていいと思います。時間減衰と
-- そうじゃないもの」。⟹ どちらか一方を選ぶのではなく、2本を共存させる。
--
-- ---------------------------------------------------------------------------
-- なぜ `decay_floor_at` を「可変速の時刻」にしないのか
-- ---------------------------------------------------------------------------
--
-- `docs/memory-model.md` §7 は、床を**書き込み時（作成時・強化時）に一度だけ**計算して
-- 列に持つと決めている。この設計が cron による全件 UPDATE を不要にしている。
-- 「活動量に応じて速さの変わる時刻」を `decay_floor_at`（timestamptz）1本で表そうとすると、
-- **書き込み時に将来の活動量を予言しなければ未来の「時刻」が出せない。**
-- ⟹ 予言できない以上、その案は §7 の前提を満たせない。
--
-- **単位の違う床は、単位の違う列に持てばよい。** bigint の通し番号なら、書き込み時に
-- 閉じた形で出せる（`base_seq + half_life_recalls * log2(strength / threshold)`——
-- 壁時計とまったく同じ式の、別単位での実例である）。
--
-- ---------------------------------------------------------------------------
-- 単調性は「数えること」では壊れない
-- ---------------------------------------------------------------------------
--
-- Issue #305 は「回数ベースにすると `decay_floor_at` の単調性（§7）が崩れる可能性がある」と
-- 書いていた。**現物を読むと、この懸念は成り立たない。** 段1のゲートの実体
-- （`packages/postgres/src/vector-store.ts`）は `m.decay_floor_at > $n` という形であり、
-- 性質が2つ別々に働いている:
--
--   (P1) 保存側は、その行に何も起きていないのに書き換わってはならない（= §7 の「単調」）
--   (P2) 動く側は、行を走査せずに取れるスカラでなければならない（= `now()` が満たすもの）
--
-- 「他の記憶の書き込みが自分の減衰を進める」は **(P2) 側の性質**であり、「時間が経てば
-- 全員の減衰が進む」と**まったく同じ構造**である——どちらも保存列には触れない。
-- §7 が段1に課している条件も「**等値または単調な範囲比較で表現できるフィルタ**」であって、
-- **右辺が `now()` であることは条件に入っていない。**
--
-- ⟹ 壊れるのは「数えること」ではなく「**カウンタを行ごとに持つこと**」
-- （`memories.times_passed_over` のような列を recall のたびに全該当行で increment する形）。
-- **カウンタをテナントごとに1行にすれば (P1) は保たれる。** 以下はその形である。

-- ---------------------------------------------------------------------------
-- 1. 活動カウンタ — テナントごとに1行
-- ---------------------------------------------------------------------------
--
-- **`tenant_settings` の行に相乗りさせない。** `tenant_settings` は読み出しの多い設定行で
-- あり、そこを recall のたびに UPDATE する行にすると、**設定の読み出しまでカウンタの行ロックで
-- 待たされる。** 分けるのは正しさのためではなく、混ぜたときに払う待ちを避けるためである。
--
-- ⚠ 引き受けた負債: `decay_clock != 'wall'` のテナントでは、この行が recall ごとのホット行に
-- なる。同一テナントの recall はこの行で直列化する。**正しさの問題ではなく処理量の問題**で
-- あり、測れる。**`'wall'`（既定）のテナントではこの行を一度も UPDATE しない**
-- （ADR 0165「決めたこと」5）。
--
-- `tenant_id` は ADR 0007 のとおり不透明な文字列であり、外部キーを張る先の台帳は存在しない。
-- 行が無いテナントは `activity_seq = 0` として扱う（アプリ側の定数がフォールバックする。
-- `tenant_settings` に行が無いテナントの扱いと同じ形——`docs/memory-model.md` §10）。

CREATE TABLE tenant_activity (
  tenant_id    text        PRIMARY KEY,
  activity_seq bigint      NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_activity_seq_non_negative CHECK (activity_seq >= 0)
);

-- ---------------------------------------------------------------------------
-- 2. tenant_settings — どちらの時計を使うか、と活動時計の既定の半減期
-- ---------------------------------------------------------------------------
--
-- `decay_clock`:
--   'wall'     : 段1のゲートは `decay_floor_at > $n` のみ（本マイグレーション以前と同じ挙動）
--   'activity' : 段1のゲートは `decay_floor_seq > $n` のみ
--   'either'   : どちらかが生きていれば通す（OR。**最も緩い**）
--
-- **既定は 'wall'。** 「実運用で何日で沈むか」の数字を1つも持っていないので、既定は動かさない
-- （ADR 0165「検討した代替案」2）。既定を見直す条件は ADR 0165「決めたこと」10 に、
-- **測る前に**書いてある。
--
-- `default_half_life_recalls` の既定 720 は偶然ではない——壁時計の既定
-- `default_half_life_hours = 720` と**同じ数に揃えてある**。
-- ⟹ **「1 recall ↔ 1時間」という1対1の対応**を既定に置いたということであり、
-- 1時間に1回 recall するテナントでは2本の時計がほぼ同じ速さで進む。
--
-- 値域 `(0, ∞)` の CHECK は `default_half_life_hours`（マイグレーション 0012、ADR 0125）と
-- **同じ形・同じ理由**である。`NaN` は PostgreSQL の浮動小数点の順序づけで「他のすべての値より
-- 大きい」ため、下限だけでは弾けない——**下限と上限を AND で書く**ことで上限側で落ちる。

ALTER TABLE tenant_settings
  ADD COLUMN decay_clock text NOT NULL DEFAULT 'wall'
    CHECK (decay_clock IN ('wall', 'activity', 'either'));

ALTER TABLE tenant_settings
  ADD COLUMN default_half_life_recalls real NOT NULL DEFAULT 720;

ALTER TABLE tenant_settings
  ADD CONSTRAINT tenant_settings_default_half_life_recalls_range
  CHECK (default_half_life_recalls > 0 AND default_half_life_recalls < 'Infinity'::real);

-- ---------------------------------------------------------------------------
-- 3. memories — 壁時計の3つ組と1対1に対応する、活動時計の3つ組
-- ---------------------------------------------------------------------------
--
--   壁時計: (last_reinforced_at ?? recorded_at)  half_life_hours    decay_floor_at
--   活動時計: decay_base_seq                      half_life_recalls  decay_floor_seq
--
-- **`half_life_recalls` を Memory 単位の列にするのは、`half_life_hours` がそうであるのと
-- 同じ理由である**（`docs/memory-model.md` §7「リスクと対処」）——テナント設定を後から
-- 変えたときに既存行の床を全件再計算しなくて済むようにするため。
-- `tenant_settings.default_half_life_recalls` は**新規作成時の初期値としてのみ**使う。
--
-- **`decay_base_seq` も保存する。** 段2の再スコア（`packages/core/src/strategies/scoring.ts`）は
-- 床ではなく「いまの強度」を要求するので、起点が要る。床から逆算することも代数的には
-- 可能だが、`strength <= threshold` の分岐で成り立たなくなる——壁時計が起点を別に持って
-- いる（`last_reinforced_at`）のと同じ形に揃えるほうが、分岐を1つ減らせる。
--
-- ⭐ **3列とも NULL 許容にする。NULL は「この軸には床が無い＝活動時計では沈まない」を
-- 意味する。** 段1の述語は `(decay_floor_seq IS NULL OR decay_floor_seq > $n)` と書く。
--   - **NOT NULL + マイグレーション時の全件 UPDATE は採らない。** 既存テーブルへの一括更新は、
--     まさに §7 が避けようとしている形である。ここで NULL 許容にすることで、この
--     マイグレーションは**表の書き換え（rewrite）も検証のための全走査も起こさない**
--     （マイグレーション 0012 の ACCESS EXCLUSIVE の注意は、ここには掛からない）。
--   - **緩い側（沈まない）へ倒すのは意図的である。** ADR 0153 が「黙って減らさない」を
--     選んだのと同じ向き——**列を足しただけで、今日返っていたものが明日返らなくなることが
--     あってはならない。**

ALTER TABLE memories ADD COLUMN decay_base_seq    bigint NULL;
ALTER TABLE memories ADD COLUMN decay_floor_seq   bigint NULL;
ALTER TABLE memories ADD COLUMN half_life_recalls real   NULL;

-- 値域は `half_life_hours` と同じ `(0, ∞)`（ADR 0125）。NULL は「この軸を使わない」であり
-- 値域の外ではないので、明示的に通す。
ALTER TABLE memories
  ADD CONSTRAINT memories_half_life_recalls_range
  CHECK (
    half_life_recalls IS NULL
    OR (half_life_recalls > 0 AND half_life_recalls < 'Infinity'::real)
  );

-- 起点と床は、どちらも「通し番号」であって負にならない。
ALTER TABLE memories
  ADD CONSTRAINT memories_decay_seq_non_negative
  CHECK (
    (decay_base_seq  IS NULL OR decay_base_seq  >= 0)
    AND (decay_floor_seq IS NULL OR decay_floor_seq >= 0)
  );

-- ---------------------------------------------------------------------------
-- 4. 段1のゲートの索引（活動時計側）
-- ---------------------------------------------------------------------------
--
-- `idx_memories_recall_gate` と**同じ形**である（`docs/memory-model.md` §7
-- 「partial index についての注意」）——**離散値（status）を partial 述語にし、連続値
-- （床）は索引の末尾に通常の列として持たせて範囲スキャンする。**
--
-- ⚠ **`decay_clock = 'either'` の OR を、1本の btree で範囲スキャンできるとは主張しない。**
-- プランナは BitmapOr を選ぶかもしれないし、片方の索引 + フィルタを選ぶかもしれない。
-- **どちらでも行の集合は同じである**——索引の歯が assert するのは「プランナが何を選んだか」
-- ではなく、**形・適用可能性・同値**の3つである
-- （`packages/postgres/src/__tests__/recall-gate-index.test.ts` が Issue #150 で学んだ形）。
--
-- ⚠ **この索引が1本増えることで、既存の `idx_memories_recall_gate` を名指しで assert している
-- 歯（`recall-gate-index.test.ts` / `archive-decayed-index.test.ts`）が、実装が正しいまま
-- 赤くなりうる。** 同じことが 2026-09-10 に `idx_memories_lexical` の追加で実際に起きている
-- （その8時間後に CI が赤くなった）。**赤くなったら、赤くなったのは実装ではなく歯のほうだと
-- 疑うこと。**

CREATE INDEX idx_memories_recall_gate_seq
  ON memories (tenant_id, status, decay_floor_seq)
  WHERE status IN ('active', 'contested');

-- 掃引（ADR 0114 の `archiveDecayed`）の活動時計側。壁時計側が
-- `idx_memories_recall_gate` を `status = 'active'` の範囲走査に使っているのと同じ用途で、
-- 上の索引をそのまま使う（掃引の述語 `status = 'active'` は部分述語
-- `status IN ('active','contested')` を含意するので、この索引が引ける）。
-- ⟹ **掃引のための索引を別に作らない。** 壁時計側もそうしている。

-- 統計を更新しておく（マイグレーション 0005 と同じ。式索引ではないが、全行 NULL の新しい列に
-- 索引を張った直後なので、プランナに列の分布を渡しておく）。`tenant_settings` は更新しない
-- ——0005 が「式索引の統計が要る唯一のテーブルは memories」と整理した線をそのまま踏襲する。
ANALYZE memories;
