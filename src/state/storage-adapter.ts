// Storage adapter interface for the admission engine.
// Production uses SQLite via Durable Object; tests use in-memory Maps.

export interface StorageAdapter {
  // Key/group RPM windows
  pruneKeyWindows(olderThan: number): void;
  getKeyRpm(keyRef: string, since: number): number;
  getGroupRpm(group: string, since: number): number;
  incrementKeyWindow(keyRef: string, bucketStart: number): void;
  incrementGroupWindow(group: string, bucketStart: number): void;

  // Reservations
  insertReservation(reservation: {
    reservationId: string; keyRef: string; deploymentId: string;
    requestId: string; createdAt: number; expiresAt: number;
  }): void;
  confirmReservation(reservationId: string): { deploymentId: string } | null;
  deleteReservation(reservationId: string): { deploymentId: string } | null;
  countReservations(deploymentId: string): number;

  // Inflight
  pruneStaleInflight(olderThan: number): void;
  getInflight(deploymentId: string): number;
  setInflight(deploymentId: string, count: number, updatedAt: number): void;

  // Cooldowns
  getCooldown(deploymentId: string, now: number): boolean;
  setCooldown(deploymentId: string, reason: string, until: number, detailsJson?: string): void;
  clearCooldowns(deploymentId?: string): void;
  clearCredentialCooldown?(credentialId: string): void;

  // Circuits
  getCircuit(deploymentId: string): CircuitRow | null;
  setCircuit(deploymentId: string, circuit: CircuitRow): void;

  // Health scores
  getHealthScore(deploymentId: string): HealthScoreRow | null;
  listHealthScores(): Array<{ deploymentId: string; score: HealthScoreRow }>;
  setHealthScore(deploymentId: string, score: HealthScoreRow): void;

  // Learned limits
  getLearnedLimit(deploymentId: string, now: number): LearnedLimitRow | null;
  setLearnedLimit(deploymentId: string, limit: LearnedLimitRow): void;

  // Token budget
  getTokenUsage(keyRef: string, since: number): number;
  addTokenUsage(keyRef: string, bucketStart: number, promptTokens: number, completionTokens: number): void;

  // Transactions: wraps fn() in a storage transaction if supported; otherwise runs inline.
  transaction<T>(fn: () => T): T;
}

export interface CircuitRow {
  state: string;
  failureCount: number;
  successCount: number;
  openedAt?: number;
  halfOpenAfter?: number;
  updatedAt: number;
}

export interface RecentOutcome {
  outcome: "success" | "failure";
  failureClass?: string;
  timeout?: boolean;
  invalidSuccess?: boolean;
  semanticSeverity?: "low" | "medium" | "high";
  inflightAtDispatch?: number;
  latencyMs?: number;
  firstByteLatencyMs?: number;
  atMs: number;
}

export interface HealthScoreRow {
  score: number;
  lastSuccessAt?: number | null;
  lastFailureAt?: number | null;
  failureClass?: string | null;
  updatedAt: number;
  successCount: number;
  failureCount: number;
  consecutiveFailureCount: number;
  latencyEmaMs?: number | null;
  latencySampleCount: number;
  recentOutcomes?: RecentOutcome[];
  firstByteLatencyHistoryMs?: number[];
  totalLatencyHistoryMs?: number[];
}

export interface LearnedLimitRow {
  maxParallel: number;
  reason?: string;
  expiresAt?: number | null;
}

// ─── In-memory adapter (for tests) ─────────────────────────────────

export class InMemoryStorageAdapter implements StorageAdapter {
  private keyWindows = new Map<string, { windowStart: number; count: number }>();
  private groupWindows = new Map<string, { windowStart: number; count: number }>();
  private reservations = new Map<string, { keyRef: string; deploymentId: string; requestId: string; createdAt: number; expiresAt: number; confirmed: boolean }>();
  private inflight = new Map<string, { count: number; updatedAt: number }>();
  private cooldowns = new Map<string, { reason: string; until: number; detailsJson?: string }>();
  private circuits = new Map<string, CircuitRow>();
  private healthScores = new Map<string, HealthScoreRow>();
  private learnedLimits = new Map<string, LearnedLimitRow>();
  private tokenWindows = new Map<string, { windowStart: number; promptTokens: number; completionTokens: number }>();

  pruneKeyWindows(olderThan: number): void {
    for (const [k, v] of this.keyWindows) {
      if (v.windowStart < olderThan) this.keyWindows.delete(k);
    }
    for (const [k, v] of this.groupWindows) {
      if (v.windowStart < olderThan) this.groupWindows.delete(k);
    }
    for (const [k, v] of this.tokenWindows) {
      if (v.windowStart < olderThan) this.tokenWindows.delete(k);
    }
  }

  getKeyRpm(keyRef: string, since: number): number {
    let total = 0;
    for (const [k, v] of this.keyWindows) {
      if (k.startsWith(`${keyRef}:`) && v.windowStart >= since) total += v.count;
    }
    return total;
  }

  getGroupRpm(group: string, since: number): number {
    let total = 0;
    for (const [k, v] of this.groupWindows) {
      if (k.startsWith(`${group}:`) && v.windowStart >= since) total += v.count;
    }
    return total;
  }

