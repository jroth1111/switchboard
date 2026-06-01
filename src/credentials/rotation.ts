import type { Deployment } from "../config/schema";
import type { ProviderRequest } from "../providers/base";
import type { ProviderFailureClassification } from "../nim/classify/provider-failure";
import { classifyProviderFailure } from "../nim/classify/provider-failure";
import {
  classifyCredentialHttpOutcome,
  classifyCredentialTransportOutcome,
  cooldownMsForOutcome,
} from "./outcome";
import type { CredentialHealthAccessor } from "./health";
import { isCredentialOnCooldown } from "./health";
import { moveCredentialToBack, pickNextCredential, reorderCredentialPoolByIds } from "./pick";
import type { ResolvedCredentialRotationSettings } from "./types";
import type { CredentialSlot } from "./types";
import { materializeCredentialSlot } from "./types";

export interface CredentialRotationSuccess<T> {
  ok: true;
  result: T;
  slot: CredentialSlot;
  keyRef: string;
}

export interface CredentialRotationExhausted {
  ok: false;
  exhausted: true;
  lastClassification?: ProviderFailureClassification;
}

export type CredentialRotationResult<T> = CredentialRotationSuccess<T> | CredentialRotationExhausted;

export interface CredentialRotationParams<T> {
  pool: CredentialSlot[];
  settings: ResolvedCredentialRotationSettings;
  requestId: string;
  deployment: Deployment;
  health?: CredentialHealthAccessor;
  buildRequest: (slot: CredentialSlot) => Promise<ProviderRequest>;
  execute: (req: ProviderRequest) => Promise<T>;
  /** Return any truthy value when the provider response is an HTTP error. */
  getHttpError: (result: T) => unknown;
  refresh?: (slot: CredentialSlot) => Promise<ProviderRequest>;
  /** Called before each provider execute. Return false to skip this credential. */
  beforeExecute?: (slot: CredentialSlot) => Promise<boolean | void>;
  classifyFailure?: (
    status: number,
    body: string,
    headers: Record<string, string>,
  ) => ProviderFailureClassification | null;
}

function keyRefForSlot(slot: CredentialSlot): string {
  switch (slot.kind) {
    case "api_key":
      return slot.keyRef;
    case "anthropic_oauth":
      return slot.accountId;
    case "chatgpt_oauth":
      return slot.label;
  }
}

