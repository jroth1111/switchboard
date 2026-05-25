import type { Deployment } from "../config/schema";
import { isChatGPTSubscriptionAuthJsonText } from "./chatgpt-responses";
import { parseOAuthAccountList, rotateOAuthAccountCandidates } from "./oauth-account-pool";

/** JSON array of ChatGPT auth blobs, or env key names (resolved from env). */
export function parseChatGPTAuthAccountsList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[")) {
    return parseOAuthAccountList(raw)
      .map((key) => key.trim())
      .filter(Boolean);
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string" && item.trim()) {
        const entry = item.trim();
        if (!entry.startsWith("{") || isChatGPTSubscriptionAuthJsonText(entry)) {
          out.push(entry);
        }
      } else if (item && typeof item === "object") {
        const serialized = JSON.stringify(item);
        if (isChatGPTSubscriptionAuthJsonText(serialized)) out.push(serialized);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function envString(env: Record<string, unknown>, key: string): string {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Candidate auth material strings in rotation order. */
export function chatgptAuthMaterialCandidates(
  env: Record<string, unknown>,
  deployment?: Deployment,
  requestId?: string,
): string[] {
  const materials: string[] = [];
  const primary = envString(env, "CHATGPT_AUTH_JSON");
  if (primary && isChatGPTSubscriptionAuthJsonText(primary)) materials.push(primary);
  const file = envString(env, "CHATGPT_AUTH_FILE");
  if (file && isChatGPTSubscriptionAuthJsonText(file)) materials.push(file);
  for (const key of deployment?.accountIds ?? []) {
    const fromEnv = envString(env, key);
    if (fromEnv && isChatGPTSubscriptionAuthJsonText(fromEnv)) materials.push(fromEnv);
  }
  const fromList = parseChatGPTAuthAccountsList(
    (env as { CHATGPT_AUTH_ACCOUNTS?: string }).CHATGPT_AUTH_ACCOUNTS,
  );
  for (const entry of fromList) {
    if (entry.startsWith("{")) {
      materials.push(entry);
    } else {
      const resolved = envString(env, entry);
      if (resolved && isChatGPTSubscriptionAuthJsonText(resolved)) materials.push(resolved);
    }
  }
  const unique = Array.from(new Set(materials.filter(Boolean)));
  return rotateOAuthAccountCandidates(unique, requestId);
}
