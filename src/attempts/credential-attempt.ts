import type { Deployment, Policy } from "../config/schema";
import type { ProviderAdapter, ProviderBuildContext } from "../providers/adapter";
import type { ProviderRequest, ProviderResponse, StreamingProviderResult } from "../providers/base";
import {
  executeWithCredentialRotation,
  resolveCredentialPool,
  resolveCredentialRotationSettings,
  type CredentialHealthAccessor,
  type CredentialRotationExhausted,
  type CredentialRotationResult,
  type CredentialSlot,
  type SubscriptionPoolContext,
} from "../credentials";
import { materializeCredentialSlot } from "../credentials/types";
import { SubscriptionTokenError } from "../nim/classify/provider-failure";
import type { ProviderFailureClassification } from "../nim/classify/provider-failure";
import { getValidAnthropicToken } from "../providers/anthropic-subscription";
import { isChatGPTSubscriptionAuthJsonText } from "../providers/chatgpt-responses";
import { refreshChatGPTSubscriptionAuthMaterial } from "../providers/chatgpt-subscription-storage";
import type { SubscriptionContext } from "./subscription-context";

export type CredentialAttemptStateAccessor = CredentialHealthAccessor;

export async function resolveCredentialRotationContext(
  deployment: Deployment,
  env: Record<string, unknown>,
  policy: Policy,
  requestId: string,
  subscriptionCtx?: SubscriptionContext,
) {
  const pool = await resolveCredentialPool(
    deployment,
    env,
    requestId,
    subscriptionCtx as SubscriptionPoolContext | undefined,
  );
  const settings = resolveCredentialRotationSettings(
    deployment.provider,
    deployment,
    policy,
    pool.length,
    policy.retry.transportRetries,
  );
  return { pool, settings };
}

export function useCredentialRotation(
  pool: CredentialSlot[],
  settings: ReturnType<typeof resolveCredentialRotationSettings>,
): boolean {
  return settings.enabled && settings.strategy !== "none" && pool.length > 1;
}

export function buildCredentialContext(
  params: {
    deployment: Deployment;
    body: Record<string, unknown>;
    requestId: string;
    subscriptionCtx?: SubscriptionContext;
  },
): Omit<ProviderBuildContext, "apiKey"> {
  return {
    deployment: params.deployment,
    body: params.body,
    requestId: params.requestId,
    subscriptionCtx: params.subscriptionCtx,
  };
}

async function materializeSlot(
  slot: CredentialSlot,
  env: Record<string, unknown>,
  subscriptionCtx?: SubscriptionContext,
): Promise<string> {
  if (slot.kind === "chatgpt_oauth") {
    if (subscriptionCtx?.chatgptOAuth) {
      const fromDo = await subscriptionCtx.chatgptOAuth.getAuthMaterial(slot.label);
      if (fromDo && isChatGPTSubscriptionAuthJsonText(fromDo)) return fromDo;
    }
    if (slot.material && isChatGPTSubscriptionAuthJsonText(slot.material)) return slot.material;
    const fromEnv = env[slot.label];
    if (typeof fromEnv === "string" && isChatGPTSubscriptionAuthJsonText(fromEnv.trim())) {
      return fromEnv.trim();
    }
    throw new SubscriptionTokenError(
      `${slot.label} must contain structured ChatGPT subscription auth JSON`,
      "oauth_session_failure",
    );
  }
  return materializeCredentialSlot(slot);
}

export async function buildProviderRequestForSlot(
  adapter: ProviderAdapter,
  baseCtx: Omit<ProviderBuildContext, "apiKey">,
  slot: CredentialSlot,
  env: Record<string, unknown>,
): Promise<ProviderRequest> {
  const apiKey = await materializeSlot(slot, env, baseCtx.subscriptionCtx as SubscriptionContext | undefined);
  return adapter.buildRequest({ ...baseCtx, apiKey });
}

