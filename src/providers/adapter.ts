// Provider adapter contract: typed interface for provider-specific behavior.
// Each provider implements this interface to handle request building, response
// normalization, stream conversion, and failure classification.

import type { Deployment } from "../config/schema";
import type { ProviderRequest } from "./base";
import type { ProviderFailureClassification } from "../nim/classify/provider-failure";
import type { OAuthAccountAccessor } from "./anthropic-subscription";

// ─── Adapter context ──────────────────────────────────────────────

export interface ProviderBuildContext {
  deployment: Deployment;
  body: Record<string, unknown>;
  apiKey: string;
  requestId: string;
  /** For subscription providers that need OAuth token refresh. */
  subscriptionCtx?: {
    anthropicOAuth?: {
      accessor: OAuthAccountAccessor;
      clientId: string;
      clientSecret?: string;
    };
  };
}

export interface StreamNormalizeContext {
  requestId: string;
  model: string;
}

// ─── Provider adapter interface ───────────────────────────────────

export type ProviderStreamFormat = "anthropic_subscription" | "chatgpt_responses";

interface ProviderAdapterBase {
  /** Build the HTTP request for this provider. */
  buildRequest(ctx: ProviderBuildContext): Promise<ProviderRequest>;

  /** Classify an HTTP failure from this provider. */
  classifyFailure(status: number, body: string): ProviderFailureClassification;

  /** Convert a provider-specific JSON response to OpenAI chat completion format. */
  normalizeResponse(json: Record<string, unknown>, requestId: string): Record<string, unknown>;

  /** Convert a provider-native SSE event to an OpenAI chat completion chunk. */
  normalizeStreamChunk(event: Record<string, unknown>, requestId: string, model: string): Record<string, unknown> | null;
}

export type ProviderAdapter = ProviderAdapterBase & (
  | {
      /** Subscription providers must declare the native stream format to wrap. */
      readonly needsStreamWrapping: true;
      readonly streamFormat: ProviderStreamFormat;
    }
  | {
      /** OpenAI-compatible providers stream in client-facing format already. */
      readonly needsStreamWrapping: false;
      readonly streamFormat?: undefined;
    }
);
