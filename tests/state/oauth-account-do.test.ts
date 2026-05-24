import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { OAuthAccountDO } from "../../src/state/oauth-account";

function getOAuthStub(name: string): OAuthAccountDO {
  const id = env.OAUTH_ACCOUNT.idFromName(name);
  return env.OAUTH_ACCOUNT.get(id) as unknown as OAuthAccountDO;
}

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
