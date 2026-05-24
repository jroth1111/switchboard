import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { OAuthAccountDO } from "../../src/state/oauth-account";

function getOAuthStub(name: string): OAuthAccountDO {
  const id = env.OAUTH_ACCOUNT.idFromName(name);
  return env.OAUTH_ACCOUNT.get(id) as unknown as OAuthAccountDO;
}

describe("OAuthAccountDO token storage", () => {
  it("encrypts tokens at rest and preserves fields on partial setToken", async () => {
    const stub = getOAuthStub(`oauth-crypto-${Date.now()}`);

    await stub.setToken("acc-1", "anthropic", "access-initial", "refresh-initial", Date.now() + 60_000);
    const loaded = await stub.getToken("acc-1");
    expect(loaded?.accessToken).toBe("access-initial");
    expect(loaded?.refreshToken).toBe("refresh-initial");

    await stub.setToken("acc-1", "anthropic", "access-rotated");
    const partial = await stub.getToken("acc-1");
    expect(partial?.accessToken).toBe("access-rotated");
    expect(partial?.refreshToken).toBe("refresh-initial");
    expect(partial?.expiresAt).toBe(loaded?.expiresAt);
  });
});

describe("OAuthAccountDO refresh locks", () => {
  it("rejects an active refresh lock and allows acquisition after expiry", async () => {
    const stub = getOAuthStub(`oauth-lock-${Date.now()}`);

    expect(await stub.acquireRefreshLock("acc-1", "req-1", 50)).toBe(true);
    expect(await stub.acquireRefreshLock("acc-1", "req-2", 1000)).toBe(false);
    expect(await stub.acquireRefreshLock("acc-1", "req-1", 1000)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(await stub.acquireRefreshLock("acc-1", "req-3", 1000)).toBe(true);
  });
});
