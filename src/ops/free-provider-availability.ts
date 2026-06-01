import {
  hasProviderApiKeys,
  discoverNimKeyRefs,
} from "../credentials/discover-api-keys";

export interface FreeProviderAvailability {
  openrouter: { catalogProbe: true; inference: boolean };
  groq: { catalogProbe: boolean; inference: boolean };
  nim: { inference: boolean; routeGroups: string[] };
  kilo: { catalogProbe: true; inference: boolean; keylessModels: string[] };
  opencodeZen: { catalogProbe: boolean; inference: boolean; keylessModels: string[] };
}

export function resolveFreeProviderAvailability(
  env: Record<string, unknown> | undefined,
  options?: { keylessKilo?: string[]; keylessOpencodeZen?: string[] },
): FreeProviderAvailability {
  const e = env ?? {};
  const kiloKeyless = options?.keylessKilo ?? [];
  const zenKeyless = options?.keylessOpencodeZen ?? [];
  const hasKiloKey = hasProviderApiKeys(e, "kilo");
  const hasZenKey = hasProviderApiKeys(e, "opencode_zen");
  const hasOpenRouter = hasProviderApiKeys(e, "openrouter");
  const hasGroq = hasProviderApiKeys(e, "groq");

  return {
    openrouter: { catalogProbe: true, inference: hasOpenRouter },
    groq: {
      catalogProbe: hasGroq,
      inference: hasGroq,
    },
    nim: {
      inference: discoverNimKeyRefs(e).length > 0,
      routeGroups: [],
    },
    kilo: {
      catalogProbe: true,
      inference: hasKiloKey || kiloKeyless.length > 0,
      keylessModels: kiloKeyless,
    },
    opencodeZen: {
      catalogProbe: true,
      inference: hasZenKey || zenKeyless.length > 0,
      keylessModels: zenKeyless,
    },
  };
}
