import { MANIFEST } from "../config/manifest";
import { canonicalize, type ExecutionPlan } from "../planner/planner";
import { getBearerToken, timingSafeEqual } from "./auth";
import {
  isOAuthExcluded,
  mergeOAuthExcludedModels,
  modelIdentitySet,
} from "./oauth-exclusions";
import { parseTeamLimits, resolveClientAdmissionLimits, type ClientAdmissionLimits } from "./team-limits";

export { parseTeamLimits, resolveClientAdmissionLimits, type ClientAdmissionLimits };

export interface ClientPolicy {
  teamId?: string;
  allowedModels?: string[];
  deniedModels?: string[];
  deniedRouteGroups?: string[];
  /** VibeProxy-style provider -> model ids or "*" to hide subscription-backed routes. */
  oauthExcludedModels?: Record<string, string[]>;
  allowHiddenRoutes?: boolean;
  rpmLimit?: number;
  maxConcurrency?: number;
  tokenBudgetPerMinute?: number;
}

export interface ClientIdentity {
  clientId: string;
  appId?: string;
  userHash?: string;
  policyId: string;
  policyVersion: string;
  policy: ClientPolicy;
  authSource: "client_keys_json";
}

export type ClientAuthResult =
  | { ok: true; client: ClientIdentity }
  | { ok: false; status: number; error: { message: string; type: string; code: string } };

interface RawClientConfig extends ClientPolicy {
  id?: unknown;
  clientId?: unknown;
  appId?: unknown;
  userHash?: unknown;
  policyId?: unknown;
  policyVersion?: unknown;
  tokenHash?: unknown;
  token_sha256?: unknown;
}

interface ParsedClientConfig {
  tokenHash: string;
  client: ClientIdentity;
}

const DEFAULT_POLICY_ID = "default";

export async function authenticateProxyClient(request: Request, env: Env): Promise<ClientAuthResult> {
  const bearer = getBearerToken(request);
  if (!bearer) return authFailure("missing bearer token");

  const bearerHash = await sha256Hex(bearer);
  const clients = parseClientKeys(env.CLIENT_KEYS_JSON);
  for (const entry of clients) {
    if (timingSafeEqual(bearerHash, entry.tokenHash)) {
      const claimResult = await applySignedUserClaim(request, env, entry.client);
      if (!claimResult.ok) return claimResult;
      return { ok: true, client: claimResult.client };
    }
  }

  return authFailure("unauthorized");
}

async function applySignedUserClaim(request: Request, env: Env, client: ClientIdentity): Promise<ClientAuthResult> {
  const secret = env.CLIENT_USER_CLAIM_SECRET;
  const userHash = request.headers.get("X-Switchboard-User-Hash")?.trim();
  const signature = request.headers.get("X-Switchboard-User-Signature")?.trim().toLowerCase();
  if (!userHash && !signature) return { ok: true, client };
  if (!secret || !userHash || !signature) return authFailure("invalid signed user claim");
  if (!/^[a-f0-9]{64}$/.test(signature)) return authFailure("invalid signed user claim");

  const payload = `${client.clientId}:${client.appId ?? ""}:${userHash}`;
  const expected = await hmacSha256Hex(secret, payload);
  if (!timingSafeEqual(expected, signature)) return authFailure("invalid signed user claim");
  return { ok: true, client: { ...client, userHash } };
}

export function authorizeModelForClient(model: string, client: ClientIdentity): { allowed: true } | { allowed: false; reason: string } {
  const canonical = canonicalize(model);
  if (!canonical.isManaged) return { allowed: false, reason: "unknown_model" };

  const group = MANIFEST.routeGroups[canonical.canonicalTarget];
  if (!group) return { allowed: false, reason: "unknown_model" };
  if (client.policy.deniedRouteGroups?.includes(canonical.canonicalTarget)) {
    return { allowed: false, reason: "route_group_denied" };
  }
  if (group.hidden && !client.policy.allowHiddenRoutes) return { allowed: false, reason: "hidden_route" };

  const modelKeys = modelIdentitySet(model, canonical.canonicalTarget);
  const oauthExclusions = mergedOAuthExclusionsForClient(client);
  if (isOAuthExcluded(canonical.canonicalTarget, modelKeys, oauthExclusions)) {
    return { allowed: false, reason: "oauth_provider_excluded" };
  }
  if (client.policy.deniedModels?.some((entry) => modelKeys.has(entry))) {
    return { allowed: false, reason: "model_denied" };
  }
  if (client.policy.allowedModels?.length && !client.policy.allowedModels.some((entry) => modelKeys.has(entry))) {
    return { allowed: false, reason: "model_not_allowed" };
  }

  return { allowed: true };
}

export function applyClientPolicyToPlan(plan: ExecutionPlan, client: ClientIdentity): ExecutionPlan {
  const fallbackSequence = plan.fallbackSequence.filter((entry) => routeGroupAllowedForFallback(entry.group, client).allowed);
  const allowedFallbacks = new Set(fallbackSequence.map((entry) => entry.group));
  const routeDecision = {
    ...plan.routeDecision,
    fallbackGroups: fallbackSequence.map((entry) => entry.group),
    candidates: plan.routeDecision.candidates.map((candidate) => {
      const auth = candidate.group === plan.selectedGroup
        ? { allowed: true as const }
        : routeGroupAllowedForFallback(candidate.group, client);
      const retainedFallback = allowedFallbacks.has(candidate.group);
      if (candidate.group === plan.selectedGroup || retainedFallback) return candidate;
      return {
        ...candidate,
        viable: false,
        rejectionReason: auth.allowed
          ? "not in authorized fallback sequence"
          : `client_policy:${auth.reason}`,
      };
    }),
  };
  return { ...plan, fallbackSequence, routeDecision };
}

