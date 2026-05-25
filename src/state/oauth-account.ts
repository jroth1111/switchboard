// OAuthAccountDO: Durable Object for OAuth token storage and refresh singleflight.
// Tokens are encrypted at rest using AES-256-GCM via WebCrypto.

import { DurableObject } from "cloudflare:workers";
import { encrypt, decrypt } from "../security/encryption";

const MAX_REFRESH_LOCK_TTL_MS = 5 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    account_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    access_token_ciphertext TEXT NOT NULL,
    refresh_token_ciphertext TEXT,
    expires_at INTEGER,
    scopes_json TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS refresh_locks (
    account_id TEXT PRIMARY KEY,
    locked_until INTEGER NOT NULL,
    request_id TEXT NOT NULL
  );
`;

export interface OAuthTokenRecord {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
}

export interface OAuthTokenMetadataInput {
  scopes?: readonly string[] | null;
}

export interface OAuthAccountMetadata {
  accountId: string;
  provider: string;
  expiresAt: number | null;
  scopes: string[];
  hasRefreshToken: boolean;
  updatedAt: number;
  expired: boolean;
}

export class OAuthAccountDO extends DurableObject {
  private initialized = false;

  private ensureSchema() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(SCHEMA);
    this.ensureColumn("oauth_tokens", "scopes_json", "TEXT");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_refresh_locks_expiry ON refresh_locks(locked_until)");
    this.initialized = true;
  }

  private ensureColumn(tableName: string, columnName: string, definition: string) {
    if (!/^[a-z_][a-z0-9_]*$/.test(tableName) || !/^[a-z_][a-z0-9_]*$/.test(columnName)) return;
    const columns = this.ctx.storage.sql.exec(`PRAGMA table_info(${tableName})`).toArray();
    if (columns.some((column) => column.name === columnName)) return;
    this.ctx.storage.sql.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  private encryptionKey(): string {
    const key = (this.env as unknown as Record<string, unknown>).ENCRYPTION_KEY as string | undefined;
    if (!key) throw new Error("Token storage misconfigured");
    return key;
  }

  async getToken(accountId: string): Promise<OAuthTokenRecord | null> {
    const normalizedAccountId = normalizeIdentifier(accountId, "accountId");
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec("SELECT access_token_ciphertext, refresh_token_ciphertext, expires_at FROM oauth_tokens WHERE account_id = ?", normalizedAccountId)
      .toArray();
    if (rows.length === 0) return null;

    const encKey = this.encryptionKey();
    try {
      const accessToken = await decrypt(rows[0].access_token_ciphertext as string, encKey);
      const refreshTokenCiphertext = rows[0].refresh_token_ciphertext as string | null;
      return {
        accessToken,
        refreshToken: refreshTokenCiphertext
          ? await decrypt(refreshTokenCiphertext, encKey)
          : undefined,
        expiresAt: rows[0].expires_at as number | null,
      };
    } catch (cause) {
      throw new Error("Token storage unreadable", { cause });
    }
  }

  async getMetadata(accountId: string): Promise<OAuthAccountMetadata | null> {
    const normalizedAccountId = normalizeIdentifier(accountId, "accountId");
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT account_id, provider, expires_at, scopes_json,
                refresh_token_ciphertext IS NOT NULL AS has_refresh_token,
                updated_at
         FROM oauth_tokens
         WHERE account_id = ?`,
        normalizedAccountId,
      )
      .toArray();
    if (rows.length === 0) return null;

    const row = rows[0];
    const expiresAt = row.expires_at as number | null;
    return {
      accountId: row.account_id as string,
      provider: row.provider as string,
      expiresAt,
      scopes: parseScopes(row.scopes_json as string | null),
      hasRefreshToken: Number(row.has_refresh_token) === 1,
      updatedAt: row.updated_at as number,
      expired: expiresAt !== null && expiresAt <= Date.now(),
    };
  }

  async setToken(
    accountId: string,
    provider: string,
    accessToken: string,
    refreshToken?: string | null,
    expiresAt?: number | null,
    metadata?: OAuthTokenMetadataInput,
  ): Promise<void> {
    const normalizedAccountId = normalizeIdentifier(accountId, "accountId");
    const normalizedProvider = normalizeIdentifier(provider, "provider");
    const normalizedAccessToken = normalizeSecret(accessToken, "accessToken");
    const refreshTokenProvided = refreshToken !== undefined;
    const expiresAtProvided = expiresAt !== undefined;
    const normalizedRefreshToken = refreshToken === undefined || refreshToken === null
      ? null
      : normalizeSecret(refreshToken, "refreshToken");
    const normalizedExpiresAt = expiresAtProvided ? normalizeExpiresAt(expiresAt) : null;
    const scopesProvided = metadata !== undefined && Object.prototype.hasOwnProperty.call(metadata, "scopes");
    const scopesJson = scopesProvided ? serializeScopes(metadata?.scopes) : null;
    const now = Date.now();
    const encKey = this.encryptionKey();
    const accessTokenCiphertext = await encrypt(normalizedAccessToken, encKey);
    const refreshTokenCiphertext = normalizedRefreshToken ? await encrypt(normalizedRefreshToken, encKey) : null;

    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `INSERT INTO oauth_tokens
         (account_id, provider, access_token_ciphertext, refresh_token_ciphertext, expires_at, scopes_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         provider = excluded.provider,
         access_token_ciphertext = excluded.access_token_ciphertext,
         refresh_token_ciphertext = CASE
           WHEN ? THEN excluded.refresh_token_ciphertext
           ELSE oauth_tokens.refresh_token_ciphertext
         END,
         expires_at = CASE
           WHEN ? THEN excluded.expires_at
           ELSE oauth_tokens.expires_at
         END,
         scopes_json = CASE
           WHEN ? THEN excluded.scopes_json
           ELSE oauth_tokens.scopes_json
         END,
         updated_at = excluded.updated_at`,
      normalizedAccountId, normalizedProvider, accessTokenCiphertext, refreshTokenCiphertext,
      normalizedExpiresAt, scopesJson, now, refreshTokenProvided ? 1 : 0, expiresAtProvided ? 1 : 0, scopesProvided ? 1 : 0,
    );
  }

  async acquireRefreshLock(accountId: string, requestId: string, ttlMs: number = 30000): Promise<boolean> {
    const lockInput = normalizeRefreshLockInput(accountId, requestId, ttlMs);
    if (!lockInput) return false;
    this.ensureSchema();
    const now = Date.now();
    const lockedUntil = now + lockInput.ttlMs;
    const activeRows = this.ctx.storage.sql
      .exec("SELECT request_id FROM refresh_locks WHERE account_id = ? AND locked_until > ?", lockInput.accountId, now)
      .toArray();
    if (activeRows.length > 0) return false;

    this.ctx.storage.sql.exec(
      `INSERT INTO refresh_locks (account_id, locked_until, request_id)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         locked_until = excluded.locked_until,
         request_id = excluded.request_id`,
      lockInput.accountId, lockedUntil, lockInput.requestId,
    );
    return true;
  }

  async releaseRefreshLock(accountId: string, requestId: string): Promise<void> {
    const normalizedAccountId = normalizeIdentifier(accountId, "accountId");
    const normalizedRequestId = normalizeIdentifier(requestId, "requestId");
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      "DELETE FROM refresh_locks WHERE account_id = ? AND request_id = ?",
      normalizedAccountId, normalizedRequestId,
    );
  }

  async deleteToken(accountId: string): Promise<void> {
    const normalizedAccountId = normalizeIdentifier(accountId, "accountId");
    this.ensureSchema();
    this.ctx.storage.sql.exec("DELETE FROM oauth_tokens WHERE account_id = ?", normalizedAccountId);
    this.ctx.storage.sql.exec("DELETE FROM refresh_locks WHERE account_id = ?", normalizedAccountId);
  }
}

