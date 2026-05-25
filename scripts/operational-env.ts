import { loadLocalSecretEnv } from "./chatgpt-auth-secrets.ts";

export interface OperationalEnv {
  values: Record<string, string>;
  loadErrors: string[];
}

export function loadOperationalEnv(cwd = process.cwd()): OperationalEnv {
  const loaded = loadLocalSecretEnv(cwd, process.env);
  return {
    values: loaded.values,
    loadErrors: loaded.loadErrors,
  };
}

export function assertOperationalEnvLoaded(env: OperationalEnv): void {
  if (env.loadErrors.length === 0) return;
  throw new Error(`unable to load local secret env: ${env.loadErrors.join("; ")}`);
}

export function optionalOperationalEnv(env: OperationalEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const processValue = process.env[name];
    if (typeof processValue === "string" && processValue.trim()) return processValue.trim();
    const localValue = env.values[name];
    if (typeof localValue === "string" && localValue.trim()) return localValue.trim();
  }
  return undefined;
}

export function requiredOperationalEnv(env: OperationalEnv, ...names: string[]): string {
  const value = optionalOperationalEnv(env, ...names);
  if (value) return value;
  throw new Error(`missing required env var: ${names.join(" or ")}`);
}
