// ControlPlaneStateDO: Durable Object for strongly consistent routing state.
// Delegates admission/circuit/health logic to the unified admission engine
// via SqlStorageAdapter. Retains schema management and query/reporting methods.

import { DurableObject } from "cloudflare:workers";
import type { FailureClass } from "../config/schema";
import type { AdmissionRequest, AdmissionResponse } from "./admission-engine";
import * as engine from "./admission-engine";
import { SqlStorageAdapter } from "./sql-adapter";
import { safeJsonParse } from "../utils/result";
import { clientRateLimitBucket as clientRateBucket } from "../security/rate-limit";

// ─── Schema migrations ────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS key_windows (
    key_ref TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key_ref, window_start)
  );

  CREATE TABLE IF NOT EXISTS group_windows (
    group_name TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_name, window_start)
  );

  CREATE TABLE IF NOT EXISTS reservations (
    reservation_id TEXT PRIMARY KEY,
    key_ref TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS inflight (
    deployment_id TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cooldowns (
    scope TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    until INTEGER NOT NULL,
    details_json TEXT
  );

  CREATE TABLE IF NOT EXISTS circuits (
    deployment_id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'closed',
    failure_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    opened_at INTEGER,
    half_open_after INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS health_scores (
    deployment_id TEXT PRIMARY KEY,
    score REAL NOT NULL DEFAULT 100.0,
    last_success_at INTEGER,
    last_failure_at INTEGER,
    failure_class TEXT,
    updated_at INTEGER NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
    latency_ema_ms REAL,
    latency_sample_count INTEGER NOT NULL DEFAULT 0,
    recent_outcomes_json TEXT,
    first_byte_latency_history_json TEXT,
    total_latency_history_json TEXT
  );

  CREATE TABLE IF NOT EXISTS learned_limits (
    deployment_id TEXT PRIMARY KEY,
    max_parallel INTEGER NOT NULL,
    reason TEXT,
    expires_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS route_dispatch_memory (
    canonical_target TEXT PRIMARY KEY,
    group_name TEXT NOT NULL,
    dispatched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS route_dispatch_memory_by_class (
    canonical_target TEXT NOT NULL,
    request_class TEXT NOT NULL,
    group_name TEXT NOT NULL,
    dispatched_at INTEGER NOT NULL,
    PRIMARY KEY (canonical_target, request_class)
  );

  CREATE TABLE IF NOT EXISTS receipts (
    request_id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    original_model TEXT NOT NULL,
    client_id TEXT,
    app_id TEXT,
    user_hash TEXT,
    policy_id TEXT,
    policy_version TEXT,
    route_version TEXT,
    denial_reason TEXT,
    route_decision_json TEXT,
    canonical_target TEXT NOT NULL,
    selected_group TEXT NOT NULL,
    fallback_groups TEXT NOT NULL,
    attempts_json TEXT NOT NULL,
    final_outcome TEXT NOT NULL,
    stream INTEGER NOT NULL DEFAULT 0,
    total_duration_ms INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_receipts_timestamp ON receipts(timestamp);

  CREATE TABLE IF NOT EXISTS client_request_events (
    request_id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    app_id TEXT,
    user_hash TEXT,
    policy_id TEXT,
    policy_version TEXT,
    route_version TEXT,
    denial_reason TEXT,
    route_decision_json TEXT,
    original_model TEXT NOT NULL,
    canonical_target TEXT NOT NULL,
    selected_group TEXT NOT NULL,
    final_outcome TEXT NOT NULL,
    stream INTEGER NOT NULL DEFAULT 0,
    total_duration_ms INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_client_requests_client_time ON client_request_events(client_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_client_requests_app_time ON client_request_events(app_id, timestamp);

  CREATE TABLE IF NOT EXISTS client_rate_windows (
    client_id TEXT NOT NULL,
    user_hash TEXT NOT NULL DEFAULT '',
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (client_id, user_hash, window_start)
  );

  CREATE TABLE IF NOT EXISTS client_inflight (
    reservation_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    user_hash TEXT NOT NULL DEFAULT '',
    estimated_tokens INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_client_inflight_scope ON client_inflight(client_id, user_hash, expires_at);

  CREATE TABLE IF NOT EXISTS failed_request_receipts (
    request_id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    original_model TEXT NOT NULL,
    route TEXT,
    canonical_target TEXT,
    selected_group TEXT,
    selected_model TEXT,
    final_outcome TEXT NOT NULL,
    failure_class TEXT,
    issue_code TEXT,
    request_source TEXT,
    attempts_count INTEGER NOT NULL,
    summary_json TEXT NOT NULL,
    receipt_json TEXT,
    written_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_failed_timestamp ON failed_request_receipts(timestamp);
  CREATE INDEX IF NOT EXISTS idx_failed_route ON failed_request_receipts(route);
  CREATE INDEX IF NOT EXISTS idx_failed_group ON failed_request_receipts(selected_group);
  CREATE INDEX IF NOT EXISTS idx_failed_selected_model ON failed_request_receipts(selected_model);
  CREATE INDEX IF NOT EXISTS idx_failed_failure_class ON failed_request_receipts(failure_class);
  CREATE INDEX IF NOT EXISTS idx_failed_issue_code ON failed_request_receipts(issue_code);
  CREATE INDEX IF NOT EXISTS idx_failed_request_source ON failed_request_receipts(request_source);

  CREATE INDEX IF NOT EXISTS idx_reservations_expires ON reservations(expires_at);

  CREATE TABLE IF NOT EXISTS usage_events (
    request_id TEXT NOT NULL,
    attempt_index INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    client_id TEXT,
    app_id TEXT,
    user_hash TEXT,
    policy_id TEXT,
    policy_version TEXT,
    route_version TEXT,
    canonical_target TEXT NOT NULL,
    selected_group TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    stream INTEGER NOT NULL,
    final_outcome TEXT NOT NULL,
    usage_kind TEXT NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    usage_source TEXT NOT NULL,
    PRIMARY KEY (request_id, attempt_index)
  );

  CREATE INDEX IF NOT EXISTS idx_usage_group_time ON usage_events(selected_group, timestamp);
  CREATE INDEX IF NOT EXISTS idx_usage_deployment_time ON usage_events(deployment_id, timestamp);

  CREATE TABLE IF NOT EXISTS usage_rollups_hourly (
    hour_start INTEGER NOT NULL,
    selected_group TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    known_requests INTEGER NOT NULL DEFAULT 0,
    unknown_requests INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour_start, selected_group, deployment_id, provider, model)
  );

  CREATE INDEX IF NOT EXISTS idx_rollups_hour ON usage_rollups_hourly(hour_start);

  CREATE TABLE IF NOT EXISTS client_usage_rollups_hourly (
    hour_start INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    app_id TEXT NOT NULL DEFAULT '',
    selected_group TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    known_requests INTEGER NOT NULL DEFAULT 0,
    unknown_requests INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour_start, client_id, app_id, selected_group, deployment_id, provider, model)
  );

  CREATE INDEX IF NOT EXISTS idx_client_rollups_hour ON client_usage_rollups_hourly(hour_start);
  CREATE INDEX IF NOT EXISTS idx_client_rollups_client_hour ON client_usage_rollups_hourly(client_id, hour_start);
  CREATE INDEX IF NOT EXISTS idx_client_rollups_app_hour ON client_usage_rollups_hourly(app_id, hour_start);

  CREATE TABLE IF NOT EXISTS key_token_windows (
    key_ref TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key_ref, window_start)
  );

  CREATE TABLE IF NOT EXISTS canary_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    deployment_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    success INTEGER NOT NULL,
    failure_class TEXT,
    latency_ms INTEGER,
    status_code INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_canary_timestamp ON canary_results(timestamp);
`;

// Re-export types that consumers depend on
export type { AdmissionRequest, AdmissionResponse } from "./admission-engine";

// ─── Durable Object ───────────────────────────────────────────────

export class ControlPlaneStateDO extends DurableObject {
  private initialized = false;
  private learnedConcurrencyEnabled = false;
  private learnedConcurrencyTtlSeconds = 300;
  private store: SqlStorageAdapter | null = null;

  private ensureSchema() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(SCHEMA);
    this.ensureColumn("health_scores", "success_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("health_scores", "failure_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("health_scores", "consecutive_failure_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("health_scores", "latency_ema_ms", "REAL");
    this.ensureColumn("health_scores", "latency_sample_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("health_scores", "recent_outcomes_json", "TEXT");
    this.ensureColumn("health_scores", "first_byte_latency_history_json", "TEXT");
    this.ensureColumn("health_scores", "total_latency_history_json", "TEXT");
    this.ensureColumn("receipts", "total_duration_ms", "INTEGER");
    this.ensureColumn("receipts", "client_id", "TEXT");
    this.ensureColumn("receipts", "app_id", "TEXT");
    this.ensureColumn("receipts", "user_hash", "TEXT");
    this.ensureColumn("receipts", "policy_id", "TEXT");
    this.ensureColumn("receipts", "policy_version", "TEXT");
    this.ensureColumn("receipts", "route_version", "TEXT");
    this.ensureColumn("receipts", "denial_reason", "TEXT");
    this.ensureColumn("receipts", "route_decision_json", "TEXT");
    this.ensureColumn("usage_events", "client_id", "TEXT");
    this.ensureColumn("usage_events", "app_id", "TEXT");
    this.ensureColumn("usage_events", "user_hash", "TEXT");
    this.ensureColumn("usage_events", "policy_id", "TEXT");
    this.ensureColumn("usage_events", "policy_version", "TEXT");
    this.ensureColumn("usage_events", "route_version", "TEXT");
    this.ensureColumn("usage_events", "estimated_cost_usd", "REAL");
    this.ensureColumn("receipts", "session_id", "TEXT");
    this.ensureColumn("receipts", "trace_id", "TEXT");
    this.ensureColumn("receipts", "properties_json", "TEXT");
    this.ensureColumn("usage_rollups_hourly", "estimated_cost_usd", "REAL");
    this.ensureColumn("client_usage_rollups_hourly", "estimated_cost_usd", "REAL");
    this.ensureColumn("client_request_events", "route_decision_json", "TEXT");
    this.ensureColumn("client_request_events", "policy_version", "TEXT");
    this.ensureColumn("client_request_events", "route_version", "TEXT");
    this.ensureColumn("client_request_events", "denial_reason", "TEXT");
    this.ensureColumn("client_inflight", "estimated_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("usage_events", "team_id", "TEXT");
    this.ensureColumn("client_inflight", "team_id", "TEXT");
    this.ensureColumn("failed_request_receipts", "route", "TEXT");
    this.ensureColumn("failed_request_receipts", "selected_model", "TEXT");
    this.ensureColumn("failed_request_receipts", "issue_code", "TEXT");
    this.ensureColumn("failed_request_receipts", "request_source", "TEXT");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_receipts_client_time ON receipts(client_id, timestamp)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_usage_client_time ON usage_events(client_id, timestamp)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_failed_route ON failed_request_receipts(route)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_failed_selected_model ON failed_request_receipts(selected_model)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_failed_issue_code ON failed_request_receipts(issue_code)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_failed_request_source ON failed_request_receipts(request_source)");
    this.store = new SqlStorageAdapter(this.ctx.storage);
    this.initialized = true;
  }

  private ensureColumn(tableName: string, columnName: string, definition: string) {
    if (!/^[a-z_][a-z0-9_]*$/.test(tableName) || !/^[a-z_][a-z0-9_]*$/.test(columnName)) return;
    const columns = this.ctx.storage.sql.exec(`PRAGMA table_info(${tableName})`).toArray();
    if (columns.some((column) => column.name === columnName)) return;
    this.ctx.storage.sql.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  private markReservationConfirmed(reservationId: string): void {
    const res = this.store!.confirmReservation(reservationId);
    if (res) {
      const current = this.store!.getInflight(res.deploymentId);
      this.store!.setInflight(res.deploymentId, current, Date.now());
    }
  }

  // ─── Admission (delegated to engine) ────────────────────────────

  async admit(req: AdmissionRequest): Promise<AdmissionResponse> {
    this.ensureSchema();
    if ((req.learnedConcurrencyEnabled !== null && req.learnedConcurrencyEnabled !== undefined)) this.learnedConcurrencyEnabled = req.learnedConcurrencyEnabled;
    if ((req.learnedConcurrencyTtlSeconds !== null && req.learnedConcurrencyTtlSeconds !== undefined)) this.learnedConcurrencyTtlSeconds = req.learnedConcurrencyTtlSeconds;
    const admission = engine.admit(this.store!, req);
    if (admission.admitted && admission.reservationId) {
      this.store!.transaction(() => this.markReservationConfirmed(admission.reservationId!));
    }
    return admission;
  }

  async confirm(reservationId: string): Promise<void> {
    this.ensureSchema();
    this.store!.transaction(() => this.markReservationConfirmed(reservationId));
  }

  async release(reservationId: string): Promise<void> {
    this.ensureSchema();
    engine.release(this.store!, reservationId);
  }

  // ─── Health recording (delegated to engine) ───────────────────

  async recordSuccess(deploymentId: string, circuitSuccessThreshold?: number, durationMs?: number, latencyConfig?: { emaAlpha?: number; penaltyFactor?: number; warmupSamples?: number }, options?: engine.RecordSuccessOptions): Promise<void> {
    this.ensureSchema();
    engine.recordSuccess(
      this.store!, deploymentId, circuitSuccessThreshold, durationMs, latencyConfig,
      this.learnedConcurrencyEnabled, this.learnedConcurrencyTtlSeconds, options,
    );
  }

  async recordFailure(
    deploymentId: string,
    failureClass: FailureClass,
    cooldownSeconds: number,
    circuitThreshold: number,
    circuitDurationSeconds: number,
    suspectThresholdFraction?: number,
    options?: engine.RecordFailureOptions,
  ): Promise<void> {
    this.ensureSchema();
    engine.recordFailure(
      this.store!, deploymentId, failureClass, cooldownSeconds,
      circuitThreshold, circuitDurationSeconds, suspectThresholdFraction,
      this.learnedConcurrencyEnabled, this.learnedConcurrencyTtlSeconds, options,
    );
  }

  // ─── Health snapshot ───────────────────────────────────────────

  async getHealth(): Promise<Record<string, unknown>> {
    this.ensureSchema();
    const now = Date.now();
    const windowCutoff = now - 60_000;
    const scoreRows = this.store!.listHealthScores();
    const circuits = this.ctx.storage.sql.exec("SELECT * FROM circuits").toArray();
    const cooldowns = this.ctx.storage.sql.exec("SELECT * FROM cooldowns").toArray();
    const inflight = this.ctx.storage.sql.exec("SELECT * FROM inflight").toArray();
    const learnedLimits = this.ctx.storage.sql.exec("SELECT * FROM learned_limits").toArray();
    const keyWindows = this.ctx.storage.sql.exec(
      "SELECT key_ref, MIN(window_start) AS window_start, SUM(count) AS count FROM key_windows WHERE window_start >= ? GROUP BY key_ref",
      windowCutoff,
    ).toArray();
    const groupWindows = this.ctx.storage.sql.exec(
      "SELECT group_name, MIN(window_start) AS window_start, SUM(count) AS count FROM group_windows WHERE window_start >= ? GROUP BY group_name",
      windowCutoff,
    ).toArray();
    const tokenWindows = this.ctx.storage.sql.exec(
      "SELECT key_ref, MIN(window_start) AS window_start, SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens FROM key_token_windows WHERE window_start >= ? GROUP BY key_ref",
      windowCutoff,
    ).toArray();
    const routeDispatchMemoryRows = this.ctx.storage.sql.exec(
      `SELECT canonical_target, request_class, group_name, dispatched_at
       FROM route_dispatch_memory_by_class
       WHERE dispatched_at >= ?`,
      now - 86400000,
    ).toArray();
    const routeDispatchMemory: Record<string, Record<string, { group: string; dispatchedAt: number }>> = {};
    for (const row of routeDispatchMemoryRows) {
      const canonicalTarget = row.canonical_target as string;
      const requestClass = row.request_class as string;
      routeDispatchMemory[canonicalTarget] ??= {};
      routeDispatchMemory[canonicalTarget][requestClass] = {
        group: row.group_name as string,
        dispatchedAt: row.dispatched_at as number,
      };
    }
    return {
      healthScores: Object.fromEntries(scoreRows.map(({ deploymentId, score }) => [deploymentId, mapHealthScoreRow(score)])),
      circuits: Object.fromEntries(circuits.map((row) => [row.deployment_id as string, mapCircuitRow(row)])),
      cooldowns: Object.fromEntries(cooldowns.map((row) => [row.scope as string, {
        reason: row.reason,
        until: row.until,
        details: safeJsonParse(row.details_json as string | null),
      }])),
      inflight: Object.fromEntries(inflight.map((row) => [row.deployment_id as string, {
        count: row.count,
        updatedAt: row.updated_at,
      }])),
      learnedLimits: Object.fromEntries(learnedLimits.map((row) => [row.deployment_id as string, {
        maxParallel: row.max_parallel,
        reason: row.reason,
        expiresAt: row.expires_at,
      }])),
      keyWindows: Object.fromEntries(keyWindows.map((row) => [row.key_ref as string, {
        windowStart: row.window_start,
        count: row.count,
      }])),
      groupWindows: Object.fromEntries(groupWindows.map((row) => [row.group_name as string, {
        windowStart: row.window_start,
        count: row.count,
      }])),
      tokenWindows: Object.fromEntries(tokenWindows.map((row) => [row.key_ref as string, {
        windowStart: row.window_start,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
      }])),
      routeDispatchMemory,
      scores: scoreRows.map(({ deploymentId, score }) => ({ deployment_id: deploymentId, ...mapHealthScoreRow(score) })),
      timestamp: now,
    };
  }

  // ─── Route dispatch memory ─────────────────────────────────────

  async recordRouteDispatch(canonicalTarget: string, requestClass: string, groupName: string): Promise<void> {
    this.ensureSchema();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO route_dispatch_memory_by_class
         (canonical_target, request_class, group_name, dispatched_at) VALUES (?, ?, ?, ?)`,
      canonicalTarget, requestClass, groupName, now,
    );
    this.ctx.storage.sql.exec("DELETE FROM route_dispatch_memory_by_class WHERE dispatched_at < ?", now - 86400000);
  }

  async getRecentRouteDispatch(canonicalTarget: string, requestClass: string, maxAgeSeconds: number): Promise<Record<string, unknown> | null> {
    this.ensureSchema();
    const cutoff = Date.now() - maxAgeSeconds * 1000;
    const rows = this.ctx.storage.sql.exec(
      `SELECT group_name, dispatched_at FROM route_dispatch_memory_by_class
       WHERE canonical_target = ? AND request_class = ? AND dispatched_at >= ?`,
      canonicalTarget, requestClass, cutoff,
    ).toArray();
    if (rows.length === 0) return null;
    return { group: rows[0].group_name, dispatchedAt: rows[0].dispatched_at };
  }

  // ─── Clear cooldowns (admin) ──────────────────────────────────

  async clearCooldowns(deploymentId?: string): Promise<void> {
    this.ensureSchema();
    this.store!.clearCooldowns(deploymentId);
  }

  // ─── Token usage recording ────────────────────────────────────

  async recordTokenUsage(keyRef: string, promptTokens: number, completionTokens: number): Promise<void> {
    this.ensureSchema();
    const now = Date.now();
    const bucketStart = Math.floor(now / 1000) * 1000;
    this.store!.addTokenUsage(keyRef, bucketStart, promptTokens, completionTokens);
  }

  // ─── Receipts ──────────────────────────────────────────────────

  async storeReceipt(receipt: {
    requestId: string; timestamp: number; originalModel: string;
    clientId?: string; appId?: string; userHash?: string; policyId?: string;
    policyVersion?: string; routeVersion?: string; denialReason?: string;
    routeDecision?: unknown;
    canonicalTarget: string; selectedGroup: string; fallbackGroups: string[];
    attempts: unknown[]; finalOutcome: string;
    stream: boolean; totalDurationMs?: number;
    sessionId?: string; traceId?: string; properties?: Record<string, string>;
  }): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO receipts
         (request_id, timestamp, original_model, client_id, app_id, user_hash, policy_id, policy_version,
          route_version, denial_reason, route_decision_json, canonical_target, selected_group, fallback_groups,
          attempts_json, final_outcome, stream, total_duration_ms, session_id, trace_id, properties_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      receipt.requestId, receipt.timestamp, receipt.originalModel,
      receipt.clientId ?? null, receipt.appId ?? null, receipt.userHash ?? null, receipt.policyId ?? null,
      receipt.policyVersion ?? null, receipt.routeVersion ?? null, receipt.denialReason ?? null,
      receipt.routeDecision ? JSON.stringify(receipt.routeDecision) : null,
      receipt.canonicalTarget,
      receipt.selectedGroup, JSON.stringify(receipt.fallbackGroups), JSON.stringify(receipt.attempts),
      receipt.finalOutcome, receipt.stream ? 1 : 0, receipt.totalDurationMs ?? null,
      receipt.sessionId ?? null, receipt.traceId ?? null,
      receipt.properties ? JSON.stringify(receipt.properties) : null,
    );
    this.ctx.storage.sql.exec("DELETE FROM receipts WHERE timestamp < ?", Date.now() - 86400000);
  }

  async storeClientRequest(event: {
    requestId: string; timestamp: number; clientId: string;
    appId?: string; userHash?: string; policyId?: string;
    policyVersion?: string; routeVersion?: string; denialReason?: string;
    routeDecision?: unknown;
    originalModel: string; canonicalTarget: string; selectedGroup: string;
    finalOutcome: string; stream: boolean; totalDurationMs?: number;
  }): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO client_request_events
         (request_id, timestamp, client_id, app_id, user_hash, policy_id, policy_version, route_version, denial_reason,
          route_decision_json, original_model, canonical_target, selected_group, final_outcome, stream, total_duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.requestId, event.timestamp, event.clientId,
      event.appId ?? null, event.userHash ?? null, event.policyId ?? null,
      event.policyVersion ?? null, event.routeVersion ?? null, event.denialReason ?? null,
      event.routeDecision ? JSON.stringify(event.routeDecision) : null,
      event.originalModel, event.canonicalTarget, event.selectedGroup,
      event.finalOutcome, event.stream ? 1 : 0, event.totalDurationMs ?? null,
    );
    this.ctx.storage.sql.exec("DELETE FROM client_request_events WHERE timestamp < ?", Date.now() - 30 * 86400000);
  }

  async admitClientRequest(req: {
    requestId: string; clientId: string; appId?: string; userHash?: string;
    rateLimitSegment?: string;
    teamId?: string;
    teamRpmLimit?: number | null;
    teamMaxConcurrency?: number | null;
    teamTokenBudgetPerMinute?: number | null;
    rpmLimit?: number | null; maxConcurrency?: number | null; tokenBudgetPerMinute?: number | null; estimatedTokens?: number | null;
  }): Promise<{ admitted: boolean; reservationId: string; teamReservationId?: string; reason?: string; message?: string; resetAt?: number }> {
    this.ensureSchema();
    const now = Date.now();
    const userHash = clientRateBucket(req.userHash, req.rateLimitSegment);
    const windowStart = Math.floor(now / 60000) * 60000;
    const reservationId = `${req.clientId}:${req.requestId}`;
    const teamClientId = req.teamId ? `team:${req.teamId}` : null;
    return this.store!.transaction(() => {
      this.ctx.storage.sql.exec("DELETE FROM client_inflight WHERE expires_at < ?", now);
      this.ctx.storage.sql.exec("DELETE FROM client_rate_windows WHERE window_start < ?", now - 10 * 60000);

      if (teamClientId && req.teamRpmLimit && req.teamRpmLimit > 0) {
        const rows = this.ctx.storage.sql.exec(
          "SELECT count FROM client_rate_windows WHERE client_id = ? AND user_hash = ? AND window_start = ?",
          teamClientId, "", windowStart,
        ).toArray();
        const count = Number(rows[0]?.count ?? 0);
        if (count >= req.teamRpmLimit) {
          return {
            admitted: false,
            reservationId,
            reason: "team_rpm_exceeded",
            message: "team RPM limit exceeded",
            resetAt: windowStart + 60000,
          };
        }
      }

      if (teamClientId && req.teamMaxConcurrency && req.teamMaxConcurrency > 0) {
        const rows = this.ctx.storage.sql.exec(
          "SELECT COUNT(*) AS count FROM client_inflight WHERE client_id = ? AND user_hash = ?",
          teamClientId, "",
        ).toArray();
        const count = Number(rows[0]?.count ?? 0);
        if (count >= req.teamMaxConcurrency) {
          return {
            admitted: false,
            reservationId,
            reason: "team_concurrency_exceeded",
            message: "team concurrency limit exceeded",
          };
        }
      }

      if (req.rpmLimit && req.rpmLimit > 0) {
        const rows = this.ctx.storage.sql.exec(
          "SELECT count FROM client_rate_windows WHERE client_id = ? AND user_hash = ? AND window_start = ?",
          req.clientId, userHash, windowStart,
        ).toArray();
        const count = Number(rows[0]?.count ?? 0);
        if (count >= req.rpmLimit) {
          return {
            admitted: false,
            reservationId,
            reason: "client_rpm_exceeded",
            message: "client RPM limit exceeded",
            resetAt: windowStart + 60000,
          };
        }
      }

      if (req.maxConcurrency && req.maxConcurrency > 0) {
        const rows = this.ctx.storage.sql.exec(
          "SELECT COUNT(*) AS count FROM client_inflight WHERE client_id = ? AND user_hash = ?",
          req.clientId, userHash,
        ).toArray();
        const count = Number(rows[0]?.count ?? 0);
        if (count >= req.maxConcurrency) {
          return {
            admitted: false,
            reservationId,
            reason: "client_concurrency_exceeded",
            message: "client concurrency limit exceeded",
          };
        }
      }

      if (req.teamId && req.teamTokenBudgetPerMinute && req.teamTokenBudgetPerMinute > 0) {
        const rows = this.ctx.storage.sql.exec(
          `SELECT COALESCE(SUM(total_tokens), 0) AS total
           FROM usage_events
           WHERE team_id = ? AND timestamp >= ? AND timestamp < ?`,
          req.teamId, windowStart, windowStart + 60000,
        ).toArray();
        const used = Number(rows[0]?.total ?? 0);
        const inflightRows = this.ctx.storage.sql.exec(
          "SELECT COALESCE(SUM(estimated_tokens), 0) AS total FROM client_inflight WHERE team_id = ?",
          req.teamId,
        ).toArray();
        const reserved = Number(inflightRows[0]?.total ?? 0);
        const estimated = typeof req.estimatedTokens === "number" && Number.isFinite(req.estimatedTokens) && req.estimatedTokens >= 0
          ? Math.ceil(req.estimatedTokens)
          : null;
        if (used >= req.teamTokenBudgetPerMinute) {
          return {
            admitted: false,
            reservationId,
            reason: "team_token_budget_exceeded",
            message: "team token budget exceeded",
            resetAt: windowStart + 60000,
          };
        }
        if (estimated === null) {
          return {
            admitted: false,
            reservationId,
            reason: "team_token_estimate_required",
            message: "team token estimate required",
            resetAt: windowStart + 60000,
          };
        }
        if (used + reserved + estimated > req.teamTokenBudgetPerMinute) {
          return {
            admitted: false,
            reservationId,
            reason: "team_token_budget_exceeded",
            message: "team token budget exceeded",
            resetAt: windowStart + 60000,
          };
        }
      }

      if (req.tokenBudgetPerMinute && req.tokenBudgetPerMinute > 0) {
        const rows = this.ctx.storage.sql.exec(
          `SELECT COALESCE(SUM(total_tokens), 0) AS total
           FROM usage_events
           WHERE client_id = ? AND COALESCE(user_hash, '') = ? AND timestamp >= ? AND timestamp < ?`,
          req.clientId, userHash, windowStart, windowStart + 60000,
        ).toArray();
        const used = Number(rows[0]?.total ?? 0);
        const inflightRows = this.ctx.storage.sql.exec(
          "SELECT COALESCE(SUM(estimated_tokens), 0) AS total FROM client_inflight WHERE client_id = ? AND user_hash = ?",
          req.clientId, userHash,
        ).toArray();
        const reserved = Number(inflightRows[0]?.total ?? 0);
        const estimated = typeof req.estimatedTokens === "number" && Number.isFinite(req.estimatedTokens) && req.estimatedTokens >= 0
          ? Math.ceil(req.estimatedTokens)
          : null;
        if (used >= req.tokenBudgetPerMinute) {
          return {
            admitted: false,
            reservationId,
            reason: "client_token_budget_exceeded",
            message: "client token budget exceeded",
            resetAt: windowStart + 60000,
          };
        }
        if (estimated === null) {
          return {
            admitted: false,
            reservationId,
            reason: "client_token_estimate_required",
            message: "client token estimate required",
            resetAt: windowStart + 60000,
          };
        }
        if (used + reserved + estimated > req.tokenBudgetPerMinute) {
          return {
            admitted: false,
            reservationId,
            reason: "client_token_budget_exceeded",
            message: "client token budget exceeded",
            resetAt: windowStart + 60000,
          };
        }
      }

      if (teamClientId && req.teamRpmLimit && req.teamRpmLimit > 0) {
        this.ctx.storage.sql.exec(
          `INSERT INTO client_rate_windows (client_id, user_hash, window_start, count)
           VALUES (?, ?, ?, 1)
           ON CONFLICT(client_id, user_hash, window_start) DO UPDATE SET count = count + 1`,
          teamClientId, "", windowStart,
        );
      }
      if (req.rpmLimit && req.rpmLimit > 0) {
        this.ctx.storage.sql.exec(
          `INSERT INTO client_rate_windows (client_id, user_hash, window_start, count)
           VALUES (?, ?, ?, 1)
           ON CONFLICT(client_id, user_hash, window_start) DO UPDATE SET count = count + 1`,
          req.clientId, userHash, windowStart,
        );
      }
      const teamNeedsInflight = teamClientId && (
        (req.teamMaxConcurrency && req.teamMaxConcurrency > 0)
        || (req.teamTokenBudgetPerMinute && req.teamTokenBudgetPerMinute > 0)
      );
      if (teamNeedsInflight) {
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO client_inflight
             (reservation_id, request_id, client_id, user_hash, estimated_tokens, team_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          `${teamClientId}:${req.requestId}`, req.requestId, teamClientId, "",
          Math.max(0, Math.ceil(req.estimatedTokens ?? 0)), req.teamId ?? null, now, now + 10 * 60000,
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO client_inflight
           (reservation_id, request_id, client_id, user_hash, estimated_tokens, team_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        reservationId, req.requestId, req.clientId, userHash,
        Math.max(0, Math.ceil(req.estimatedTokens ?? 0)), req.teamId ?? null, now, now + 10 * 60000,
      );
      const teamReservationId = teamNeedsInflight ? `${teamClientId}:${req.requestId}` : undefined;
      return { admitted: true, reservationId, teamReservationId };
    });
  }

  async releaseClientRequest(reservationId: string): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec("DELETE FROM client_inflight WHERE reservation_id = ?", reservationId);
  }

  async queryClientRequests(filters: {
    clientId?: string; appId?: string; since?: number; until?: number; limit?: number;
  }): Promise<Record<string, unknown>[]> {
    this.ensureSchema();
    const limit = clampLimit(filters.limit, 1000, 5000);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.clientId) { conditions.push("client_id = ?"); params.push(filters.clientId); }
    if (filters.appId) { conditions.push("app_id = ?"); params.push(filters.appId); }
    if (filters.since) { conditions.push("timestamp >= ?"); params.push(filters.since); }
    if (filters.until) { conditions.push("timestamp <= ?"); params.push(filters.until); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.ctx.storage.sql.exec(`SELECT * FROM client_request_events ${where} ORDER BY timestamp DESC LIMIT ?`, ...params, limit).toArray().map(mapClientRequestRow);
  }

  async getReceipt(requestId: string): Promise<Record<string, unknown> | null> {
    this.ensureSchema();
    const rows = this.ctx.storage.sql.exec("SELECT * FROM receipts WHERE request_id = ?", requestId).toArray();
    if (rows.length === 0) return null;
    return mapReceiptRow(rows[0]);
  }

  async getRecentReceipts(limit = 200): Promise<Record<string, unknown>[]> {
    this.ensureSchema();
    return this.ctx.storage.sql.exec("SELECT * FROM receipts ORDER BY timestamp DESC LIMIT ?", clampLimit(limit, 200, 5000)).toArray().map(mapReceiptRow);
  }

  // ─── Canary results ────────────────────────────────────────────

  async storeCanaryResult(result: {
    deploymentId: string; group: string; success: boolean;
    failureClass?: string; latencyMs: number; statusCode?: number;
  }): Promise<void> {
    this.ensureSchema();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO canary_results (timestamp, deployment_id, group_name, success, failure_class, latency_ms, status_code) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      now, result.deploymentId, result.group, result.success ? 1 : 0,
      result.failureClass ?? null, result.latencyMs, result.statusCode ?? null,
    );
    const count = this.ctx.storage.sql.exec("SELECT COUNT(*) as cnt FROM canary_results").toArray();
    const total = (count[0]?.cnt as number) ?? 0;
    if (total > 100) {
      this.ctx.storage.sql.exec("DELETE FROM canary_results WHERE id IN (SELECT id FROM canary_results ORDER BY timestamp ASC LIMIT ?)", total - 100);
    }
  }

  async getCanaryResults(limit = 50): Promise<Record<string, unknown>[]> {
    this.ensureSchema();
    return this.ctx.storage.sql.exec("SELECT * FROM canary_results ORDER BY timestamp DESC LIMIT ?", clampLimit(limit, 50, 500)).toArray().map(mapCanaryResultRow);
  }

  // ─── Reap expired leases ──────────────────────────────────────

  async reapExpired(): Promise<number> {
    this.ensureSchema();
    const now = Date.now();
    const expired = this.ctx.storage.sql.exec(
      "SELECT reservation_id FROM reservations WHERE expires_at < ? AND confirmed = 0", now,
    ).toArray();
    for (const row of expired) await this.release(row.reservation_id as string);
    // Confirmed reservations are released explicitly when streams/requests complete;
    // do not reap them on admit TTL or long streams lose inflight and over-admit.
    this.ctx.storage.sql.exec("DELETE FROM learned_limits WHERE expires_at IS NOT NULL AND expires_at < ?", now);
    this.ctx.storage.sql.exec("DELETE FROM key_token_windows WHERE window_start < ?", now - 60_000);
    engine.decayIdleHealthScores(this.store!, now);
    return expired.length;
  }

  // ─── Failed request storage ────────────────────────────────────

  async storeFailedRequest(summary: {
    requestId: string; timestamp: number; originalModel: string;
    route?: string; canonicalTarget: string; selectedGroup: string; selectedModel?: string;
    finalOutcome: string; failureClass?: string; issueCode?: string; requestSource?: string;
    attemptsCount: number; summaryJson: string; receiptJson?: string;
  }): Promise<void> {
    this.ensureSchema();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO failed_request_receipts
        (request_id, timestamp, original_model, route, canonical_target, selected_group,
         selected_model, final_outcome, failure_class, issue_code, request_source,
         attempts_count, summary_json, receipt_json, written_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      summary.requestId, summary.timestamp, summary.originalModel,
      summary.route ?? summary.canonicalTarget, summary.canonicalTarget, summary.selectedGroup,
      summary.selectedModel ?? summary.selectedGroup, summary.finalOutcome,
      summary.failureClass ?? null, summary.issueCode ?? null, summary.requestSource ?? null,
      summary.attemptsCount,
      summary.summaryJson, summary.receiptJson ?? null, now,
    );
    this.ctx.storage.sql.exec("DELETE FROM failed_request_receipts WHERE timestamp < ?", now - 7 * 86400000);
  }

  async queryFailedRequests(filters: {
    requestId?: string; route?: string; selectedGroup?: string; group?: string;
    selectedModel?: string; failureClass?: string; issueCode?: string;
    requestSource?: string; since?: number; until?: number; limit?: number;
    includeReceipt?: boolean;
  }): Promise<Record<string, unknown>[]> {
    this.ensureSchema();
    const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 100), 1), 500);
    const select = filters.includeReceipt ? "*" : "request_id, timestamp, original_model, route, canonical_target, selected_group, selected_model, final_outcome, failure_class, issue_code, request_source, attempts_count, summary_json, written_at";
    if (filters.requestId) {
      return this.ctx.storage.sql.exec(
        `SELECT ${select} FROM failed_request_receipts WHERE request_id = ?`,
        filters.requestId,
      ).toArray().map((row) => mapFailedRequestRow(row, Boolean(filters.includeReceipt)));
    }
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.route) {
      conditions.push("(route = ? OR (route IS NULL AND canonical_target = ?))");
      params.push(filters.route, filters.route);
    }
    const selectedGroup = filters.selectedGroup ?? filters.group;
    if (selectedGroup) { conditions.push("selected_group = ?"); params.push(selectedGroup); }
    if (filters.selectedModel) { conditions.push("selected_model = ?"); params.push(filters.selectedModel); }
    if (filters.failureClass) { conditions.push("failure_class = ?"); params.push(filters.failureClass); }
    if (filters.issueCode) { conditions.push("issue_code = ?"); params.push(filters.issueCode); }
    if (filters.requestSource) { conditions.push("request_source = ?"); params.push(filters.requestSource); }
    if (filters.since !== undefined) { conditions.push("timestamp >= ?"); params.push(filters.since); }
    if (filters.until !== undefined) { conditions.push("timestamp <= ?"); params.push(filters.until); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.ctx.storage.sql.exec(
      `SELECT ${select} FROM failed_request_receipts ${where} ORDER BY timestamp DESC LIMIT ?`,
      ...params,
      limit,
    ).toArray().map((row) => mapFailedRequestRow(row, Boolean(filters.includeReceipt)));
  }

  // ─── Usage events ──────────────────────────────────────────────

  async storeUsageEvent(event: {
    requestId: string; attemptIndex: number; timestamp: number;
    clientId?: string; appId?: string; userHash?: string; teamId?: string; policyId?: string;
    policyVersion?: string; routeVersion?: string;
    canonicalTarget: string; selectedGroup: string; deploymentId: string;
    provider: string; model: string; stream: boolean; finalOutcome: string;
    usageKind: string; promptTokens: number | null; completionTokens: number | null;
    totalTokens: number | null; usageSource: string; estimatedCostUsd?: number | null;
  }): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO usage_events
         (request_id, attempt_index, timestamp, client_id, app_id, user_hash, team_id, policy_id, policy_version, route_version,
          canonical_target, selected_group,
          deployment_id, provider, model, stream, final_outcome,
          usage_kind, prompt_tokens, completion_tokens, total_tokens, usage_source, estimated_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.requestId, event.attemptIndex, event.timestamp,
      event.clientId ?? null, event.appId ?? null, event.userHash ?? null, event.teamId ?? null, event.policyId ?? null,
      event.policyVersion ?? null, event.routeVersion ?? null,
      event.canonicalTarget, event.selectedGroup, event.deploymentId,
      event.provider, event.model, event.stream ? 1 : 0, event.finalOutcome,
      event.usageKind, event.promptTokens, event.completionTokens,
      event.totalTokens, event.usageSource, event.estimatedCostUsd ?? null,
    );
    this.ctx.storage.sql.exec("DELETE FROM usage_events WHERE timestamp < ?", Date.now() - 30 * 86400000);
  }

  async queryUsageEvents(filters: {
    group?: string; deploymentId?: string; clientId?: string; appId?: string; since?: number; until?: number; limit?: number;
  }): Promise<Record<string, unknown>[]> {
    this.ensureSchema();
    const limit = clampLimit(filters.limit, 1000, 5000);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.group) { conditions.push("selected_group = ?"); params.push(filters.group); }
    if (filters.deploymentId) { conditions.push("deployment_id = ?"); params.push(filters.deploymentId); }
    if (filters.clientId) { conditions.push("client_id = ?"); params.push(filters.clientId); }
    if (filters.appId) { conditions.push("app_id = ?"); params.push(filters.appId); }
    if (filters.since) { conditions.push("timestamp >= ?"); params.push(filters.since); }
    if (filters.until) { conditions.push("timestamp <= ?"); params.push(filters.until); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.ctx.storage.sql.exec(`SELECT * FROM usage_events ${where} ORDER BY timestamp DESC LIMIT ?`, ...params, limit).toArray().map(mapUsageEventRow);
  }

  async computeHourlyRollups(hourStart?: number): Promise<void> {
    this.ensureSchema();
    const hour = hourStart ?? Math.floor(Date.now() / 3600000) * 3600000;
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO usage_rollups_hourly
         (hour_start, selected_group, deployment_id, provider, model,
          requests, known_requests, unknown_requests, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd)
       SELECT ?, selected_group, deployment_id, provider, model,
         COUNT(*), SUM(CASE WHEN usage_kind = 'known' THEN 1 ELSE 0 END),
         SUM(CASE WHEN usage_kind = 'unknown' THEN 1 ELSE 0 END),
         COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0), COALESCE(SUM(total_tokens), 0),
         COALESCE(SUM(estimated_cost_usd), 0)
       FROM usage_events WHERE timestamp >= ? AND timestamp < ?
       GROUP BY selected_group, deployment_id, provider, model`,
      hour, hour, hour + 3600000,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO client_usage_rollups_hourly
         (hour_start, client_id, app_id, selected_group, deployment_id, provider, model,
          requests, known_requests, unknown_requests, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd)
       SELECT ?, COALESCE(client_id, ''), COALESCE(app_id, ''), selected_group, deployment_id, provider, model,
         COUNT(*), SUM(CASE WHEN usage_kind = 'known' THEN 1 ELSE 0 END),
         SUM(CASE WHEN usage_kind = 'unknown' THEN 1 ELSE 0 END),
         COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0), COALESCE(SUM(total_tokens), 0),
         COALESCE(SUM(estimated_cost_usd), 0)
       FROM usage_events WHERE timestamp >= ? AND timestamp < ? AND client_id IS NOT NULL
       GROUP BY COALESCE(client_id, ''), COALESCE(app_id, ''), selected_group, deployment_id, provider, model`,
      hour, hour, hour + 3600000,
    );
  }

  async queryRollups(filters: {
    group?: string; deploymentId?: string; since?: number; until?: number;
  }): Promise<Record<string, unknown>[]> {
    this.ensureSchema();
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.group) { conditions.push("selected_group = ?"); params.push(filters.group); }
    if (filters.deploymentId) { conditions.push("deployment_id = ?"); params.push(filters.deploymentId); }
    if (filters.since) { conditions.push("hour_start >= ?"); params.push(filters.since); }
    if (filters.until) { conditions.push("hour_start <= ?"); params.push(filters.until); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.ctx.storage.sql.exec(`SELECT * FROM usage_rollups_hourly ${where} ORDER BY hour_start DESC`, ...params).toArray().map(mapRollupRow);
  }

  async queryClientRollups(filters: {
    clientId?: string; appId?: string; group?: string; deploymentId?: string; since?: number; until?: number;
  }): Promise<Record<string, unknown>[]> {
    this.ensureSchema();
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.clientId) { conditions.push("client_id = ?"); params.push(filters.clientId); }
    if (filters.appId) { conditions.push("app_id = ?"); params.push(filters.appId); }
    if (filters.group) { conditions.push("selected_group = ?"); params.push(filters.group); }
    if (filters.deploymentId) { conditions.push("deployment_id = ?"); params.push(filters.deploymentId); }
    if (filters.since) { conditions.push("hour_start >= ?"); params.push(filters.since); }
    if (filters.until) { conditions.push("hour_start <= ?"); params.push(filters.until); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.ctx.storage.sql.exec(`SELECT * FROM client_usage_rollups_hourly ${where} ORDER BY hour_start DESC`, ...params).toArray().map(mapClientRollupRow);
  }
}

