import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { DurableObjectStub } from "cloudflare:workers";
import type { OAuthAccountDO } from "../../src/state/oauth-account";

function getOAuthStub(name: string): DurableObjectStub<OAuthAccountDO> {
  const id = env.OAUTH_ACCOUNT.idFromName(name);
  return env.OAUTH_ACCOUNT.get(id) as unknown as DurableObjectStub<OAuthAccountDO>;
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

  it("keeps stale lock releases from clearing a newer refresh owner", async () => {
    const stub = getOAuthStub(`oauth-stale-release-${Date.now()}`);

    expect(await stub.acquireRefreshLock("acc-1", "req-1", 20)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(await stub.acquireRefreshLock("acc-1", "req-2", 1000)).toBe(true);

    await stub.releaseRefreshLock("acc-1", "req-1");
    expect(await stub.acquireRefreshLock("acc-1", "req-3", 1000)).toBe(false);

    await stub.releaseRefreshLock("acc-1", "req-2");
    expect(await stub.acquireRefreshLock("acc-1", "req-3", 1000)).toBe(true);
  });

  it("deleteToken clears token state and any active refresh lock", async () => {
    const stub = getOAuthStub(`oauth-delete-${Date.now()}`);

    await stub.setToken("acc-1", "anthropic_subscription", "access-1", "refresh-1", Date.now() + 60_000);
    expect(await stub.acquireRefreshLock("acc-1", "req-1", 1000)).toBe(true);

    await stub.deleteToken("acc-1");

    await expect(stub.getToken("acc-1")).resolves.toBeNull();
    await expect(stub.getMetadata("acc-1")).resolves.toBeNull();
    expect(await stub.acquireRefreshLock("acc-1", "req-2", 1000)).toBe(true);
  });

  it("fails closed on invalid refresh lock inputs without creating a lock", async () => {
    const stub = getOAuthStub(`oauth-invalid-lock-${Date.now()}`);

    expect(await stub.acquireRefreshLock("acc-1", "req-1", 0)).toBe(false);
    expect(await stub.acquireRefreshLock(" ", "req-1", 1000)).toBe(false);
    expect(await stub.acquireRefreshLock("acc-1", " ", 1000)).toBe(false);

    expect(await stub.acquireRefreshLock("acc-1", "req-1", 1000)).toBe(true);
  });
});

describe("OAuthAccountDO token storage", () => {
  it("round-trips token material and exposes only safe metadata", async () => {
    const stub = getOAuthStub(`oauth-storage-${Date.now()}`);
    const expiresAt = Date.now() + 60_000;

    await stub.setToken(
      "acc-1",
      "anthropic_subscription",
      "access-secret",
      "refresh-secret",
      expiresAt,
      { scopes: [" user:profile ", "user:profile", "user:inference"] },
    );

    await expect(stub.getToken("acc-1")).resolves.toEqual({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt,
    });

    const metadata = await stub.getMetadata("acc-1");

    expect(metadata).toEqual(expect.objectContaining({
      accountId: "acc-1",
      provider: "anthropic_subscription",
      expiresAt,
      scopes: ["user:profile", "user:inference"],
      hasRefreshToken: true,
      expired: false,
    }));
    expect(JSON.stringify(metadata)).not.toContain("secret");
  });

  it("preserves refresh token and scopes unless they are explicitly cleared", async () => {
    const stub = getOAuthStub(`oauth-preserve-${Date.now()}`);
    const firstExpiry = Date.now() + 60_000;
    const secondExpiry = Date.now() + 120_000;
    const thirdExpiry = Date.now() - 1_000;

    await stub.setToken("acc-1", "anthropic_subscription", "access-1", "refresh-1", firstExpiry, {
      scopes: ["scope-a"],
    });
    await stub.setToken("acc-1", "anthropic_subscription", "access-2", undefined, secondExpiry);

    await expect(stub.getToken("acc-1")).resolves.toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-1",
      expiresAt: secondExpiry,
    });
    expect(await stub.getMetadata("acc-1")).toEqual(expect.objectContaining({
      scopes: ["scope-a"],
      hasRefreshToken: true,
      expired: false,
    }));

    await stub.setToken("acc-1", "anthropic_subscription", "access-3", null, thirdExpiry, {
      scopes: null,
    });

    await expect(stub.getToken("acc-1")).resolves.toEqual({
      accessToken: "access-3",
      expiresAt: thirdExpiry,
    });
    expect(await stub.getMetadata("acc-1")).toEqual(expect.objectContaining({
      scopes: [],
      hasRefreshToken: false,
      expired: true,
    }));
  });
});
