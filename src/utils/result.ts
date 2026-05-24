// Shared error-handling types and utilities.

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function safeJsonParse(text: string | null): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
