// Structured logging for the control plane.

import { redact, sanitizeReceipt } from "./receipt";

export type LogLevel = "debug" | "info" | "warn" | "error";

let currentLevel: LogLevel = "info";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  requestId?: string;
  timestamp: string;
  [key: string]: unknown;
}

function formatLog(entry: LogEntry): string {
  try {
    return JSON.stringify(entry);
  } catch (error) {
    return JSON.stringify({
      level: "error",
      message: "log_format_failed",
      timestamp: new Date().toISOString(),
      error: sanitizeReceipt(error),
    });
  }
}

export function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const sanitizedData = data ? sanitizeReceipt(data) as Record<string, unknown> : undefined;
  const entry: LogEntry = {
    ...sanitizedData,
    level,
    message: redact(message),
    timestamp: new Date().toISOString(),
  };
  console.log(formatLog(entry));
}

export function logDebug(message: string, data?: Record<string, unknown>): void {
  log("debug", message, data);
}

export function logInfo(message: string, data?: Record<string, unknown>): void {
  log("info", message, data);
}

export function logWarn(message: string, data?: Record<string, unknown>): void {
  log("warn", message, data);
}

export function logError(message: string, data?: Record<string, unknown>): void {
  log("error", message, data);
}
