import { createHash } from "node:crypto";

/** CI/local-test bearer; production values belong in `../switchboard-local/.dev.vars` only. */
export const TEST_CLIENT_BEARER = "switchboard-ci-test-bearer";
export const TEST_OPERATOR_BEARER = "switchboard-ci-operator-bearer";

export const TEST_CLIENT_TOKEN_SHA256 = createHash("sha256")
  .update(TEST_CLIENT_BEARER, "utf8")
  .digest("hex");

export const TEST_OPERATOR_TOKEN_SHA256 = createHash("sha256")
  .update(TEST_OPERATOR_BEARER, "utf8")
  .digest("hex");

export const TEST_APP_ID = "test-app";
export const TEST_CLIENT_ALICE_ID = "test-client-alice";
export const TEST_CLIENT_APP_ID = "test-client-app";
export const TEST_POLICY_ID = "test-basic";
export const TEST_POLICY_VERSION = `${TEST_POLICY_ID}:v1`;
export const TEST_USER_HASH = "test-user-alice";
export const TEST_OPERATOR_CLIENT_ID = "test-operator";

export interface ClientKeysFixture {
  teams?: Record<string, unknown>;
  clients: Array<Record<string, unknown>>;
}

export function testAliceClient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TEST_CLIENT_ALICE_ID,
    appId: TEST_APP_ID,
    token_sha256: TEST_CLIENT_TOKEN_SHA256,
    policyId: TEST_POLICY_ID,
    teamId: "engineering",
    allowedModels: ["smart-route", "nim-primary", "free", "freemium"],
    rpmLimit: 60,
    maxConcurrency: 4,
    tokenBudgetPerMinute: 120000,
    ...overrides,
  };
}

export function testClientApp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TEST_CLIENT_APP_ID,
    appId: TEST_APP_ID,
    token_sha256: TEST_CLIENT_TOKEN_SHA256,
    ...overrides,
  };
}

/** Mirrors config/fixtures/client-keys.ci.json (synthetic IDs only). */
export function testClientKeysJson(overrides?: Partial<ClientKeysFixture>): string {
  const base: ClientKeysFixture = {
    teams: {
      engineering: {
        rpmLimit: 500,
        maxConcurrency: 20,
        tokenBudgetPerMinute: 500000,
      },
    },
    clients: [
      testAliceClient(),
      {
        id: TEST_OPERATOR_CLIENT_ID,
        token_sha256: TEST_OPERATOR_TOKEN_SHA256,
        allowHiddenRoutes: true,
      },
    ],
  };
  return JSON.stringify({
    teams: overrides?.teams ?? base.teams,
    clients: overrides?.clients ?? base.clients,
  });
}
