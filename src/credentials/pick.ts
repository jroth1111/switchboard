import type { CredentialSlot } from "./types";

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function reorderCredentialPoolByIds<T extends CredentialSlot>(
  pool: T[],
  order: string[],
): T[] {
  const byId = new Map(pool.map((slot) => [slot.credentialId, slot]));
  const reordered: T[] = [];
  for (const id of order) {
    const slot = byId.get(id);
    if (slot) {
      reordered.push(slot);
      byId.delete(id);
    }
  }
  for (const slot of pool) {
    if (byId.has(slot.credentialId)) reordered.push(slot);
  }
  return reordered;
}

export function moveCredentialToBack<T extends CredentialSlot>(
  pool: T[],
  credentialId: string,
): T[] {
  const index = pool.findIndex((slot) => slot.credentialId === credentialId);
  if (index < 0) return pool;
  const next = [...pool];
  const [slot] = next.splice(index, 1);
  next.push(slot);
  return next;
}

export function pickNextCredential<T extends CredentialSlot>(params: {
  pool: T[];
  strategy: "sequential_exhaust" | "spread" | "none";
  requestId: string;
  attempted: Set<string>;
  isAvailable: (slot: T) => boolean;
}): T | null {
  const { pool, strategy, requestId, attempted, isAvailable } = params;
  const candidates = pool.filter((slot) => !attempted.has(slot.credentialId) && isAvailable(slot));
  if (candidates.length === 0) return null;
  if (strategy === "spread" && candidates.length > 1) {
    const index = fnv1a32(requestId) % candidates.length;
    return candidates[index] ?? candidates[0];
  }
  return candidates[0] ?? null;
}
