// Failed request finalization: extracts structured summaries from terminal receipts.
// Ports litellm_logic/obs/failed_request_finalizer.py.

import { sanitizeReceipt } from "./receipt";
import type { RouteReceipt } from "./receipt";

export interface FailedRequestSummary {
  requestId: string;
  timestamp: number;
  originalModel: string;
  route: string;
  canonicalTarget: string;
  selectedGroup: string;
  selectedModel: string;
  selectedDeploymentId: string | undefined;
  requestSource: string;
  finalOutcome: string;
  failureClass: string | undefined;
  issueCode: string | undefined;
  attemptsCount: number;
  stream: boolean;
  attempts: Array<{
    group: string;
    deploymentId: string | undefined;
    failureClass: string | undefined;
    action: string;
    durationMs: number | undefined;
  }>;
}

export function failedRequestSummaryFromReceipt(receipt: RouteReceipt): FailedRequestSummary | null {
  if (receipt.finalOutcome !== "exhausted" && receipt.finalOutcome !== "client_error") {
    return null;
  }

  if (receipt.attempts.length === 0) {
    return summarizeZeroAttemptReceipt(receipt);
  }

  const lastAttempt = receipt.attempts[receipt.attempts.length - 1];
  const firstFailure = receipt.attempts.find((a) => a.failureClass);
  const selectedDeploymentId = [...receipt.attempts].reverse().find((a) => a.deploymentId)?.deploymentId;
  const failureClass =
    lastAttempt?.failureClass
    ?? firstFailure?.failureClass
    ?? receipt.denialReason
    ?? (receipt.finalOutcome === "exhausted" ? "exhausted" : undefined);

  return {
    requestId: receipt.requestId,
    timestamp: receipt.timestamp,
    originalModel: receipt.originalModel,
    route: receipt.canonicalTarget,
    canonicalTarget: receipt.canonicalTarget,
    selectedGroup: receipt.selectedGroup,
    selectedModel: selectedDeploymentId ?? receipt.selectedGroup,
    selectedDeploymentId,
    requestSource: receipt.appId ?? receipt.clientId ?? "unknown",
    finalOutcome: receipt.finalOutcome,
    failureClass,
    issueCode: receipt.finalOutcome === "exhausted" ? "all_groups_exhausted" : receipt.denialReason,
    attemptsCount: receipt.attempts.length,
    stream: receipt.stream,
    attempts: receipt.attempts.map((a) => ({
      group: a.group,
      deploymentId: a.deploymentId,
      failureClass: a.failureClass,
      action: a.action,
      durationMs: a.durationMs,
    })),
  };
}

function summarizeZeroAttemptReceipt(receipt: RouteReceipt): FailedRequestSummary | null {
  if (receipt.finalOutcome === "client_error") {
    return buildZeroAttemptSummary(receipt, {
      failureClass: receipt.denialReason,
      issueCode: receipt.denialReason ?? "client_denied",
    });
  }
  if (receipt.finalOutcome === "exhausted") {
    return buildZeroAttemptSummary(receipt, {
      failureClass: "exhausted",
      issueCode: "all_groups_exhausted",
    });
  }
  return null;
}

function buildZeroAttemptSummary(
  receipt: RouteReceipt,
  outcome: { failureClass: string | undefined; issueCode: string | undefined },
): FailedRequestSummary {
  return {
    requestId: receipt.requestId,
    timestamp: receipt.timestamp,
    originalModel: receipt.originalModel,
    route: receipt.canonicalTarget,
    canonicalTarget: receipt.canonicalTarget,
    selectedGroup: receipt.selectedGroup,
    selectedModel: receipt.selectedGroup,
    selectedDeploymentId: undefined,
    requestSource: receipt.appId ?? receipt.clientId ?? "unknown",
    finalOutcome: receipt.finalOutcome,
    failureClass: outcome.failureClass,
    issueCode: outcome.issueCode,
    attemptsCount: 0,
    stream: receipt.stream,
    attempts: [],
  };
}

export function finalizeFailedRequest(receipt: RouteReceipt): {
  summary: FailedRequestSummary;
  sanitizedReceipt: unknown;
} | null {
  const summary = failedRequestSummaryFromReceipt(receipt);
  if (!summary) return null;

  const sanitizedReceipt = sanitizeReceipt(receipt);
  return { summary, sanitizedReceipt };
}