function httpStatusFromResult<T>(result: T): number {
  if (typeof result === "object" && result !== null && "status" in result) {
    const status = (result as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return 200;
}

function bodyFromResult<T>(result: T): string {
  if (typeof result === "object" && result !== null && "body" in result) {
    const body = (result as { body?: unknown }).body;
    return typeof body === "string" ? body : "";
  }
  return "";
}

function headersFromResult<T>(result: T): Record<string, string> {
  if (typeof result === "object" && result !== null && "headers" in result) {
    const headers = (result as { headers?: unknown }).headers;
    if (headers instanceof Headers) {
      const out: Record<string, string> = {};
      headers.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }
    if (headers && typeof headers === "object") {
      return Object.fromEntries(
        Object.entries(headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
  }
  return {};
}

export async function executeWithCredentialRotation<T>(
  params: CredentialRotationParams<T>,
): Promise<CredentialRotationResult<T>> {
  const {
    pool,
    settings,
    requestId,
    deployment,
    health,
    buildRequest,
    execute,
    getHttpError,
    refresh,
    beforeExecute,
    classifyFailure,
  } = params;

  if (pool.length === 0) {
    return { ok: false, exhausted: true };
  }

  const now = Date.now();
  let orderedPool = [...pool];
  if (settings.strategy === "sequential_exhaust" && health?.getCredentialPoolOrder) {
    const persisted = await health.getCredentialPoolOrder(deployment.id);
    if (persisted && persisted.length > 0) {
      orderedPool = reorderCredentialPoolByIds(orderedPool, persisted);
    }
  }

  const attempted = new Set<string>();
  let lastClassification: ProviderFailureClassification | undefined;
  const maxAttempts = settings.enabled ? settings.maxAttempts : 1;
  let credentialTries = 0;

  while (credentialTries < maxAttempts) {
    const slot = pickNextCredential({
      pool: orderedPool,
      strategy: settings.strategy,
      requestId,
      attempted,
      isAvailable: () => true,
    });

    if (!slot) break;

    const cooldownSnapshot = health?.getCredentialCooldown
      ? await health.getCredentialCooldown(slot.credentialId, now)
      : null;
    if (isCredentialOnCooldown(cooldownSnapshot, now) || cooldownSnapshot?.requiresRelogin) {
      attempted.add(slot.credentialId);
      continue;
    }

    credentialTries++;
    let transportRetriesLeft = settings.networkRetryAttempts;
    let request: ProviderRequest;
    try {
      request = await buildRequest(slot);
    } catch (error) {
      attempted.add(slot.credentialId);
      lastClassification = {
        failureClass: "auth_failure",
        cooldownSeconds: 0,
        affectsHealth: false,
        affectsAccount: false,
        details: String(error),
      };
      continue;
    }
    let sameCredentialRetries = 0;

    while (true) {
      let result: T;
      try {
        if (beforeExecute) {
          const proceed = await beforeExecute(slot);
          if (proceed === false) {
            attempted.add(slot.credentialId);
            lastClassification = {
              failureClass: "rate_limit_quota_window",
              cooldownSeconds: 0,
              affectsHealth: false,
              affectsAccount: false,
              details: "per_key_token_budget_exhausted",
            };
            break;
          }
        }
        result = await execute(request);
      } catch (error) {
        const transportOutcome = classifyCredentialTransportOutcome(error, settings);
        if (transportOutcome.action === "retry_same" && transportRetriesLeft > 0) {
          transportRetriesLeft--;
          continue;
        }
        attempted.add(slot.credentialId);
        lastClassification = {
          failureClass: "transport_error",
          cooldownSeconds: 0,
          affectsHealth: false,
          affectsAccount: false,
          details: String(error),
        };
        if (health?.setCredentialCooldown) {
          const cooldownMs = settings.rateLimitCooldownSeconds * 1000;
          await health.setCredentialCooldown(
            slot.credentialId,
            "transport_error",
            now + cooldownMs,
          );
        }
        break;
      }

      const httpError = getHttpError(result);
      if (!httpError) {
        if (health?.clearCredentialCooldown) {
          await health.clearCredentialCooldown(slot.credentialId);
        }
        if (settings.strategy === "sequential_exhaust" && health?.setCredentialPoolOrder) {
          await health.setCredentialPoolOrder(
            deployment.id,
            orderedPool.map((entry) => entry.credentialId),
          );
        }
        return {
          ok: true,
          result,
          slot,
          keyRef: keyRefForSlot(slot),
        };
      }

      const status = httpStatusFromResult(result);
      const body = bodyFromResult(result);
      const headers = headersFromResult(result);
      const classification = classifyFailure?.(status, body, headers)
        ?? classifyProviderFailure(status, body, deployment.provider);
      lastClassification = classification;

      const outcome = classifyCredentialHttpOutcome(status, classification, settings);
      if (outcome.action === "success") {
        return { ok: true, result, slot, keyRef: keyRefForSlot(slot) };
      }

      if (outcome.action === "refresh_same" && refresh && sameCredentialRetries === 0) {
        sameCredentialRetries++;
        try {
          request = await refresh(slot);
          if (health?.clearCredentialCooldown) {
            await health.clearCredentialCooldown(slot.credentialId);
          }
          continue;
        } catch {
          // OAuth refresh unavailable — fall through to credential rotation.
        }
      }

      if (outcome.action === "retry_same" && transportRetriesLeft > 0) {
        transportRetriesLeft--;
        continue;
      }

      if (outcome.action === "rotate" || outcome.action === "refresh_same") {
        if (health?.setCredentialCooldown && outcome.failureClass) {
          const cooldownMs = cooldownMsForOutcome(outcome, settings, headers["retry-after"]);
          await health.setCredentialCooldown(
            slot.credentialId,
            outcome.failureClass,
            now + cooldownMs,
            { requiresRelogin: outcome.requiresRelogin, statusCode: status },
          );
        }
        if (settings.strategy === "sequential_exhaust") {
          orderedPool = moveCredentialToBack(orderedPool, slot.credentialId);
          if (health?.setCredentialPoolOrder) {
            await health.setCredentialPoolOrder(
              deployment.id,
              orderedPool.map((entry) => entry.credentialId),
            );
          }
        }
        attempted.add(slot.credentialId);
        break;
      }

      if (health?.setCredentialCooldown && outcome.failureClass) {
        const cooldownMs = cooldownMsForOutcome(outcome, settings, headers["retry-after"]);
        await health.setCredentialCooldown(
          slot.credentialId,
          outcome.failureClass,
          now + cooldownMs,
          { requiresRelogin: outcome.requiresRelogin, statusCode: status },
        );
      }
      attempted.add(slot.credentialId);
      break;
    }
  }

  return { ok: false, exhausted: true, lastClassification };
}

export { materializeCredentialSlot };
