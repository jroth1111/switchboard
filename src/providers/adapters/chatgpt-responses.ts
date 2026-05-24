// ChatGPT Responses API provider adapter.
// Handles chatgpt provider with mode === "responses".

import type { ProviderAdapter, ProviderBuildContext } from "../adapter";
import type { ProviderRequest } from "../base";
import { classifyProviderFailure } from "../../nim/classify/provider-failure";
import type { ProviderFailureClassification } from "../../nim/classify/provider-failure";
import { classifyChatGPTFailure } from "../chatgpt-failure";
import {
  buildChatGPTResponsesRequest,
  convertResponsesToOpenAI,
  convertResponsesStreamChunk,
  validateResponsesContract,
} from "../chatgpt-responses";

export const chatgptResponsesAdapter: ProviderAdapter = {
  needsStreamWrapping: true,
  streamFormat: "chatgpt_responses",

  async buildRequest(ctx: ProviderBuildContext): Promise<ProviderRequest> {
    const contract = validateResponsesContract(ctx.body);
    if (!contract.valid) {
      throw new Error(`Responses contract violation: ${contract.reason}`);
    }
    return buildChatGPTResponsesRequest(ctx.deployment, ctx.body, ctx.apiKey);
  },

  classifyFailure(status: number, body: string): ProviderFailureClassification {
    const result = classifyChatGPTFailure(status, body);
    if (result.failureClass === "unknown_failure") {
      return classifyProviderFailure(status, body, "chatgpt");
    }
    return result;
  },

  normalizeResponse(json: Record<string, unknown>, requestId: string): Record<string, unknown> {
    return convertResponsesToOpenAI(json, requestId);
  },

  normalizeStreamChunk(event: Record<string, unknown>, requestId: string, model: string) {
    return convertResponsesStreamChunk(event, requestId, model);
  },
};