// ─── Row mappers ──────────────────────────────────────────────────

function clampLimit(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
  return Math.min(Math.max(Math.trunc(value), 1), maxValue);
}

function mapHealthScoreRow(row: import("./storage-adapter").HealthScoreRow): Record<string, unknown> {
  return {
    score: row.score, lastSuccessAt: row.lastSuccessAt, lastFailureAt: row.lastFailureAt,
    failureClass: row.failureClass, updatedAt: row.updatedAt, successCount: row.successCount,
    failureCount: row.failureCount, consecutiveFailureCount: row.consecutiveFailureCount,
    latencyEmaMs: row.latencyEmaMs, latencySampleCount: row.latencySampleCount,
    recentOutcomes: row.recentOutcomes ?? [],
    rollingMetrics: engine.computeRollingMetrics(row.recentOutcomes ?? []),
  };
}

function mapCircuitRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    state: row.state, failureCount: row.failure_count, successCount: row.success_count,
    openedAt: row.opened_at, halfOpenAfter: row.half_open_after, updatedAt: row.updated_at,
  };
}

function mapFailedRequestRow(row: Record<string, unknown>, includeReceipt = false): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    requestId: row.request_id, timestamp: row.timestamp, originalModel: row.original_model,
    route: row.route ?? row.canonical_target, canonicalTarget: row.canonical_target, selectedGroup: row.selected_group,
    selectedModel: row.selected_model, finalOutcome: row.final_outcome, failureClass: row.failure_class,
    issueCode: row.issue_code, requestSource: row.request_source,
    attemptsCount: row.attempts_count, summary: safeJsonParse(row.summary_json as string),
    writtenAt: row.written_at,
  };
  if (includeReceipt) {
    mapped.receipt = row.receipt_json ? safeJsonParse(row.receipt_json as string) : null;
  }
  return mapped;
}

function mapReceiptRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    requestId: row.request_id, timestamp: row.timestamp, originalModel: row.original_model,
    clientId: row.client_id ?? undefined, appId: row.app_id ?? undefined,
    userHash: row.user_hash ?? undefined, policyId: row.policy_id ?? undefined,
    policyVersion: row.policy_version ?? undefined, routeVersion: row.route_version ?? undefined,
    denialReason: row.denial_reason ?? undefined,
    routeDecision: row.route_decision_json ? safeJsonParse(row.route_decision_json as string) : undefined,
    canonicalTarget: row.canonical_target, selectedGroup: row.selected_group,
    fallbackGroups: safeJsonParse(row.fallback_groups as string),
    attempts: safeJsonParse(row.attempts_json as string), finalOutcome: row.final_outcome,
    stream: row.stream === 1, totalDurationMs: (row.total_duration_ms as number | null) ?? undefined,
  };
}

function mapClientRequestRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    requestId: row.request_id, timestamp: row.timestamp, clientId: row.client_id,
    appId: row.app_id ?? undefined, userHash: row.user_hash ?? undefined,
    policyId: row.policy_id ?? undefined, policyVersion: row.policy_version ?? undefined,
    routeVersion: row.route_version ?? undefined, denialReason: row.denial_reason ?? undefined,
    routeDecision: row.route_decision_json ? safeJsonParse(row.route_decision_json as string) : undefined,
    originalModel: row.original_model,
    canonicalTarget: row.canonical_target, selectedGroup: row.selected_group,
    finalOutcome: row.final_outcome, stream: row.stream === 1,
    totalDurationMs: (row.total_duration_ms as number | null) ?? undefined,
  };
}

function mapUsageEventRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    requestId: row.request_id, attemptIndex: row.attempt_index, timestamp: row.timestamp,
    clientId: row.client_id ?? undefined, appId: row.app_id ?? undefined,
    userHash: row.user_hash ?? undefined, policyId: row.policy_id ?? undefined,
    policyVersion: row.policy_version ?? undefined, routeVersion: row.route_version ?? undefined,
    canonicalTarget: row.canonical_target, selectedGroup: row.selected_group,
    deploymentId: row.deployment_id, provider: row.provider, model: row.model,
    stream: row.stream === 1, finalOutcome: row.final_outcome, usageKind: row.usage_kind,
    promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens, usageSource: row.usage_source,
    estimatedCostUsd: row.estimated_cost_usd ?? null,
  };
}

function mapRollupRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    hourStart: row.hour_start, selectedGroup: row.selected_group,
    deploymentId: row.deployment_id, provider: row.provider, model: row.model,
    requests: row.requests, knownRequests: row.known_requests, unknownRequests: row.unknown_requests,
    promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens, totalTokens: row.total_tokens,
    estimatedCostUsd: row.estimated_cost_usd ?? null,
  };
}

function mapClientRollupRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    hourStart: row.hour_start, clientId: row.client_id, appId: row.app_id || undefined,
    selectedGroup: row.selected_group, deploymentId: row.deployment_id,
    provider: row.provider, model: row.model, requests: row.requests,
    knownRequests: row.known_requests, unknownRequests: row.unknown_requests,
    promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    estimatedCostUsd: row.estimated_cost_usd ?? null,
  };
}

function mapCanaryResultRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id, timestamp: row.timestamp, deploymentId: row.deployment_id,
    group: row.group_name, success: row.success === 1, failureClass: row.failure_class,
    latencyMs: row.latency_ms, statusCode: row.status_code,
  };
}
