import { afterAll, describe, expect, it } from "vitest";
import { createExampleRuntime } from "../runtime-factory.js";
import { formatValidityReport, runValidityArm } from "../validity-arm.js";
import type { ValidityProbeOutcome } from "../validity-arm.js";
import { VALIDITY_PROBES } from "../validity-probe-set.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `validAt` ゲート（Issue #280、Issue #202 第2弾）を測る arm を、本物の Postgres +
 * pgvector に対して実際に1回走らせる（`time-term.postgres.test.ts` と同型）。
 *
 * **provider は擬似（`deterministic`）に固定する**——`validity-arm.ts`/`cli.ts` の
 * docstring のとおり、ペアの2件は本文が厳密に同一なので `similarity` は構成上定数に
 * なり、この測定は provider 層に依らない。
 *
 * **`MutableClock` は要らない**——`validity-arm.ts` の docstring 参照
 * （動かす項は `recordedAt` ではなく `validFrom`/`validUntil` という明示的な `Date`）。
 *
 * **書く経路は `Runtime.observe()` の `validFrom`/`validUntil`**（マネージャー決定4）を
 * 通る——`MemoryStore` を直に叩いていない。この歯は、その書き口が本物の Postgres に
 * 対して端から端まで通ることの実演でもある。
 *
 * **以下の assert は、実測の前に立てた予測である。**実測が予測と違ったときに、この歯の
 * 期待値を静かに書き換えて緑にしてはならない——ADR 0058/0164 と同じ規律。
 */
describe("examples/chat: validity arm（擬似 provider・本物の Postgres）", () => {
  it("2 probe の recall 結果（既定/過去のvalidAt/includeOutsideValidity）を実測する", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    });
    try {
      expect(handle.llmMode).toBe("deterministic");
      expect(handle.embeddingMode).toBe("deterministic");

      const now = new Date();
      const report = await runValidityArm({
        armLabel: "validity-test",
        tenantIdPrefix: "validity-test",
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        now,
      });

      // ⭐ 本命の成果物: 実測値をそのまま報告に貼る。
      console.log(formatValidityReport(report));

      const byId = new Map<string, ValidityProbeOutcome>(report.probes.map((p) => [p.probeId, p]));
      expect(byId.size).toBe(VALIDITY_PROBES.length);

      // ---------------------------------------------------------------
      // 受け入れ条件3: 既定では期限切れ/未到来が隠れ、omitted に名指しされる。
      // ---------------------------------------------------------------
      for (const probe of VALIDITY_PROBES) {
        const outcome = byId.get(probe.id)!;
        expect(outcome.current.returnedAtNow).toBe(true);
        expect(outcome.other.returnedAtNow).toBe(false);
        expect(outcome.omittedConditionsAtNow).toContain(probe.otherReason);
      }

      // ---------------------------------------------------------------
      // 受け入れ条件1: 過去の validAt を指定すると、その時点で真だった記憶が返る
      // （"address" probe だけが historicalValidAtDaysAgo を持つ）。
      // ---------------------------------------------------------------
      const address = byId.get("address")!;
      expect(address.historical).not.toBeNull();
      expect(address.historical!.currentReturned).toBe(false);
      expect(address.historical!.otherReturned).toBe(true);
      expect(address.historical!.omittedConditions).toContain("not_yet_valid");

      // ---------------------------------------------------------------
      // includeOutsideValidity: true — ゲートの明示的な opt-out。
      // ---------------------------------------------------------------
      for (const probe of VALIDITY_PROBES) {
        const outcome = byId.get(probe.id)!;
        expect(outcome.optOut.currentReturned).toBe(true);
        expect(outcome.optOut.otherReturned).toBe(true);
      }
    } finally {
      await handle.close();
    }
  }, 60_000);
});

afterAll(async () => {
  await closeTestClient();
});
