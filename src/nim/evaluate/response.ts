// Response evaluation: semantic validation, repair decisions, and actions.
// Ports behavior from litellm_logic/nim/evaluate/response.py.

import type { FailureClass } from "../../config/schema";
import { classifySemanticIssue, type SemanticValidationConfig } from "../classify/semantic";
import { repairToolCalls, validateToolContract } from "../repair/tool-calls";
import { stripResponseReasoningFields, stripThinkingLeaks } from "../repair/thinking";
import { repairSpecialTokens } from "../repair/special-tokens";
import { repairRepetition } from "../repair/repetition";
import { repairToolCallsSchemaAware, validateToolCallsAgainstSchemas, type RepairPolicyConfig, type RepairRecord } from "../repair/schema-aware";

export type EvaluationAction =
  | "accept"
  | "repair_accept"
  | "retry_same"
  | "retry_fallback"
  | "fail_client";

export interface ResponseEvaluation {
  action: EvaluationAction;
  failureClass?: FailureClass;
  failureMessage?: string;
  semanticSeverity?: "low" | "medium" | "high";
  repairedResponse?: Record<string, unknown>;
  repairRecords?: RepairRecord[];
}

export interface ResponseEvaluationConfig {
  enableSemanticValidation: boolean;
  enableToolRepair: boolean;
  enableSpecialTokenDetection: boolean;
  enableRepetitionDetection: boolean;
  semanticMinChars: number;
  semanticMinEntropy: number;
  semanticMinPrintableRatio: number;
  repetitionMaxRatio: number;
  stripReasoningFromSuccess: boolean;
  enableSchemaAwareRepair: boolean;
  repairPolicy: RepairPolicyConfig;
}

/** Shallow-clone response with a modified first choice message — avoids deep structuredClone. */
function patchResponseMessage(
  responseBody: Record<string, unknown>,
  message: Record<string, unknown>,
  patch: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  const choices = responseBody.choices as Array<Record<string, unknown>>;
  const patchedChoices = choices.map((c, i) =>
    i === 0 ? { ...c, message: { ...message, ...patch } } : c,
  );
  return { ...responseBody, choices: patchedChoices };
}

/** Shallow-clone response with replaced first choice message. */
function replaceResponseMessage(
  responseBody: Record<string, unknown>,
  newMessage: Record<string, unknown>,
): Record<string, unknown> {
  const choices = responseBody.choices as Array<Record<string, unknown>>;
  const patchedChoices = choices.map((c, i) =>
    i === 0 ? { ...c, message: newMessage } : c,
  );
  return { ...responseBody, choices: patchedChoices };
}

/** Shallow-clone response with replaced first choice tool_calls. */
function patchResponseToolCalls(
  responseBody: Record<string, unknown>,
  newToolCalls: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const choices = responseBody.choices as Array<Record<string, unknown>>;
  const msg = choices[0].message as Record<string, unknown>;
  const patchedChoices = choices.map((c, i) =>
    i === 0 ? { ...c, message: { ...msg, tool_calls: newToolCalls } } : c,
  );
  return { ...responseBody, choices: patchedChoices };
}

