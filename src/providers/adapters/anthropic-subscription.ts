// Anthropic subscription provider adapter.
// Claude Code OAuth inference via Messages API.

import type { ProviderAdapter, ProviderBuildContext } from "../adapter";
import type { ProviderRequest } from "../base";
import type { FailureClass } from "../../config/schema";
import { SubscriptionTokenError, classifyProviderFailure } from "../../nim/classify/provider-failure";
import type { ProviderFailureClassification } from "../../nim/classify/provider-failure";
import { classifyAnthropicFailure } from "../anthropic-failure";
import {
  buildAnthropicSubscriptionRequest,
  convertAnthropicToOpenAI,
  convertAnthropicStreamChunk,
  getValidAnthropicToken,
} from "../anthropic-subscription";
import { anthropicOAuthAccountCandidates } from "../oauth-account-pool";

export const anthropicSubscriptionAdapter: ProviderAdapter = {
  needsStreamWrapping: true,
  streamFormat: "anthropic_subscription",

  async buildRequest(ctx: ProviderBuildContext): Promise<ProviderRequest> {
    if (!ctx.subscriptionCtx?.anthropicOAuth) {
      throw new SubscriptionTokenError("anthropic_oauth_not_configured", "oauth_session_failure");
    }

    let lastError: { error: string; failureClass: FailureClass } | null = null;
    const pool = ctx.subscriptionCtx.anthropicOAuth.accountIds;
    for (const accountId of anthropicOAuthAccountCandidates(ctx.apiKey, ctx.deployment.id, pool, ctx.requestId)) {
      const tokenResult = await getValidAnthropicToken(
        accountId,
        ctx.requestId,
        ctx.subscriptionCtx.anthropicOAuth.accessor,
        {
          clientId: ctx.subscriptionCtx.anthropicOAuth.clientId,
          clientSecret: ctx.subscriptionCtx.anthropicOAuth.clientSecret,
          tokenUrl: ctx.subscriptionCtx.anthropicOAuth.tokenUrl,
        },
      );

      if ("token" in tokenResult) {
        return buildAnthropicSubscriptionRequest(ctx.deployment, ctx.body, tokenResult.token);
      }

      lastError = tokenResult;
      if (tokenResult.error !== "no_token_stored") break;
    }

    throw new SubscriptionTokenError(
      lastError?.error ?? "no_token_stored",
      lastError?.failureClass ?? "oauth_session_failure",
    );
  },

  classifyFailure(status: number, body: string): ProviderFailureClassification {
    const result = classifyAnthropicFailure(status, body);
    if (result.failureClass === "unknown_failure") {
      return classifyProviderFailure(status, body, "anthropic_subscription");
    }
    return result;
  },

  normalizeResponse(json: Record<string, unknown>, requestId: string): Record<string, unknown> {
    return convertAnthropicToOpenAI(json, requestId);
  },

  normalizeStreamChunk(event: Record<string, unknown>, requestId: string, model: string) {
    return convertAnthropicStreamChunk(event as { type: string; [key: string]: unknown }, requestId, model);
  },
};