  incrementKeyWindow(keyRef: string, bucketStart: number): void {
    const key = `${keyRef}:${bucketStart}`;
    const existing = this.keyWindows.get(key);
    this.keyWindows.set(key, { windowStart: bucketStart, count: (existing?.count ?? 0) + 1 });
  }

  incrementGroupWindow(group: string, bucketStart: number): void {
    const key = `${group}:${bucketStart}`;
    const existing = this.groupWindows.get(key);
    this.groupWindows.set(key, { windowStart: bucketStart, count: (existing?.count ?? 0) + 1 });
  }

  insertReservation(r: { reservationId: string; keyRef: string; deploymentId: string; requestId: string; createdAt: number; expiresAt: number }): void {
    this.reservations.set(r.reservationId, { ...r, confirmed: false });
  }

  confirmReservation(reservationId: string): { deploymentId: string } | null {
    const r = this.reservations.get(reservationId);
    if (!r) return null;
    r.confirmed = true;
    return { deploymentId: r.deploymentId };
  }

  deleteReservation(reservationId: string): { deploymentId: string } | null {
    const r = this.reservations.get(reservationId);
    if (!r) return null;
    this.reservations.delete(reservationId);
    return { deploymentId: r.deploymentId };
  }

  countReservations(deploymentId: string): number {
    let count = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.deploymentId === deploymentId) count++;
    }
    return count;
  }

  pruneStaleInflight(olderThan: number): void {
    for (const [k, v] of this.inflight) {
      if (v.updatedAt < olderThan) this.inflight.delete(k);
    }
  }

  getInflight(deploymentId: string): number {
    return this.inflight.get(deploymentId)?.count ?? 0;
  }

  setInflight(deploymentId: string, count: number, updatedAt: number): void {
    this.inflight.set(deploymentId, { count, updatedAt });
  }

  getCooldown(deploymentId: string, now: number): boolean {
    const c = this.cooldowns.get(deploymentId);
    return (c !== null && c !== undefined) && c.until > now;
  }

  setCooldown(deploymentId: string, reason: string, until: number, detailsJson?: string): void {
    this.cooldowns.set(deploymentId, { reason, until, detailsJson });
  }

  clearCooldowns(deploymentId?: string): void {
    if (deploymentId) {
      this.cooldowns.delete(deploymentId);
      this.cooldowns.delete(`cred-order:${deploymentId}`);
    } else {
      this.cooldowns.clear();
    }
  }

  clearCredentialCooldown(credentialId: string): void {
    this.cooldowns.delete(`cred:${credentialId}`);
  }

  getCircuit(deploymentId: string): CircuitRow | null {
    return this.circuits.get(deploymentId) ?? null;
  }

  setCircuit(deploymentId: string, circuit: CircuitRow): void {
    this.circuits.set(deploymentId, circuit);
  }

  getHealthScore(deploymentId: string): HealthScoreRow | null {
    const row = this.healthScores.get(deploymentId);
    if (!row) return null;
    return cloneHealthScore(row);
  }

  listHealthScores(): Array<{ deploymentId: string; score: HealthScoreRow }> {
    return [...this.healthScores.entries()].map(([deploymentId, score]) => ({
      deploymentId,
      score: cloneHealthScore(score),
    }));
  }

  setHealthScore(deploymentId: string, score: HealthScoreRow): void {
    this.healthScores.set(deploymentId, cloneHealthScore(score));
  }

  getLearnedLimit(deploymentId: string, now: number): LearnedLimitRow | null {
    const l = this.learnedLimits.get(deploymentId);
    if (!l) return null;
    if (l.expiresAt != null && l.expiresAt < now) return null;
    return l;
  }

  setLearnedLimit(deploymentId: string, limit: LearnedLimitRow): void {
    this.learnedLimits.set(deploymentId, limit);
  }

  getTokenUsage(keyRef: string, since: number): number {
    let total = 0;
    for (const [k, v] of this.tokenWindows) {
      if (k.startsWith(`${keyRef}:`) && v.windowStart >= since) total += v.promptTokens + v.completionTokens;
    }
    return total;
  }

  addTokenUsage(keyRef: string, bucketStart: number, promptTokens: number, completionTokens: number): void {
    const key = `${keyRef}:${bucketStart}`;
    const existing = this.tokenWindows.get(key);
    if (existing) {
      existing.promptTokens += promptTokens;
      existing.completionTokens += completionTokens;
    } else {
      this.tokenWindows.set(key, { windowStart: bucketStart, promptTokens, completionTokens });
    }
  }

  transaction<T>(fn: () => T): T {
    return fn();
  }
}

function cloneHealthScore(row: HealthScoreRow): HealthScoreRow {
  return {
    ...row,
    recentOutcomes: row.recentOutcomes ? [...row.recentOutcomes] : [],
    firstByteLatencyHistoryMs: row.firstByteLatencyHistoryMs ? [...row.firstByteLatencyHistoryMs] : [],
    totalLatencyHistoryMs: row.totalLatencyHistoryMs ? [...row.totalLatencyHistoryMs] : [],
  };
}
