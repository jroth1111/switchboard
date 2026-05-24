import { describe, it, expect, vi } from "vitest";
import { RATE_LIMIT_MAX_ENTRIES } from "../../src/config/constants";
import { checkRateLimit, extractClientIp } from "../../src/security/rate-limit";

describe("Rate limiting", () => {
  it("allows requests within limit", () => {
    const result = checkRateLimit("test-ip-1", { windowMs: 60000, maxRequests: 10 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it("tracks remaining correctly", () => {
    const config = { windowMs: 60000, maxRequests: 3 };
    checkRateLimit("test-ip-2", config);
    checkRateLimit("test-ip-2", config);
    const result = checkRateLimit("test-ip-2", config);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("rejects requests over limit", () => {
    const config = { windowMs: 60000, maxRequests: 2 };
    checkRateLimit("test-ip-3", config);
    checkRateLimit("test-ip-3", config);
    const result = checkRateLimit("test-ip-3", config);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it("fails closed for invalid limiter configuration", () => {
    expect(checkRateLimit("invalid-window", { windowMs: 0, maxRequests: 10 })).toMatchObject({
      allowed: false,
      remaining: 0,
    });
    expect(checkRateLimit("invalid-max", { windowMs: 60000, maxRequests: 0 })).toMatchObject({
      allowed: false,
      remaining: 0,
    });
    expect(checkRateLimit("invalid-float", { windowMs: 1000.5, maxRequests: 1 })).toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it("separates limits per IP", () => {
    const config = { windowMs: 60000, maxRequests: 1 };
    expect(checkRateLimit("ip-a", config).allowed).toBe(true);
    expect(checkRateLimit("ip-b", config).allowed).toBe(true);
    expect(checkRateLimit("ip-a", config).allowed).toBe(false);
    expect(checkRateLimit("ip-b", config).allowed).toBe(false);
  });

  it("fails closed for new identifiers when the local bucket cap is full", () => {
    const actualNow = Date.now();
    const config = { windowMs: 60000, maxRequests: 2 };
    vi.useFakeTimers();
    try {
      vi.setSystemTime(actualNow + 120000);
      checkRateLimit("cap-cleanup-prime", config);
      vi.setSystemTime(actualNow + 240000);
      checkRateLimit("cap-cleanup-prime", config);

      for (let i = 0; i < RATE_LIMIT_MAX_ENTRIES - 1; i += 1) {
        expect(checkRateLimit(`cap-${i}`, config).allowed).toBe(true);
      }
      expect(checkRateLimit("cap-overflow", config)).toMatchObject({
        allowed: false,
        remaining: 0,
      });
      expect(checkRateLimit("cap-0", config)).toMatchObject({
        allowed: true,
        remaining: 0,
      });
    } finally {
      vi.setSystemTime(actualNow + 360000);
      checkRateLimit("cap-cleanup-final", config);
      vi.useRealTimers();
    }
  });
});

describe("Client IP extraction", () => {
  it("extracts from CF-Connecting-IP", () => {
    const req = new Request("https://example.com", {
      headers: { "CF-Connecting-IP": "1.2.3.4" },
    });
    expect(extractClientIp(req)).toBe("1.2.3.4");
  });

  it("extracts IPv6 literals from CF-Connecting-IP", () => {
    const req = new Request("https://example.com", {
      headers: { "CF-Connecting-IP": "2001:DB8::1" },
    });
    expect(extractClientIp(req)).toBe("2001:db8::1");
  });

  it("ignores X-Real-IP (client-controlled)", () => {
    const req = new Request("https://example.com", {
      headers: { "X-Real-IP": "5.6.7.8" },
    });
    // Without CF-Connecting-IP, all unknown-IP requests share a distinct bucket
    // that won't collide with legitimate CF-routed traffic
    const ip = extractClientIp(req);
    expect(ip).not.toBe("5.6.7.8");
    expect(ip.startsWith("unknown")).toBe(true);
  });

  it("ignores X-Forwarded-For (client-controlled)", () => {
    const req = new Request("https://example.com", {
      headers: { "X-Forwarded-For": "9.10.11.12, 13.14.15.16" },
    });
    const ip = extractClientIp(req);
    expect(ip).not.toBe("9.10.11.12");
    expect(ip.startsWith("unknown")).toBe(true);
  });

  it("rejects malformed CF-Connecting-IP values", () => {
    for (const value of [
      "1.2.3.4, 5.6.7.8",
      "999.2.3.4",
      "127.0.0.1:1234",
      "not-an-ip",
      "1.2.3.4 5.6.7.8",
      "a".repeat(128),
    ]) {
      const req = new Request("https://example.com", {
        headers: { "CF-Connecting-IP": value },
      });
      expect(extractClientIp(req)).toBe("unknown:strict");
    }
  });

  it("returns unknown when no headers", () => {
    const req = new Request("https://example.com");
    expect(extractClientIp(req).startsWith("unknown")).toBe(true);
  });
});
