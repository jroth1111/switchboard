// SQL storage adapter: bridges the Durable Object's SQLite to the StorageAdapter interface.
// Used by ControlPlaneStateDO to delegate to the admission engine.

import type { StorageAdapter, CircuitRow, HealthScoreRow, LearnedLimitRow, RecentOutcome } from "./storage-adapter";

export class SqlStorageAdapter implements StorageAdapter {
  private sql: SqlStorage;
  private transactionSync?: <T>(fn: () => T) => T;

  constructor(storage: SqlStorage | DurableObjectStorageLike) {
    if ("exec" in storage) {
      this.sql = storage;
    } else {
      this.sql = storage.sql;
      this.transactionSync = storage.transactionSync?.bind(storage);
    }
  }

  pruneKeyWindows(olderThan: number): void {
    this.sql.exec("DELETE FROM key_windows WHERE window_start < ?", olderThan);
    this.sql.exec("DELETE FROM group_windows WHERE window_start < ?", olderThan);
    this.sql.exec("DELETE FROM key_token_windows WHERE window_start < ?", olderThan);
  }

  getKeyRpm(keyRef: string, since: number): number {
    const rows = this.sql.exec(
      "SELECT SUM(count) as total FROM key_windows WHERE key_ref = ? AND window_start >= ?",
      keyRef, since,
    ).toArray();
    return (rows[0]?.total as number) ?? 0;
  }

  getGroupRpm(group: string, since: number): number {
    const rows = this.sql.exec(
      "SELECT SUM(count) as total FROM group_windows WHERE group_name = ? AND window_start >= ?",
      group, since,
    ).toArray();
    return (rows[0]?.total as number) ?? 0;
  }

  incrementKeyWindow(keyRef: string, bucketStart: number): void {
    this.sql.exec(
      `INSERT INTO key_windows (key_ref, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key_ref, window_start) DO UPDATE SET count = count + 1`,
      keyRef, bucketStart,
    );
  }

  incrementGroupWindow(group: string, bucketStart: number): void {
    this.sql.exec(
      `INSERT INTO group_windows (group_name, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(group_name, window_start) DO UPDATE SET count = count + 1`,
      group, bucketStart,
    );
  }

