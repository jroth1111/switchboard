// ChatGPT Responses contract: transforms OpenAI chat format to Responses API.
// Ports behavior from litellm_logic/routing/provider_contract.py.

import type { Deployment } from "../config/schema";
import type { ProviderRequest } from "./base";

// ─── Responses API request shape ───────────────────────────────────

export interface ResponsesAPIRequest {
  model: string;
  input: string | Array<ResponseInputItem>;
  instructions?: string;
  tools?: Array<Record<string, unknown>>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  metadata?: Record<string, unknown>;
  reasoning?: { effort: string };
}

export type ResponseInputItem =
  | { role: "user"; content: string | Array<Record<string, unknown>> }
  | { role: "assistant"; content: string | Array<Record<string, unknown>> }
  | { role: "system"; content: string }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

// ─── Build ChatGPT Responses request ───────────────────────────────

export function buildChatGPTResponsesRequest(
  deployment: Deployment,
  body: Record<string, unknown>,
  accessToken: string,
): ProviderRequest {
  const base = deployment.apiBase ?? "https://api.openai.com";
  const url = `${base}/v1/responses`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${accessToken}`,
  };

  const messages = (body.messages as Array<Record<string, unknown>>) ?? [];
  const input = convertMessagesToResponsesInput(messages);

  const responsesBody: ResponsesAPIRequest = {
    model: deployment.providerModel,
    input,
  };

  // Extract system message as instructions
  const systemMsg = messages.find((m) => m.role === "system");
  if (systemMsg) {
    responsesBody.instructions = typeof systemMsg.content === "string" ? systemMsg.content : JSON.stringify(systemMsg.content);
  }

  // Convert tools to Responses format
  if (body.tools) {
    responsesBody.tools = convertToolsForResponses(body.tools as Array<Record<string, unknown>>);
  }

  // Copy parameters
  if (body.stream) responsesBody.stream = true;
  if (body.temperature !== undefined && body.temperature !== null) responsesBody.temperature = body.temperature as number;
  if (body.top_p !== undefined && body.top_p !== null) responsesBody.top_p = body.top_p as number;
  if (body.max_tokens !== undefined) responsesBody.max_output_tokens = body.max_tokens as number;

  // Merge deployment params and reasoning effort — don't overwrite client values
  if (deployment.reasoningEffort && !responsesBody.reasoning) responsesBody.reasoning = { effort: deployment.reasoningEffort };
  if (deployment.params) {
    for (const [k, v] of Object.entries(deployment.params)) {
      if (v !== null && !(k in responsesBody)) {
        (responsesBody as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }
  if (deployment.extraBody) {
    for (const [k, v] of Object.entries(deployment.extraBody)) {
      if (v !== null && !(k in responsesBody)) {
        (responsesBody as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }

  return {
    url,
    method: "POST",
    headers,
    body: JSON.stringify(responsesBody),
  };
}

// ─── Convert Responses API response to OpenAI chat format ──────────

export function convertResponsesToOpenAI(
  responsesBody: Record<string, unknown>,
  requestId: string,
): Record<string, unknown> {
  const output = (responsesBody.output as Array<Record<string, unknown>>) ?? [];

  // Extract text content
  const textContent: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const item of output) {
    if (item.type === "message") {
      const content = item.content as Array<Record<string, unknown>> ?? [];
      for (const block of content) {
        if (block.type === "output_text") {
          textContent.push(block.text as string);
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.id ?? `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      });
    }
  }

  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";

  const message: Record<string, unknown> = {
    role: "assistant",
    content: textContent.join(""),
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const usage = responsesBody.usage as Record<string, number> | undefined;

  return {
    id: responsesBody.id ?? requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: responsesBody.model ?? "unknown",
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    },
  };
}

// ─── Convert Responses stream event to OpenAI SSE chunk ────────────