function normalizeIdentifier(value: unknown, fieldName: string): string {
  if (typeof value !== "string") throw new Error(`${fieldName} must be a non-empty string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${fieldName} must be a non-empty string`);
  return normalized;
}

function normalizeSecret(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function normalizeExpiresAt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("expiresAt must be a finite Unix epoch millisecond timestamp or null");
  }
  return Math.trunc(value);
}

function normalizeRefreshLockInput(
  accountId: unknown,
  requestId: unknown,
  ttlMs: unknown,
): { accountId: string; requestId: string; ttlMs: number } | null {
  try {
    return {
      accountId: normalizeIdentifier(accountId, "accountId"),
      requestId: normalizeIdentifier(requestId, "requestId"),
      ttlMs: normalizeRefreshLockTtl(ttlMs),
    };
  } catch {
    return null;
  }
}

function normalizeRefreshLockTtl(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("ttlMs must be a positive finite number");
  }
  if (value > MAX_REFRESH_LOCK_TTL_MS) {
    throw new Error(`ttlMs must be <= ${MAX_REFRESH_LOCK_TTL_MS}`);
  }
  return Math.ceil(value);
}

function serializeScopes(scopes: readonly string[] | null | undefined): string | null {
  if (scopes === null || scopes === undefined) return null;
  if (!Array.isArray(scopes)) throw new Error("scopes must be an array of strings or null");
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (typeof scope !== "string") throw new Error("scopes must be an array of strings or null");
    const trimmed = scope.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

function parseScopes(scopesJson: string | null): string[] {
  if (!scopesJson) return [];
  try {
    const parsed = JSON.parse(scopesJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((scope): scope is string => typeof scope === "string" && scope.length > 0);
  } catch {
    return [];
  }
}
