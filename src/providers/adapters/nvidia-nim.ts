// NVIDIA NIM / OpenAI-compatible provider adapter.
// Handles nvidia_nim and openai provider types (identical behavior).

import type { ProviderAdapter, ProviderBuildContext } from "../adapter";
import type { ProviderRequest } from "../base";
import { buildProviderRequest } from "../base";
import { classifyProviderFailure } from "../../nim/classify/provider-failure";

export const nvidiaNimAdapter: ProviderAdapter = {
  needsStreamWrapping: false,

  async buildRequest(ctx: ProviderBuildContext): Promise<ProviderRequest> {
    return buildProviderRequest(ctx.deployment, ctx.body, ctx.apiKey);
  },

  classifyFailure(status: number, body: string) {
    return classifyProviderFailure(status, body, "nvidia_nim");
  },

  normalizeResponse(json: Record<string, unknown>, _requestId: string): Record<string, unknown> {
    return json;
  },

  normalizeStreamChunk(_event: Record<string, unknown>, _requestId: string, _model: string): null {
    return null;
  },
};

export const openaiAdapter: ProviderAdapter = {
  needsStreamWrapping: false,

  async buildRequest(ctx: ProviderBuildContext): Promise<ProviderRequest> {
    return buildProviderRequest(ctx.deployment, ctx.body, ctx.apiKey);
  },

  classifyFailure(status: number, body: string) {
    return classifyProviderFailure(status, body, "openai");
  },

  normalizeResponse(json: Record<string, unknown>, _requestId: string): Record<string, unknown> {
    return json;
  },

  normalizeStreamChunk(_event: Record<string, unknown>, _requestId: string, _model: string): null {
    return null;
  },
};