export function convertResponsesStreamChunk(
  event: Record<string, unknown>,
  requestId: string,
  model: string,
  toolCallIndexMap?: Map<number, number>,
): Record<string, unknown> | null {
  const type = event.type as string;

  if (type === "response.output_text.delta") {
    return {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: { content: event.delta as string },
        finish_reason: null,
      }],
    };
  }

  if (type === "response.output_item.added") {
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === "function_call") {
      const outputIdx = (event.output_index as number) ?? 0;
      const callIndex = toolCallIndexMap?.get(outputIdx) ?? outputIdx;
      return {
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: callIndex,
              id: item.id,
              type: "function",
              function: { name: item.name, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      };
    }
    return null;
  }

  if (type === "response.function_call_arguments.delta") {
    const outputIdx = (event.output_index as number) ?? 0;
    const callIndex = toolCallIndexMap?.get(outputIdx) ?? outputIdx;
    return {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: callIndex,
            function: { arguments: event.delta as string },
          }],
        },
        finish_reason: null,
      }],
    };
  }

  if (type === "response.output_item.done") {
    // Tool call header was emitted at output_item.added; argument deltas are done.
    // No additional data needed for function_call items.
    return null;
  }

  if (type === "response.completed") {
    const response = event.response as Record<string, unknown> | undefined;
    const status = response?.status as string;
    const result: Record<string, unknown> = {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: status === "incomplete" ? "length" : "stop",
      }],
    };
    const respUsage = response?.usage as Record<string, number> | undefined;
    if (respUsage) {
      result.usage = {
        prompt_tokens: respUsage.input_tokens ?? 0,
        completion_tokens: respUsage.output_tokens ?? 0,
        total_tokens: (respUsage.input_tokens ?? 0) + (respUsage.output_tokens ?? 0),
      };
    }
    return result;
  }

  // Skip noise events
  return null;
}

// ─── Validate request is compatible with Responses API ─────────────

export interface ResponsesContractResult {
  valid: boolean;
  reason?: string;
  strippedParams?: string[];
}

export function validateResponsesContract(body: Record<string, unknown>): ResponsesContractResult {
  const stripped: string[] = [];

  // Responses API doesn't support these chat-specific params
  const unsupportedParams = [
    "frequency_penalty",
    "presence_penalty",
    "logprobs",
    "top_logprobs",
    "n",
    "stop",
    "user",
  ];

  for (const param of unsupportedParams) {
    if (param in body) {
      stripped.push(param);
    }
  }

  // Check for unsupported features
  if (body.n && (body.n as number) > 1) {
    return { valid: false, reason: "n > 1 not supported by Responses API" };
  }

  if (body.response_format) {
    return { valid: false, reason: "response_format not supported by Responses API" };
  }

  if (body.seed !== undefined) {
    stripped.push("seed");
  }

  // Check messages have supported roles
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (messages) {
    for (const msg of messages) {
      const role = msg.role as string;
      if (!["system", "user", "assistant", "tool"].includes(role)) {
        return { valid: false, reason: `unsupported message role: ${role}` };
      }
    }
  }

  return {
    valid: true,
    strippedParams: stripped.length > 0 ? stripped : undefined,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

function convertMessagesToResponsesInput(messages: Array<Record<string, unknown>>): Array<ResponseInputItem> {
  const input: Array<ResponseInputItem> = [];

  for (const msg of messages) {
    const role = msg.role as string;
    const content = msg.content;

    // Convert content: preserve arrays (multimodal), stringify non-string scalars
    // Skip null/undefined content entirely (e.g. assistant messages with only tool_calls).
    const normalizedContent: string | Array<Record<string, unknown>> | null =
      (content === null || content === undefined)
        ? null
        : typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content as Array<Record<string, unknown>>
            : JSON.stringify(content);

    switch (role) {
      case "system":
        // System goes to top-level instructions, skip here
        break;
      case "user":
        input.push({ role: "user", content: normalizedContent ?? "" });
        break;
      case "assistant": {
        // Emit function_call items for any tool calls on this assistant message
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
            input.push({
              type: "function_call",
              id: tc.id as string,
              call_id: tc.id as string,
              name: (tc.function as Record<string, unknown>).name as string,
              arguments: (tc.function as Record<string, unknown>).arguments as string,
            });
          }
        }
        if (normalizedContent) {
          input.push({ role: "assistant", content: normalizedContent });
        }
        break;
      }
      case "tool": {
        // Tool result → function_call_output
        const toolCallId = msg.tool_call_id as string;
        const outputText = typeof normalizedContent === "string"
          ? normalizedContent
          : JSON.stringify(normalizedContent);
        input.push({
          type: "function_call_output",
          call_id: toolCallId,
          output: outputText,
        });
        break;
      }
    }
  }

  return input;
}

function convertToolsForResponses(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const fn = t.function as Record<string, unknown>;
    return {
      type: "function",
      name: fn.name,
      description: fn.description ?? "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    };
  });
}