function refreshForSlot(
  adapter: ProviderAdapter,
  baseCtx: Omit<ProviderBuildContext, "apiKey">,
  env: Record<string, unknown>,
): (slot: CredentialSlot) => Promise<ProviderRequest> {
  return async (slot) => {
  if (slot.kind === "chatgpt_oauth" && baseCtx.deployment.provider === "chatgpt") {
      const material = await materializeSlot(slot, env, baseCtx.subscriptionCtx as SubscriptionContext | undefined);
      const refreshed = await refreshChatGPTSubscriptionAuthMaterial(material, {
        credentialName: slot.label,
        accessor: (baseCtx.subscriptionCtx as SubscriptionContext | undefined)?.chatgptOAuth,
        accountId: slot.label,
      });
      return adapter.buildRequest({ ...baseCtx, apiKey: refreshed });
  }

  if (slot.kind === "anthropic_oauth" && baseCtx.subscriptionCtx?.anthropicOAuth) {
      const oauth = baseCtx.subscriptionCtx!.anthropicOAuth!;
      const tokenResult = await getValidAnthropicToken(
        slot.accountId,
        baseCtx.requestId,
        oauth.accessor,
        {
          clientId: oauth.clientId,
          clientSecret: oauth.clientSecret,
          tokenUrl: oauth.tokenUrl,
        },
      );
      if (!("token" in tokenResult)) {
        throw new SubscriptionTokenError(
          tokenResult.error,
          tokenResult.failureClass ?? "oauth_session_failure",
        );
      }
      return adapter.buildRequest({ ...baseCtx, apiKey: slot.accountId });
  }

  throw new SubscriptionTokenError("credential_refresh_unsupported", "auth_failure");
  };
}

export async function executeNonStreamingWithCredentials(
  params: {
    pool: CredentialSlot[];
    settings: ReturnType<typeof resolveCredentialRotationSettings>;
    requestId: string;
    deployment: Deployment;
    env: Record<string, unknown>;
    health?: CredentialHealthAccessor;
    adapter: ProviderAdapter;
    baseCtx: Omit<ProviderBuildContext, "apiKey">;
    execute: (req: ProviderRequest) => Promise<ProviderResponse>;
    classifyFailure: (
      status: number,
      body: string,
      headers: Record<string, string>,
    ) => ProviderFailureClassification | null;
    beforeExecute?: (slot: CredentialSlot) => Promise<boolean | void>;
  },
): Promise<CredentialRotationResult<ProviderResponse>> {
  return executeWithCredentialRotation({
    pool: params.pool,
    settings: params.settings,
    requestId: params.requestId,
    deployment: params.deployment,
    health: params.health,
    buildRequest: (slot) => buildProviderRequestForSlot(
      params.adapter,
      params.baseCtx,
      slot,
      params.env,
    ),
    execute: params.execute,
    getHttpError: (result) => {
      if (result.status < 400) return null;
      return params.classifyFailure(result.status, result.body, result.headers)
        ?? { status: result.status };
    },
    refresh: refreshForSlot(params.adapter, params.baseCtx, params.env),
    beforeExecute: params.beforeExecute,
    classifyFailure: params.classifyFailure,
  });
}

export async function executeStreamingWithCredentials(
  params: {
    pool: CredentialSlot[];
    settings: ReturnType<typeof resolveCredentialRotationSettings>;
    requestId: string;
    deployment: Deployment;
    env: Record<string, unknown>;
    health?: CredentialHealthAccessor;
    adapter: ProviderAdapter;
    baseCtx: Omit<ProviderBuildContext, "apiKey">;
    execute: (req: ProviderRequest) => Promise<StreamingProviderResult>;
    classifyFailure: (
      status: number,
      body: string,
      headers: Record<string, string>,
    ) => ProviderFailureClassification | null;
    beforeExecute?: (slot: CredentialSlot) => Promise<boolean | void>;
  },
): Promise<CredentialRotationResult<StreamingProviderResult>> {
  return executeWithCredentialRotation({
    pool: params.pool,
    settings: params.settings,
    requestId: params.requestId,
    deployment: params.deployment,
    health: params.health,
    buildRequest: (slot) => buildProviderRequestForSlot(
      params.adapter,
      params.baseCtx,
      slot,
      params.env,
    ),
    execute: params.execute,
    getHttpError: (result) => (result.status < 400 ? null : { status: result.status }),
    refresh: refreshForSlot(params.adapter, params.baseCtx, params.env),
    beforeExecute: params.beforeExecute,
    classifyFailure: params.classifyFailure,
  });
}

export function credentialExhaustedToHttpInput(
  exhausted: CredentialRotationExhausted & { lastClassification?: ProviderFailureClassification },
): { status: number; body: string; headers: Record<string, string>; json: null } {
  const failureClass = exhausted.lastClassification?.failureClass ?? "unknown_failure";
  return {
    status: 503,
    body: JSON.stringify({
      error: {
        message: "All credentials in rotation pool exhausted",
        type: "credential_rotation_exhausted",
        code: failureClass,
      },
    }),
    headers: {},
    json: null,
  };
}