export function evaluateResponse(
  requestBody: Record<string, unknown>,
  responseBody: Record<string, unknown>,
  config: ResponseEvaluationConfig,
): ResponseEvaluation {
  const choices = responseBody.choices as Array<Record<string, unknown>> | undefined;
  const firstChoice = choices?.[0];
  if (!firstChoice) {
    return {
      action: "retry_fallback",
      failureClass: "malformed_response",
      failureMessage: "no choices in response",
      semanticSeverity: "high",
    };
  }

  const finishReason = firstChoice.finish_reason as string | undefined;
  const message = firstChoice.message as Record<string, unknown> | undefined;
  let evaluatedResponse = responseBody;
  let evaluatedMessage = message;
  let repairedBeforeValidation = false;
  if (config.stripReasoningFromSuccess && evaluatedMessage) {
    const stripped = stripResponseReasoningFields(evaluatedMessage);
    if (stripped.changed) {
      evaluatedResponse = replaceResponseMessage(responseBody, stripped.message);
      evaluatedMessage = stripped.message;
      repairedBeforeValidation = true;
    }
  }

  const content = contentText(evaluatedMessage?.content);
  const hasToolCalls = !!(evaluatedMessage?.tool_calls && (evaluatedMessage.tool_calls as unknown[]).length > 0);
  const availableTools = Array.isArray(requestBody.tools)
    ? requestBody.tools as Array<Record<string, unknown>>
    : [];

  const semanticConfig: SemanticValidationConfig = {
    minChars: config.semanticMinChars,
    minEntropy: config.semanticMinEntropy,
    minPrintableRatio: config.semanticMinPrintableRatio,
    repetitionMaxRatio: config.repetitionMaxRatio,
  };

  // ── Tool-call validation (only when request defined tools) ────
  if (hasToolCalls && availableTools.length > 0) {
    const toolCalls = evaluatedMessage!.tool_calls as Array<Record<string, unknown>>;
    let candidateToolCalls = toolCalls;
    if (config.enableToolRepair) {
      const repaired = repairToolCalls(toolCalls, availableTools);
      if (repaired) candidateToolCalls = repaired;
    }

    // Step 1: Contract validation (tool names, required args)
    const contractResult = validateToolContract(candidateToolCalls, availableTools);

    // Step 2: Schema validation (types, enums, additionalProperties)
    // This runs INDEPENDENTLY of contract validation — type/shape errors
    // will pass contract validation but fail schema validation.
    if (contractResult.valid && config.enableSchemaAwareRepair) {
      const schemaResult = validateToolCallsAgainstSchemas(
        candidateToolCalls,
        availableTools,
        config.repairPolicy,
      );

      if (!schemaResult.valid) {
        const schemaRepair = repairToolCallsSchemaAware(
          candidateToolCalls,
          availableTools,
          config.repairPolicy,
        );
        if (schemaRepair.repaired) {
          const revalidated = validateToolCallsAgainstSchemas(
            schemaRepair.repaired,
            availableTools,
            config.repairPolicy,
          );
          if (revalidated.valid) {
            const patched = patchResponseToolCalls(evaluatedResponse, schemaRepair.repaired);
            return {
              action: "repair_accept",
              repairedResponse: patched,
              repairRecords: schemaRepair.repairRecords,
            };
          }
        }
      }
    }

    // Step 3: Also try schema repair on contract failure (may fix tool name aliases)
    if (!contractResult.valid && config.enableSchemaAwareRepair) {
      const schemaRepair = repairToolCallsSchemaAware(
        candidateToolCalls,
        availableTools,
        config.repairPolicy,
      );
      if (schemaRepair.repaired) {
        const contractRetry = validateToolContract(schemaRepair.repaired, availableTools);
        if (contractRetry.valid) {
          // Also check for remaining schema issues after name fix
          const schemaResult = validateToolCallsAgainstSchemas(
            schemaRepair.repaired,
            availableTools,
            config.repairPolicy,
          );
          if (schemaResult.valid) {
            // Schema valid after name fix — emit first-pass repair
            const patched = patchResponseToolCalls(evaluatedResponse, schemaRepair.repaired);
            return {
              action: "repair_accept",
              repairedResponse: patched,
              repairRecords: schemaRepair.repairRecords,
            };
          } else {
            // Schema invalid after name fix — try a second pass on the resolved calls
            const secondPass = repairToolCallsSchemaAware(
              schemaRepair.repaired,
              availableTools,
              config.repairPolicy,
            );
            if (secondPass.repaired) {
              const revalidated = validateToolCallsAgainstSchemas(
                secondPass.repaired,
                availableTools,
                config.repairPolicy,
              );
              if (revalidated.valid) {
                const mergedRecords = [...schemaRepair.repairRecords, ...secondPass.repairRecords];
                const patched = patchResponseToolCalls(evaluatedResponse, secondPass.repaired);
                return {
                  action: "repair_accept",
                  repairedResponse: patched,
                  repairRecords: mergedRecords,
                };
              }
            }
            // Second pass failed or didn't improve — fall through to retry_fallback
          }
        }
      }
    }

    if (!contractResult.valid) {
      return {
        action: "retry_fallback",
        failureClass: "tool_contract_failure",
        failureMessage: contractResult.reason,
        semanticSeverity: "high",
      };
    }

    if (candidateToolCalls !== toolCalls) {
      // M2: when schema-aware repair is disabled, still validate schema so jsonrepair
      // doesn't silently produce schema-invalid arguments.
      if (!config.enableSchemaAwareRepair) {
        const schemaCheck = validateToolCallsAgainstSchemas(candidateToolCalls, availableTools, config.repairPolicy);
        if (!schemaCheck.valid) {
          const detail = schemaCheck.issues[0]?.issues[0]?.path ?? "schema_mismatch";
          return {
            action: "retry_fallback",
            failureClass: "tool_contract_failure",
            failureMessage: `schema_invalid_after_repair: ${detail}`,
            semanticSeverity: "high",
          };
        }
      }
      const patched = patchResponseToolCalls(evaluatedResponse, candidateToolCalls);
      return { action: "repair_accept", repairedResponse: patched, repairRecords: [{ toolName: "", fieldPath: "choices[0].message.tool_calls", repairKind: "tool_name_alias", before: "malformed", after: "repaired" }] };
    }
  }

  // ── Finish reason checks ──────────────────────────────────────
  if (finishReason === "content_filter") {
    return {
      action: "retry_fallback",
      failureClass: "semantic_failure",
      failureMessage: "content_filter",
      semanticSeverity: "medium",
    };
  }

  if (finishReason === "length") {
    return {
      action: "retry_fallback",
      failureClass: "truncated_response",
      failureMessage: "finish_reason_length_truncation",
      semanticSeverity: "medium",
    };
  }

  // ── Semantic content validation ───────────────────────────────
  if (config.enableSemanticValidation && content.length > 0) {
    // Extract last user message for echo detection
    const messages = requestBody.messages as Array<Record<string, unknown>> | undefined;
    let lastUserText: string | undefined;
    if (messages) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          lastUserText = contentText(messages[i].content);
          break;
        }
      }
    }
    const issue = classifySemanticIssue(content, semanticConfig, finishReason, lastUserText);
    if (issue) {
      // Try repair for special tokens
      if (issue.issue === "special_token_leak" && config.enableSpecialTokenDetection) {
        const repaired = repairSpecialTokens(content);
        if (repaired !== content) {
          const patched = patchResponseMessage(evaluatedResponse, evaluatedMessage!, { content: repaired });
          return {
            action: "repair_accept",
            repairedResponse: patched,
            repairRecords: [{ toolName: "", fieldPath: "choices[0].message.content", repairKind: "special_token_strip", before: content.slice(0, 80), after: repaired.slice(0, 80) }],
          };
        }
      }

      // Try repair for repetition
      if (issue.issue === "repetition_detected" && config.enableRepetitionDetection) {
        const repaired = repairRepetition(content);
        if (repaired && repaired !== content) {
          const patched = patchResponseMessage(evaluatedResponse, evaluatedMessage!, { content: repaired });
          return {
            action: "repair_accept",
            repairedResponse: patched,
            repairRecords: [{ toolName: "", fieldPath: "choices[0].message.content", repairKind: "repetition_dedup", before: content.slice(0, 80), after: repaired.slice(0, 80) }],
          };
        }
      }

      // Map semantic issue to failure class and action
      const fc: FailureClass = issue.issue === "success_shaped_failure"
        ? "success_shaped_failure"
        : issue.issue === "truncation"
          ? "truncated_response"
          : issue.issue === "repetition_detected"
            ? "repetition_detected"
            : issue.issue === "special_token_leak"
              ? "special_token_leak"
              : issue.issue === "input_echo"
                ? "input_echo"
                : "semantic_failure";

      const action: EvaluationAction = "retry_fallback";

      return {
        action,
        failureClass: fc,
        failureMessage: issue.details,
        semanticSeverity: issue.severity,
      };
    }
  }

  // ── Empty response check ──────────────────────────────────────
  if (!content && !hasToolCalls) {
    return {
      action: "retry_fallback",
      failureClass: "empty_response",
      failureMessage: "empty_content_no_tool_calls",
      semanticSeverity: "high",
    };
  }

  // ── Strip reasoning leaks ─────────────────────────────────────
  if (config.stripReasoningFromSuccess && content) {
    const stripped = stripThinkingLeaks(content);
    if (stripped !== content) {
      const patched = patchResponseMessage(evaluatedResponse, evaluatedMessage!, { content: stripped });
      return {
        action: "repair_accept",
        repairedResponse: patched,
        repairRecords: [{ toolName: "", fieldPath: "choices[0].message.content", repairKind: "thinking_leak_strip", before: content.slice(0, 80), after: stripped.slice(0, 80) }],
      };
    }
  }

  if (repairedBeforeValidation) {
    return {
      action: "repair_accept",
      repairedResponse: evaluatedResponse,
      repairRecords: [{ toolName: "", fieldPath: "choices[0].message", repairKind: "reasoning_field_strip", before: "has_reasoning_fields", after: "stripped" }],
    };
  }

  return { action: "accept" };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const text = (item as Record<string, unknown>).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}