  insertReservation(r: { reservationId: string; keyRef: string; deploymentId: string; requestId: string; createdAt: number; expiresAt: number }): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO reservations (reservation_id, key_ref, deployment_id, request_id, created_at, expires_at, confirmed) VALUES (?, ?, ?, ?, ?, ?, 0)",
      r.reservationId, r.keyRef, r.deploymentId, r.requestId, r.createdAt, r.expiresAt,
    );
  }

  confirmReservation(reservationId: string): { deploymentId: string } | null {
    this.sql.exec(
      "UPDATE reservations SET confirmed = 1 WHERE reservation_id = ? AND confirmed = 0",
      reservationId,
    );
    const rows = this.sql.exec(
      "SELECT deployment_id FROM reservations WHERE reservation_id = ?", reservationId,
    ).toArray();
    if (rows.length === 0) return null;
    return { deploymentId: rows[0].deployment_id as string };
  }

  deleteReservation(reservationId: string): { deploymentId: string } | null {
    const rows = this.sql.exec(
      "SELECT deployment_id FROM reservations WHERE reservation_id = ?", reservationId,
    ).toArray();
    this.sql.exec("DELETE FROM reservations WHERE reservation_id = ?", reservationId);
    if (rows.length === 0) return null;
    return { deploymentId: rows[0].deployment_id as string };
  }

  countReservations(deploymentId: string): number {
    const rows = this.sql.exec(
      "SELECT COUNT(*) AS count FROM reservations WHERE deployment_id = ?",
      deploymentId,
    ).toArray();
    return Number(rows[0]?.count ?? 0);
  }

  pruneStaleInflight(olderThan: number): void {
    this.sql.exec("DELETE FROM inflight WHERE updated_at < ?", olderThan);
  }

  getInflight(deploymentId: string): number {
    const rows = this.sql.exec(
      "SELECT count FROM inflight WHERE deployment_id = ?", deploymentId,
    ).toArray();
    return rows.length > 0 ? (rows[0].count as number) : 0;
  }

  setInflight(deploymentId: string, count: number, updatedAt: number): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO inflight (deployment_id, count, updated_at) VALUES (?, ?, ?)",
      deploymentId, count, updatedAt,
    );
  }

  getCooldown(deploymentId: string, now: number): boolean {
    const rows = this.sql.exec(
      "SELECT scope FROM cooldowns WHERE scope = ? AND until > ?", deploymentId, now,
    ).toArray();
    return rows.length > 0;
  }

  setCooldown(deploymentId: string, reason: string, until: number, detailsJson?: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO cooldowns (scope, reason, until, details_json) VALUES (?, ?, ?, ?)",
      deploymentId, reason, until, detailsJson ?? null,
    );
  }

  clearCooldowns(deploymentId?: string): void {
    if (deploymentId) {
      this.sql.exec("DELETE FROM cooldowns WHERE scope = ?", deploymentId);
    } else {
      this.sql.exec("DELETE FROM cooldowns");
    }
  }

  getCircuit(deploymentId: string): CircuitRow | null {
    const rows = this.sql.exec(
      "SELECT state, failure_count, success_count, opened_at, half_open_after, updated_at FROM circuits WHERE deployment_id = ?",
      deploymentId,
    ).toArray();
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      state: r.state as string,
      failureCount: r.failure_count as number,
      successCount: r.success_count as number,
      openedAt: r.opened_at as number | undefined,
      halfOpenAfter: r.half_open_after as number | undefined,
      updatedAt: r.updated_at as number,
    };
  }

  setCircuit(deploymentId: string, circuit: CircuitRow): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO circuits (deployment_id, state, failure_count, success_count, opened_at, half_open_after, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      deploymentId, circuit.state, circuit.failureCount, circuit.successCount,
      circuit.openedAt ?? null, circuit.halfOpenAfter ?? null, circuit.updatedAt,
    );
  }

  getHealthScore(deploymentId: string): HealthScoreRow | null {
    const rows = this.sql.exec(
      "SELECT score, last_success_at, last_failure_at, failure_class, updated_at, success_count, failure_count, consecutive_failure_count, latency_ema_ms, latency_sample_count, recent_outcomes_json, first_byte_latency_history_json, total_latency_history_json FROM health_scores WHERE deployment_id = ?",
      deploymentId,
    ).toArray();
    if (rows.length === 0) return null;
    return parseHealthRow(rows[0]);
  }

  listHealthScores(): Array<{ deploymentId: string; score: HealthScoreRow }> {
    const rows = this.sql.exec(
      "SELECT deployment_id, score, last_success_at, last_failure_at, failure_class, updated_at, success_count, failure_count, consecutive_failure_count, latency_ema_ms, latency_sample_count, recent_outcomes_json, first_byte_latency_history_json, total_latency_history_json FROM health_scores",
    ).toArray();
    return rows.map((r) => ({ deploymentId: r.deployment_id as string, score: parseHealthRow(r) }));
  }

  setHealthScore(deploymentId: string, score: HealthScoreRow): void {
    const recentJson = score.recentOutcomes?.length ? JSON.stringify(score.recentOutcomes) : null;
    const fbJson = score.firstByteLatencyHistoryMs?.length ? JSON.stringify(score.firstByteLatencyHistoryMs) : null;
    const totJson = score.totalLatencyHistoryMs?.length ? JSON.stringify(score.totalLatencyHistoryMs) : null;
    this.sql.exec(
      `INSERT INTO health_scores
         (deployment_id, score, last_success_at, last_failure_at, failure_class, updated_at,
          success_count, failure_count, consecutive_failure_count, latency_ema_ms, latency_sample_count,
          recent_outcomes_json, first_byte_latency_history_json, total_latency_history_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(deployment_id) DO UPDATE SET
         score = excluded.score, last_success_at = excluded.last_success_at,
         last_failure_at = excluded.last_failure_at, failure_class = excluded.failure_class,
         updated_at = excluded.updated_at, success_count = excluded.success_count,
         failure_count = excluded.failure_count, consecutive_failure_count = excluded.consecutive_failure_count,
         latency_ema_ms = excluded.latency_ema_ms, latency_sample_count = excluded.latency_sample_count,
         recent_outcomes_json = excluded.recent_outcomes_json,
         first_byte_latency_history_json = excluded.first_byte_latency_history_json,
         total_latency_history_json = excluded.total_latency_history_json`,
      deploymentId, score.score, score.lastSuccessAt ?? null, score.lastFailureAt ?? null,
      score.failureClass ?? null, score.updatedAt, score.successCount, score.failureCount,
      score.consecutiveFailureCount, score.latencyEmaMs ?? null, score.latencySampleCount,
      recentJson, fbJson, totJson,
    );
  }

  getLearnedLimit(deploymentId: string, now: number): LearnedLimitRow | null {
    const rows = this.sql.exec(
      "SELECT max_parallel, reason, expires_at FROM learned_limits WHERE deployment_id = ?",
      deploymentId,
    ).toArray();
    if (rows.length === 0) return null;
    const r = rows[0];
    const expiresAt = r.expires_at as number | null;
    if ((expiresAt !== null && expiresAt !== undefined) && expiresAt < now) return null;
    return {
      maxParallel: r.max_parallel as number,
      reason: r.reason as string | undefined,
      expiresAt,
    };
  }

  setLearnedLimit(deploymentId: string, limit: LearnedLimitRow): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO learned_limits (deployment_id, max_parallel, reason, expires_at) VALUES (?, ?, ?, ?)",
      deploymentId, limit.maxParallel, limit.reason ?? null, limit.expiresAt ?? null,
    );
  }

  getTokenUsage(keyRef: string, since: number): number {
    const rows = this.sql.exec(
      "SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total FROM key_token_windows WHERE key_ref = ? AND window_start >= ?",
      keyRef, since,
    ).toArray();
    return (rows[0]?.total as number) ?? 0;
  }

  addTokenUsage(keyRef: string, bucketStart: number, promptTokens: number, completionTokens: number): void {
    this.sql.exec(
      `INSERT INTO key_token_windows (key_ref, window_start, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?)
       ON CONFLICT(key_ref, window_start) DO UPDATE SET
         prompt_tokens = prompt_tokens + excluded.prompt_tokens,
         completion_tokens = completion_tokens + excluded.completion_tokens`,
      keyRef, bucketStart, promptTokens, completionTokens,
    );
  }

  transaction<T>(fn: () => T): T {
    return this.transactionSync ? this.transactionSync(fn) : fn();
  }
}

