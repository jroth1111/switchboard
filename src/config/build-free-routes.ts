import type { Deployment, RouteGroup } from "./schema";
import {
  hasProviderApiKeys,
  primaryKeyRefForProvider,
} from "../credentials/discover-api-keys";
import {
  isChatCompletionsFreeCatalogCandidate,
  type FreeCatalogSuggestions,
  type ModelHit,
} from "../ops/sync-free-models";

export function slugModelId(modelId: string): string {
  return modelId
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 72);
}

export function envHas(env: Record<string, unknown>, key: string): boolean {
  const v = env[key];
  return typeof v === "string" && v.trim().length > 0;
}

function freeRouteMultimodalCapability(providerModel: string): "none" | "native" {
  const lower = providerModel.toLowerCase();
  if (lower.includes("-vl") || lower.includes("/vl") || lower.includes("vision")) {
    return "native";
  }
  return "none";
}

export function baseOpenAiDeployment(
  partial: Pick<Deployment, "id" | "group" | "providerModel" | "keyRef" | "apiBase"> &
    Partial<Deployment>,
): Deployment {
  const multimodal = freeRouteMultimodalCapability(partial.providerModel);
  return {
    provider: "openai",
    model: slugModelId(partial.providerModel),
    rpm: 20,
    maxParallelRequests: 1,
    timeout: 500,
    streamTimeout: 500,
    supportsStreaming: true,
    capabilities: {
      toolCalling: "best_effort",
      streamingWithTools: "best_effort",
      jsonMode: "native",
      reasoning: "none",
      multimodal,
    },
    contextWindow: 128000,
    hidden: false,
    billingClass: "free",
    params: { temperature: 0.7, top_p: 0.95 },
    ...partial,
  };
}

function hitsForProvider(models: ModelHit[], provider: string): ModelHit[] {
  return models.filter((m) => m.provider === provider);
}

export function buildFreeDeployments(
  catalog: FreeCatalogSuggestions,
  env: Record<string, unknown>,
): { deployments: Deployment[]; aliases: Record<string, string> } {
  const deployments: Deployment[] = [];
  const aliases: Record<string, string> = { free: "free", freemium: "free" };
  const { providersEnabled } = catalog;
  const models = catalog.models.filter((m) => isChatCompletionsFreeCatalogCandidate(m.modelId));

  if (providersEnabled.kilo) {
    for (const hit of hitsForProvider(models, "kilo")) {
      const id = `free-kilo-${slugModelId(hit.modelId)}`;
      deployments.push(baseOpenAiDeployment({
        id,
        group: "free-kilo",
        providerModel: hit.modelId,
        keyRef: primaryKeyRefForProvider("kilo"),
        apiBase: "https://api.kilo.ai/api/gateway",
        freeTier: "kilo_gateway",
        credentialOptional: hit.keylessEligible === true,
      }));
      aliases[hit.modelId] = "free";
    }
  }

  if (providersEnabled.opencodeZen) {
    for (const hit of hitsForProvider(models, "opencode_zen")) {
      if (hit.keylessEligible === false && !hasProviderApiKeys(env, "opencode_zen")) continue;
      const id = `free-zen-${slugModelId(hit.modelId)}`;
      deployments.push(baseOpenAiDeployment({
        id,
        group: "free-opencode-zen",
        providerModel: hit.modelId,
        keyRef: primaryKeyRefForProvider("opencode_zen"),
        apiBase: "https://opencode.ai/zen/v1",
        freeTier: "opencode_zen",
        credentialOptional: hit.keylessEligible === true,
      }));
      aliases[hit.modelId] = "free";
    }
  }

  if (providersEnabled.openrouter && hasProviderApiKeys(env, "openrouter")) {
    for (const hit of hitsForProvider(models, "openrouter")) {
      const id = `free-or-${slugModelId(hit.modelId)}`;
      deployments.push(baseOpenAiDeployment({
        id,
        group: "free-openrouter",
        providerModel: hit.modelId,
        keyRef: primaryKeyRefForProvider("openrouter"),
        apiBase: "https://openrouter.ai/api/v1",
        freeTier: "catalog_zero",
        extraBody: { "HTTP-Referer": "https://github.com/switchboard", "X-Title": "switchboard" },
      }));
      aliases[hit.modelId] = "free";
    }
  }

  if (providersEnabled.groq && hasProviderApiKeys(env, "groq")) {
    for (const hit of hitsForProvider(models, "groq")) {
      const id = `free-groq-${slugModelId(hit.modelId)}`;
      deployments.push(baseOpenAiDeployment({
        id,
        group: "free-groq",
        providerModel: hit.modelId,
        keyRef: primaryKeyRefForProvider("groq"),
        apiBase: "https://api.groq.com/openai/v1",
        freeTier: "rate_limited",
      }));
      aliases[hit.modelId] = "free";
    }
  }

  return { deployments, aliases };
}

export function buildFreeRouteGroups(catalog: FreeCatalogSuggestions): Record<string, RouteGroup> {
  const fallbacks: string[] = [];
  if (catalog.providersEnabled.kilo) fallbacks.push("free-kilo");
  if (catalog.providersEnabled.opencodeZen) fallbacks.push("free-opencode-zen");
  if (catalog.providersEnabled.openrouter) fallbacks.push("free-openrouter");
  if (catalog.providersEnabled.groq) fallbacks.push("free-groq");
  if (catalog.providersEnabled.nim) {
    for (const g of catalog.nimRouteGroups) fallbacks.push(g);
  }

  const groups: Record<string, RouteGroup> = {
    free: {
      target: fallbacks[0] ?? "free",
      hidden: false,
      fallbacks: fallbacks.slice(1),
      billingClass: "free",
    },
  };

  if (catalog.providersEnabled.kilo) {
    groups["free-kilo"] = {
      target: "free-kilo",
      hidden: false,
      fallbacks: [],
      billingClass: "free",
      modelPassthrough: true,
    };
  }
  if (catalog.providersEnabled.opencodeZen) {
    groups["free-opencode-zen"] = {
      target: "free-opencode-zen",
      hidden: false,
      fallbacks: [],
      billingClass: "free",
      modelPassthrough: true,
    };
  }
  if (catalog.providersEnabled.openrouter) {
    groups["free-openrouter"] = {
      target: "free-openrouter",
      hidden: false,
      fallbacks: [],
      billingClass: "free",
      modelPassthrough: true,
    };
  }
  if (catalog.providersEnabled.groq) {
    groups["free-groq"] = {
      target: "free-groq",
      hidden: false,
      fallbacks: [],
      billingClass: "free",
      modelPassthrough: true,
    };
  }

  return groups;
}
