// Provider adapter registry: maps provider types to their adapter implementations.

import type { ProviderType } from "../config/schema";
import type { ProviderAdapter } from "./adapter";
import { nvidiaNimAdapter, openaiAdapter } from "./adapters/nvidia-nim";
import { anthropicSubscriptionAdapter } from "./adapters/anthropic-subscription";
import { chatgptResponsesAdapter } from "./adapters/chatgpt-responses";

const adapters: Partial<Record<ProviderType, ProviderAdapter>> = {
  nvidia_nim: nvidiaNimAdapter,
  openai: openaiAdapter,
  anthropic_subscription: anthropicSubscriptionAdapter,
  chatgpt: chatgptResponsesAdapter,
};

export function getAdapter(provider: ProviderType, _mode?: string): ProviderAdapter {
  const adapter = adapters[provider];
  if (!adapter) {
    // Fallback to the generic NIM/OpenAI adapter for unknown providers
    return nvidiaNimAdapter;
  }
  return adapter;
}
