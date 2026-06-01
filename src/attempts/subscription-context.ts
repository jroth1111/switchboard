import type { OAuthAccountAccessor } from "../providers/anthropic-subscription";
import type { ChatGPTOAuthAccessor } from "../providers/chatgpt-subscription-storage";

export interface SubscriptionContext {
  anthropicOAuth?: {
    accessor: OAuthAccountAccessor;
    clientId: string;
    clientSecret?: string;
    tokenUrl?: string;
    accountIds?: string[];
  };
  chatgptOAuth?: ChatGPTOAuthAccessor;
}
