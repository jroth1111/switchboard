// Provider adapter registry: maps provider types to their adapter implementations.

import type { ProviderType } from "../config/schema";
import type { ProviderAdapter } from "./adapter";
import { nvidiaNimAdapter, openaiAdapter } from "./adapters/nvidia-nim";
import { anthropicSubscriptionAdapter } from "./adapters/anthropic-subscription";
import { chatgptResponsesAdapter } from "./adapters/chatgpt-responses";

const adapters = {
  nvidia_nim: nvidiaNimAdapter,
  openai: openaiAdapter,
  anthropic_subscription: anthropicSubscriptionAdapter,
  chatgpt: chatgptResponsesAdapter,
} satisfies Record<ProviderType, ProviderAdapter>;

export function getAdapter(provider: ProviderType, mode?: string): ProviderAdapter {
  switch (provider) {
    case "chatgpt":
      if (mode !== "responses") {
        throw new Error("ChatGPT provider requires mode='responses'");
      }
      return adapters.chatgpt;
    case "nvidia_nim":
    case "openai":
    case "anthropic_subscription":
      if (mode !== undefined) {
        throw new Error(`${provider} provider does not support mode='${mode}'`);
      }
      return adapters[provider];
    default:
      throw new Error(`Unknown provider adapter: ${String(provider)}`);
  }
}
