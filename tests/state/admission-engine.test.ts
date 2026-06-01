import { describe, it, expect } from "vitest";
import {
  admit,
  chargePerKeyRpm,
  tryChargePerKeyRpm,
  isKeyRpmAvailable,
  isPerKeyTokenBudgetAvailable,
} from "../../src/state/admission-engine";
import { tokenWindowKey } from "../../src/config/budget-keys";
import { InMemoryStorageAdapter } from "../../src/state/storage-adapter";

function candidate(
  deploymentId: string,
  keyRef = "key-1",
  rpm = 35,
  maxParallel = 2,
  group = "test",
) {
  return { deploymentId, keyRef, rpm, maxParallel, group };
}

// In-memory admission/release/health/circuit coverage lives in control-plane-state.test.ts.
// This file only covers deferred per-key RPM/token charging added for credential rotation.

describe("deferred per-key budget charging", () => {
  it("skips admit-time key RPM when charge is deferred", () => {
    const store = new InMemoryStorageAdapter();
    const key1 = candidate("nim-1", "NIM_KEY_1", 2, 10, "nim-primary");

    chargePerKeyRpm(store, "NIM_KEY_1", "nim-primary", "per_key");
    chargePerKeyRpm(store, "NIM_KEY_1", "nim-primary", "per_key");
    expect(isKeyRpmAvailable(store, "NIM_KEY_1", "nim-primary", "per_key", 2)).toBe(false);

    const admitted = admit(store, {
      requestId: "req-defer-rpm",
      candidates: [key1],
      scopeMode: "per_key",
      deferPerKeyRpmCharge: true,
    });
    expect(admitted.admitted).toBe(true);
    expect(admitted.keyRef).toBe("NIM_KEY_1");
  });

  it("tryChargePerKeyRpm reserves capacity atomically", () => {
    const store = new InMemoryStorageAdapter();
    const key = "NIM_KEY_1";
    const group = "nim-primary";
    expect(tryChargePerKeyRpm(store, key, group, "per_key", 2)).toBe(true);
    expect(tryChargePerKeyRpm(store, key, group, "per_key", 2)).toBe(true);
    expect(tryChargePerKeyRpm(store, key, group, "per_key", 2)).toBe(false);
  });

  it("defers per-key RPM charge until dispatch when requested", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("nim-1", "NIM_KEY_1", 2, 10, "nim-primary");

    const admitted = admit(store, {
      requestId: "req-defer",
      candidates: [c],
      scopeMode: "per_key",
      deferPerKeyRpmCharge: true,
    });
    expect(admitted.admitted).toBe(true);
    expect(admitted.deferPerKeyRpmCharge).toBe(true);

    const blocked = admit(store, { requestId: "req-defer-2", candidates: [c], scopeMode: "per_key" });
    expect(blocked.admitted).toBe(true);

    chargePerKeyRpm(store, "NIM_KEY_1", "nim-primary", "per_key");
    chargePerKeyRpm(store, "NIM_KEY_1", "nim-primary", "per_key");

    const exhausted = admit(store, { requestId: "req-defer-3", candidates: [c], scopeMode: "per_key" });
    expect(exhausted.admitted).toBe(false);
    expect(exhausted.rejected?.[0]?.reason).toBe("key_rpm_exhausted");
  });

  it("defers per-key token budget check until dispatch when RPM charge is deferred", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("nim-1", "NIM_KEY_1", 100, 10, "nim-primary");
    const tokenBudget = 1000;
    const now = Date.now();
    const bucketStart = Math.floor(now / 1000) * 1000;
    const tokenKey = tokenWindowKey("NIM_KEY_1", "nim-primary", "per_key");
    store.addTokenUsage(tokenKey, bucketStart, tokenBudget, 0);

    const admitted = admit(store, {
      requestId: "req-token-defer",
      candidates: [c],
      scopeMode: "per_key",
      tokenBudgetPerMinute: tokenBudget,
      deferPerKeyRpmCharge: true,
    });
    expect(admitted.admitted).toBe(true);

    const blockedAtAdmit = admit(store, {
      requestId: "req-token-block",
      candidates: [c],
      scopeMode: "per_key",
      tokenBudgetPerMinute: tokenBudget,
    });
    expect(blockedAtAdmit.admitted).toBe(false);
    expect(blockedAtAdmit.rejected?.[0]?.reason).toBe("token_budget_exhausted");

    expect(isPerKeyTokenBudgetAvailable(
      store, "NIM_KEY_1", "nim-primary", "per_key", tokenBudget,
    )).toBe(false);
    expect(isPerKeyTokenBudgetAvailable(
      store, "NIM_KEY_2", "nim-primary", "per_key", tokenBudget,
    )).toBe(true);
  });
});