export function visibleModelsForClient(client: ClientIdentity): Array<{
  id: string; object: "model"; created: number; owned_by: string;
  label: string; category: string; capabilities: string[];
}> {
  return Object.entries(MANIFEST.aliases)
    .filter(([alias]) => authorizeModelForClient(alias, client).allowed)
    .map(([alias, target]) => ({
      id: alias,
      object: "model" as const,
      created: 0,
      owned_by: "control-plane",
      label: modelLabel(alias, target),
      category: modelCategory(alias, target),
      capabilities: modelCapabilities(target),
    }));
}

function parseClientKeys(raw: string | undefined): ParsedClientConfig[] {
  if (!raw?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const rawClients = Array.isArray((parsed as { clients?: unknown }).clients)
    ? (parsed as { clients: unknown[] }).clients
    : [];

  const clients: ParsedClientConfig[] = [];
  for (const item of rawClients) {
    if (!item || typeof item !== "object") continue;
    const cfg = item as RawClientConfig;
    const tokenHash = normalizedTokenHash(cfg.token_sha256) ?? normalizedTokenHash(cfg.tokenHash);
    if (!tokenHash) continue;
    const id = stringValue(cfg.id) ?? stringValue(cfg.clientId);
    if (!id) continue;
    clients.push({
      tokenHash,
      client: {
        clientId: id,
        appId: stringValue(cfg.appId),
        userHash: stringValue(cfg.userHash),
        policyId: stringValue(cfg.policyId) ?? DEFAULT_POLICY_ID,
        policyVersion: stringValue(cfg.policyVersion) ?? `${stringValue(cfg.policyId) ?? DEFAULT_POLICY_ID}:unversioned`,
        policy: {
          teamId: stringValue(cfg.teamId),
          allowedModels: stringList(cfg.allowedModels),
          deniedModels: stringList(cfg.deniedModels),
          deniedRouteGroups: stringList(cfg.deniedRouteGroups),
          oauthExcludedModels: parseOAuthExcludedModels(cfg.oauthExcludedModels),
          allowHiddenRoutes: cfg.allowHiddenRoutes === true,
          rpmLimit: positiveInteger(cfg.rpmLimit),
          maxConcurrency: positiveInteger(cfg.maxConcurrency),
          tokenBudgetPerMinute: positiveInteger(cfg.tokenBudgetPerMinute),
        },
        authSource: "client_keys_json",
      },
    });
  }
  return clients;
}

function parseOAuthExcludedModels(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== "string" || !key.trim()) continue;
    const list = stringList(raw);
    if (list?.length) out[key.trim()] = list;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function mergedOAuthExclusionsForClient(client: ClientIdentity): Record<string, string[]> | undefined {
  return mergeOAuthExcludedModels(MANIFEST.oauthExcludedModels, client.policy.oauthExcludedModels);
}

function routeGroupAllowedForFallback(groupName: string, client: ClientIdentity): { allowed: true } | { allowed: false; reason: string } {
  const group = MANIFEST.routeGroups[groupName];
  if (!group) return { allowed: false, reason: "unknown_model" };
  if (client.policy.deniedRouteGroups?.includes(groupName)) return { allowed: false, reason: "route_group_denied" };
  if (group.hidden && !client.policy.allowHiddenRoutes) return { allowed: false, reason: "hidden_route" };
  const modelKeys = modelIdentitySet(groupName, groupName);
  if (isOAuthExcluded(groupName, modelKeys, mergedOAuthExclusionsForClient(client))) {
    return { allowed: false, reason: "oauth_provider_excluded" };
  }
  if (client.policy.deniedModels?.some((entry) => modelKeys.has(entry))) {
    return { allowed: false, reason: "model_denied" };
  }
  if (client.policy.allowedModels?.length && !client.policy.allowedModels.some((entry) => modelKeys.has(entry))) {
    return { allowed: false, reason: "model_not_allowed" };
  }
  return { allowed: true };
}

function authFailure(message: string): ClientAuthResult {
  return {
    ok: false,
    status: 401,
    error: { message, type: "auth", code: "unauthorized" },
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return result.length > 0 ? result : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizedTokenHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function modelLabel(alias: string, target: string): string {
  const lower = `${alias} ${target}`.toLowerCase();
  if (lower.includes("tool")) return "Best tool use";
  if (lower.includes("high") || lower.includes("max") || lower.includes("reason")) return "High reasoning";
  if (lower.includes("smart")) return "Best coding";
  if (lower.includes("nim") || lower.includes("minimax")) return "Fast";
  return "Balanced";
}

function modelCategory(alias: string, target: string): string {
  const lower = `${alias} ${target}`.toLowerCase();
  if (lower.includes("tool")) return "tool-use";
  if (lower.includes("reason") || lower.includes("high") || lower.includes("max")) return "reasoning";
  if (lower.includes("nim") || lower.includes("minimax")) return "low-latency";
  return "general";
}

function modelCapabilities(target: string): string[] {
  const deployments = MANIFEST.deploymentsByGroup[target] ?? [];
  const caps = new Set<string>();
  if (deployments.some((d) => d.contextWindow >= 128000)) caps.add("long_context");
  if (deployments.some((d) => d.capabilities.toolCalling !== "none")) caps.add("tool_use");
  if (deployments.some((d) => d.capabilities.reasoning !== "none")) caps.add("reasoning");
  if (deployments.some((d) => d.capabilities.multimodal !== "none")) caps.add("multimodal");
  if (deployments.some((d) => d.supportsStreaming)) caps.add("streaming");
  return Array.from(caps).sort();
}
