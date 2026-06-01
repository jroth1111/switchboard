type FixtureScenario =
  | "success"
  | "stream"
  | "rate_limit"
  | "server_500"
  | "auth_failure"
  | "empty"
  | "reasoning_leak"
  | "tool_call"
  | "slow_first_token"
  | "never_first_token"
  | "malformed_json"
  | "success_shaped_failure"
  | "repetition_detected"
  | "truncated_response";

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function scenarioFromBody(body: Record<string, unknown>): FixtureScenario {
  const text = JSON.stringify(body).toLowerCase();
  if (text.includes("fixture:rate_limit")) return "rate_limit";
  if (text.includes("fixture:server_500")) return "server_500";
  if (text.includes("fixture:auth_failure")) return "auth_failure";
  if (text.includes("fixture:empty")) return "empty";
  if (text.includes("fixture:reasoning_leak")) return "reasoning_leak";
  if (text.includes("fixture:tool_call")) return "tool_call";
  if (text.includes("fixture:slow_first_token")) return "slow_first_token";
  if (text.includes("fixture:never_first_token")) return "never_first_token";
  if (text.includes("fixture:malformed_json")) return "malformed_json";
  if (text.includes("fixture:success_shaped_failure")) return "success_shaped_failure";
  if (text.includes("fixture:repetition_detected")) return "repetition_detected";
  if (text.includes("fixture:truncated_response")) return "truncated_response";
  if (text.includes("fixture:stream")) return "stream";
  return "success";
}

function fixtureErrorResponse(scenario: FixtureScenario, streamRequested: boolean): Response | null {
  if (scenario === "rate_limit") {
    return json({ error: { message: "rate limit exceeded", type: "rate_limit" } }, 429, {
      "Retry-After": "1",
    });
  }
  if (scenario === "server_500") {
    return json({ error: { message: "fixture upstream failure", type: "server_error" } }, 500);
  }
  if (scenario === "auth_failure") {
    return json({ error: { message: "invalid api key", type: "auth" } }, 401);
  }
  if (scenario === "empty") {
    return new Response("", { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (streamRequested || scenario === "slow_first_token" || scenario === "never_first_token") {
    return null;
  }
  return null;
}

function openAiCompletion(body: Record<string, unknown>, scenario: FixtureScenario): Response {
  const model = String(body.model ?? "fixture-model");
  const streamRequested = scenario === "stream" || body.stream === true
    || scenario === "slow_first_token" || scenario === "never_first_token";
  const errorResponse = fixtureErrorResponse(scenario, streamRequested);
  if (errorResponse) return errorResponse;
  if (streamRequested) {
    return openAiStream(model, scenario);
  }

  if (scenario === "malformed_json") {
    return new Response('{"choices":[{"message":{"content":"OK"}} garbage{broken', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (scenario === "success_shaped_failure") {
    return json({
      id: "chatcmpl_fixture_ssf",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "Error: upstream error - provider error detected" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
    });
  }
  if (scenario === "repetition_detected") {
    return json({
      id: "chatcmpl_fixture_rep",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "ha ha ha ha ha ha ha ha ha ha ha ha ha ha ha ha ha ha ha ha" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 20, total_tokens: 24 },
    });
  }
  if (scenario === "truncated_response") {
    return json({
      id: "chatcmpl_fixture_trunc",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "This is a truncated res" }, finish_reason: "length" }],
      usage: { prompt_tokens: 4, completion_tokens: 16, total_tokens: 20 },
    });
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: "OK fixture response",
  };
  if (scenario === "reasoning_leak") {
    message.reasoning = "hidden chain should be stripped";
    message.content = [
      { type: "reasoning", text: "hidden chain should be stripped" },
      { type: "text", text: "OK fixture response" },
    ];
  }
  if (scenario === "tool_call") {
    message.content = "";
    message.tool_calls = [{
      id: "call_fixture",
      type: "function",
      function: { name: "lookup", arguments: "{\"query\":\"fixture\"}" },
    }];
  }

  return json({
    id: "chatcmpl_fixture",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: scenario === "tool_call" ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
  });
}

function responsesCompletion(body: Record<string, unknown>, scenario: FixtureScenario): Response {
  const model = String(body.model ?? "fixture-responses-model");
  const streamRequested = scenario === "stream" || body.stream === true;
  const errorResponse = fixtureErrorResponse(scenario, streamRequested);
  if (errorResponse) return errorResponse;
  if (streamRequested) {
    return responsesStream(model);
  }
  return json({
    id: "resp_fixture",
    model,
    output: [{
      type: "message",
      content: [{ type: "output_text", text: "OK fixture response" }],
    }],
    usage: { input_tokens: 4, output_tokens: 3 },
  });
}

function anthropicCompletion(body: Record<string, unknown>, scenario: FixtureScenario): Response {
  const model = String(body.model ?? "fixture-anthropic-model");
  const streamRequested = scenario === "stream" || body.stream === true;
  const errorResponse = fixtureErrorResponse(scenario, streamRequested);
  if (errorResponse) return errorResponse;
  if (streamRequested) {
    return anthropicStream(model);
  }
  return json({
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "OK fixture response" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 4, output_tokens: 3 },
  });
}

function sse(chunks: string[], delayFirstTokenMs = 0): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (delayFirstTokenMs > 0) await new Promise((resolve) => setTimeout(resolve, delayFirstTokenMs));
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function openAiStream(model: string, scenario: FixtureScenario): Response {
  if (scenario === "never_first_token") {
    // Stream that opens SSE but never sends a data event — simulates provider hang
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Send only a comment to keep the connection open, then hang forever
        controller.enqueue(encoder.encode(": comment\n\n"));
        // Never resolve — the client/worker will time out
        await new Promise(() => {});
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
  const delay = scenario === "slow_first_token" ? 2000 : 0;
  return sse([
    JSON.stringify({
      id: "chatcmpl_fixture_stream",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
    }),
    JSON.stringify({
      id: "chatcmpl_fixture_stream",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }),
  ], delay);
}

function responsesStream(model: string): Response {
  return sse([
    JSON.stringify({ type: "response.output_text.delta", delta: "OK", response_id: "resp_fixture_stream" }),
    JSON.stringify({ type: "response.completed", response: { status: "completed", model } }),
  ]);
}

function anthropicStream(model: string): Response {
  return sse([
    JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }),
    JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 }, model }),
  ]);
}

export async function handleProviderFixture(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/ping") {
    return json({ ok: true, fixture: "provider" });
  }
  if (request.method !== "POST") {
    return json({ error: "not found" }, 404);
  }

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const scenario = scenarioFromBody(body);
  if (url.pathname.endsWith("/responses")) {
    return responsesCompletion(body, scenario);
  }
  if (url.pathname.endsWith("/messages")) {
    return anthropicCompletion(body, scenario);
  }
  if (url.pathname.endsWith("/chat/completions")) {
    return openAiCompletion(body, scenario);
  }
  return json({ error: "not found" }, 404);
}
