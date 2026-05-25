import { describe, it, expect } from "vitest";
import { failureClassToFallbackProfile } from "../../src/config/fallback-profile";

describe("failureClassToFallbackProfile", () => {
  it("maps context errors to context_window", () => {
    expect(failureClassToFallbackProfile("context_length_exceeded")).toBe("context_window");
  });

  it("maps client errors to content_policy", () => {
    expect(failureClassToFallbackProfile("client_4xx_bad_request")).toBe("content_policy");
  });

  it("maps transport to general", () => {
    expect(failureClassToFallbackProfile("transport_error")).toBe("general");
  });
});
