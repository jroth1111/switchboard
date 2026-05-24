// OAuthAccountDO: Durable Object for OAuth token storage and refresh singleflight.
// Tokens are encrypted at rest using AES-256-GCM via WebCrypto.

import { DurableObject } from "cloudflare:workers";
import { encrypt, decrypt } from "../security/encryption";

export class OAuthAccountDO extends DurableObject {
  private initialized = false;

  private ensureSchema() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
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
    `);
    this.initialized = true;
  }

  private encryptionKey(): string {
    const key = (this.env as unknown as Record<string, unknown>).ENCRYPTION_KEY as string | undefined;
    if (!key) throw new Error("ENCRYPTION_KEY secret is not configured");
    return key;
  }

  async getToken(accountId: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number | null } | null> {
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec("SELECT access_token_ciphertext, refresh_token_ciphertext, expires_at FROM oauth_tokens WHERE account_id = ?", accountId)
      .toArray();
    if (rows.length === 0) return null;

    const accessToken = await decrypt(rows[0].access_token_ciphertext as string, this.encryptionKey());
    const refreshTokenCiphertext = rows[0].refresh_token_ciphertext as string | null;
    return {
      accessToken,
      refreshToken: refreshTokenCiphertext
        ? await decrypt(refreshTokenCiphertext, this.encryptionKey())
        : undefined,
      expiresAt: rows[0].expires_at as number | null,
    };
  }

  async setToken(accountId: string, provider: string, accessToken: string, refreshToken?: string, expiresAt?: number): Promise<void> {
    this.ensureSchema();
    const now = Date.now();
    const encKey = this.encryptionKey();
    const accessTokenCiphertext = await encrypt(accessToken, encKey);
    const refreshTokenCiphertext = refreshToken ? await encrypt(refreshToken, encKey) : null;

    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO oauth_tokens (account_id, provider, access_token_ciphertext, refresh_token_ciphertext, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      accountId, provider, accessTokenCiphertext, refreshTokenCiphertext, expiresAt ?? null, now,
    );
  }

  async acquireRefreshLock(accountId: string, requestId: string, ttlMs: number = 30000): Promise<boolean> {
    this.ensureSchema();
    const now = Date.now();
    const existing = this.ctx.storage.sql
      .exec("SELECT locked_until, request_id FROM refresh_locks WHERE account_id = ?", accountId)
      .toArray();

    if (existing.length > 0 && (existing[0].locked_until as number) > now) {
      return false;
    }

    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO refresh_locks (account_id, locked_until, request_id) VALUES (?, ?, ?)",
      accountId, now + ttlMs, requestId,
    );
    return true;
  }

  async releaseRefreshLock(accountId: string, requestId: string): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      "DELETE FROM refresh_locks WHERE account_id = ? AND request_id = ?",
      accountId, requestId,
    );
  }

  async deleteToken(accountId: string): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec("DELETE FROM oauth_tokens WHERE account_id = ?", accountId);
    this.ctx.storage.sql.exec("DELETE FROM refresh_locks WHERE account_id = ?", accountId);
  }
}