function parseHealthRow(r: Record<string, unknown>): HealthScoreRow {
  let recentOutcomes: RecentOutcome[] = [];
  let firstByteLatencyHistoryMs: number[] = [];
  let totalLatencyHistoryMs: number[] = [];
  if (r.recent_outcomes_json) {
    try { recentOutcomes = JSON.parse(r.recent_outcomes_json as string) as RecentOutcome[]; } catch (e) { console.error("Failed to parse recent_outcomes_json:", e); }
  }
  if (r.first_byte_latency_history_json) {
    try { firstByteLatencyHistoryMs = JSON.parse(r.first_byte_latency_history_json as string) as number[]; } catch (e) { console.error("Failed to parse first_byte_latency_history_json:", e); }
  }
  if (r.total_latency_history_json) {
    try { totalLatencyHistoryMs = JSON.parse(r.total_latency_history_json as string) as number[]; } catch (e) { console.error("Failed to parse total_latency_history_json:", e); }
  }
  return {
    score: r.score as number,
    lastSuccessAt: r.last_success_at as number | null,
    lastFailureAt: r.last_failure_at as number | null,
    failureClass: r.failure_class as string | null,
    updatedAt: r.updated_at as number,
    successCount: (r.success_count as number) ?? 0,
    failureCount: (r.failure_count as number) ?? 0,
    consecutiveFailureCount: (r.consecutive_failure_count as number) ?? 0,
    latencyEmaMs: r.latency_ema_ms as number | null,
    latencySampleCount: (r.latency_sample_count as number) ?? 0,
    recentOutcomes,
    firstByteLatencyHistoryMs,
    totalLatencyHistoryMs,
  };
}

// Type alias for the Durable Object's SQL storage
type SqlStorage = {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
};

type DurableObjectStorageLike = {
  sql: SqlStorage;
  transactionSync?: <T>(fn: () => T) => T;
};
