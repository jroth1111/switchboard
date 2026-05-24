import { describe, it, expect, beforeEach } from "vitest";
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

  it("separates limits per IP", () => {
    const config = { windowMs: 60000, maxRequests: 1 };
    expect(checkRateLimit("ip-a", config).allowed).toBe(true);
    expect(checkRateLimit("ip-b", config).allowed).toBe(true);
    expect(checkRateLimit("ip-a", config).allowed).toBe(false);
    expect(checkRateLimit("ip-b", config).allowed).toBe(false);
  });
});

describe("Client IP extraction", () => {
  it("extracts from CF-Connecting-IP", () => {
    const req = new Request("https://example.com", {
      headers: { "CF-Connecting-IP": "1.2.3.4" },
    });
    expect(extractClientIp(req)).toBe("1.2.3.4");
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

  it("returns unknown when no headers", () => {
    const req = new Request("https://example.com");
    expect(extractClientIp(req).startsWith("unknown")).toBe(true);
  });
});
