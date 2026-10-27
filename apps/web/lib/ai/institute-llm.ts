/**
 * Client for the institute's own LLM server: vLLM behind an
 * OpenAI-compatible API, reachable only from the institute network or VPN.
 *
 * Configuration comes from the environment (apps/web/.env.local, which is
 * gitignored) and never from the code: this repository is public, and the
 * server's address is internal infrastructure that does not belong in it.
 *
 *   MYWIKI_LLM_BASE_URL  e.g. https://<host>:8080/v1        (required)
 *   MYWIKI_LLM_MODEL     a model id from /v1/models          (optional)
 *   MYWIKI_LLM_API_KEY   sent as Bearer token                (optional)
 *
 * MYWIKI_LLM_MODEL is optional on purpose. The server loads one model at a
 * time and that model changes, so the default is "whatever it serves" —
 * asked from /v1/models — rather than a name that silently goes stale.
 */

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ChatStreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_calls"; calls: ChatToolCall[] }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "finish"; reason: string | null };

export interface InstituteModel {
  id: string;
  contextWindow: number | null;
}

/**
 * The server can't be reached at all — no VPN, wrong network, host down.
 * Deliberately its own type: the chat must say "connect the VPN" here, and
 * must NOT fall back to a cloud model (a user decision: questions and
 * source excerpts don't leave the institute unannounced).
 */
export class InstituteLlmUnavailableError extends Error {
  constructor(detail?: string) {
    super(
      `The institute LLM server isn't reachable — are you connected to the institute network or VPN?${detail ? ` (${detail})` : ""}`,
    );
    this.name = "InstituteLlmUnavailableError";
  }
}

export class InstituteLlmNotConfiguredError extends Error {
  constructor() {
    super(
      "No institute LLM is configured. Set MYWIKI_LLM_BASE_URL in apps/web/.env.local (see .env.example) and restart myWiki.",
    );
    this.name = "InstituteLlmNotConfiguredError";
  }
}

interface InstituteConfig {
  baseUrl: string;
  model: string | null;
  apiKey: string | null;
}

function readConfig(): InstituteConfig {
  const baseUrl = process.env.MYWIKI_LLM_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new InstituteLlmNotConfiguredError();
  return {
    baseUrl,
    model: process.env.MYWIKI_LLM_MODEL?.trim() || null,
    apiKey: process.env.MYWIKI_LLM_API_KEY?.trim() || null,
  };
}

export function isInstituteLlmConfigured(): boolean {
  return Boolean(process.env.MYWIKI_LLM_BASE_URL?.trim());
}

function headers(config: InstituteConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // vLLM without --api-key accepts anything; the OpenAI convention for
    // "no key" is the literal EMPTY.
    Authorization: `Bearer ${config.apiKey ?? "EMPTY"}`,
  };
}

// Without VPN the host name doesn't resolve and the request would otherwise
// hang on the OS resolver's own, much longer timeout. Bounds the wait for
// the response headers only — see request() for why that distinction is
// the whole point.
const MODELS_TIMEOUT_MS = 8_000;
// A streamed completion sends its headers as soon as the request is
// accepted, but a busy server queues it first.
const STREAM_TIMEOUT_MS = 30_000;
// A non-streamed completion sends its headers only once the whole answer is
// generated (32 s measured for a short one under load).
const COMPLETE_TIMEOUT_MS = 120_000;

const timeouts = {
  models: MODELS_TIMEOUT_MS,
  stream: STREAM_TIMEOUT_MS,
  complete: COMPLETE_TIMEOUT_MS,
};

/** Test-only: shorten the header timeouts. Pass {} to reset. */
export function _setTimeoutsForTesting(
  overrides: Partial<typeof timeouts>,
): void {
  Object.assign(timeouts, {
    models: MODELS_TIMEOUT_MS,
    stream: STREAM_TIMEOUT_MS,
    complete: COMPLETE_TIMEOUT_MS,
    ...overrides,
  });
}

/** Network-level failures that mean "not reachable", as opposed to "reachable but refused". */
function isUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  const code = (error.cause as { code?: string } | undefined)?.code ?? "";
  return /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(
    code,
  );
}

/**
 * Fetches with a timeout on the *headers*, not on the whole response.
 *
 * The obvious version — AbortSignal.timeout() passed to fetch — is wrong
 * here: a fetch signal stays attached to the body, so it also cut off every
 * streamed answer that took longer than the timeout to finish (seen live:
 * answers dying mid-sentence after 16 s with "aborted due to timeout").
 * So the timer is cleared the moment the headers arrive, while the caller's
 * own signal (the stop button) keeps reaching the stream throughout.
 */
async function request(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    headersTimeoutMs: number;
  },
): Promise<Response> {
  const config = readConfig();
  const controller = new AbortController();
  if (init.signal?.aborted) controller.abort(init.signal.reason);
  init.signal?.addEventListener(
    "abort",
    () => controller.abort(init.signal?.reason),
    { once: true },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, init.headersTimeoutMs);

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: headers(config),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } catch (error) {
    // A user stop is an abort, not an outage — let it through unchanged.
    if (init.signal?.aborted) throw error;
    if (timedOut) throw new InstituteLlmUnavailableError("no response");
    if (isUnreachable(error)) {
      const code = (error as Error & { cause?: { code?: string } }).cause?.code;
      throw new InstituteLlmUnavailableError(code ?? "timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // vLLM puts the reason (e.g. "maximum context length is …") in the
    // body; a bare status code would leave the user guessing.
    const detail = await response.text().catch(() => "");
    let message = detail;
    try {
      const parsed = JSON.parse(detail) as {
        message?: string;
        error?: { message?: string };
      };
      message = parsed.error?.message ?? parsed.message ?? detail;
    } catch {
      // not JSON — keep the raw text
    }
    throw new Error(
      `Institute LLM request failed (${response.status}): ${message.slice(0, 400)}`,
    );
  }
  return response;
}

/**
 * The model the chat should use: the configured one if it is actually
 * loaded, else the first one the server reports.
 *
 * Cached briefly. The server loads one model at a time and swaps it rarely,
 * but asking on every chat turn would add a round-trip to each answer.
 */
const MODEL_CACHE_MS = 60_000;
const globalForModel = globalThis as unknown as {
  __mywikiInstituteModel?: { at: number; value: Promise<InstituteModel> };
};

export async function resolveInstituteModel(): Promise<InstituteModel> {
  const cached = globalForModel.__mywikiInstituteModel;
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.value;

  const value = (async () => {
    const config = readConfig();
    const response = await request("/models", {
      headersTimeoutMs: timeouts.models,
    });
    const body = (await response.json()) as {
      data?: Array<{ id: string; max_model_len?: number }>;
    };
    const models = body.data ?? [];
    if (models.length === 0) {
      throw new Error("The institute LLM server reports no loaded model.");
    }
    const chosen = config.model
      ? models.find((model) => model.id === config.model)
      : models[0];
    if (!chosen) {
      throw new Error(
        `MYWIKI_LLM_MODEL is "${config.model}", but the server only serves: ${models.map((model) => model.id).join(", ")}.`,
      );
    }
    return { id: chosen.id, contextWindow: chosen.max_model_len ?? null };
  })();

  globalForModel.__mywikiInstituteModel = { at: Date.now(), value };
  // A failed lookup (no VPN) must not be remembered for a minute — the
  // next attempt after connecting should go straight through.
  value.catch(() => {
    if (globalForModel.__mywikiInstituteModel?.value === value) {
      globalForModel.__mywikiInstituteModel = undefined;
    }
  });
  return value;
}

/**
 * Splits a text/event-stream buffer into complete `data:` payloads, keeping
 * any unfinished trailing line for the next chunk. Pure, so the framing can
 * be tested without a server.
 */
export function takeSseData(buffer: string): {
  payloads: string[];
  rest: string;
} {
  const payloads: string[] = [];
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf("\n");
    if (newline < 0) break;
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload && payload !== "[DONE]") payloads.push(payload);
  }
  return { payloads, rest };
}

interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Reassembles streamed tool calls. The OpenAI stream format sends each call
 * in fragments keyed by `index` — the id and name once, the JSON arguments
 * spread over many deltas — and several calls can be in flight at once
 * (gemma issues parallel searches; seen live with two at a time).
 */
export function createToolCallAccumulator() {
  const calls = new Map<number, ChatToolCall>();
  return {
    add(delta: ToolCallDelta) {
      const current = calls.get(delta.index) ?? {
        id: "",
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      if (delta.id) current.id = delta.id;
      if (delta.function?.name) current.function.name += delta.function.name;
      if (delta.function?.arguments) {
        current.function.arguments += delta.function.arguments;
      }
      calls.set(delta.index, current);
    },
    finish(): ChatToolCall[] {
      return [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => ({
          ...call,
          // Some servers omit the id on parallel calls; the tool message
          // has to reference *something* unique to pair back up.
          id: call.id || `call_${index}`,
        }));
    },
  };
}

export interface ChatRequestOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolSpec[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * One streamed completion. Text arrives as it is generated; tool calls are
 * emitted once, complete, after the model has finished asking for them —
 * half-assembled JSON arguments are useless to a caller.
 */
export async function* streamInstituteChat(
  options: ChatRequestOptions,
): AsyncGenerator<ChatStreamEvent> {
  const response = await request("/chat/completions", {
    method: "POST",
    signal: options.signal,
    headersTimeoutMs: timeouts.stream,
    body: {
      model: options.model,
      messages: options.messages,
      tools:
        options.tools && options.tools.length > 0 ? options.tools : undefined,
      tool_choice:
        options.tools && options.tools.length > 0 ? "auto" : undefined,
      max_tokens: options.maxTokens,
      temperature: options.temperature ?? 0.3,
      stream: true,
      stream_options: { include_usage: true },
    },
  });
  if (!response.body) throw new Error("Institute LLM returned no stream.");

  const decoder = new TextDecoder();
  const toolCalls = createToolCallAccumulator();
  let hasToolCalls = false;
  let finishReason: string | null = null;
  let buffer = "";

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const { payloads, rest } = takeSseData(buffer);
    buffer = rest;
    for (const payload of payloads) {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{
          delta?: { content?: string | null; tool_calls?: ToolCallDelta[] };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
      const choice = parsed.choices?.[0];
      if (choice?.delta?.content) {
        yield { type: "text", delta: choice.delta.content };
      }
      for (const delta of choice?.delta?.tool_calls ?? []) {
        hasToolCalls = true;
        toolCalls.add(delta);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (parsed.usage) {
        yield {
          type: "usage",
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
        };
      }
    }
  }

  if (hasToolCalls) yield { type: "tool_calls", calls: toolCalls.finish() };
  yield { type: "finish", reason: finishReason };
}

/** A single non-streamed answer, for small one-off jobs like the tagline. */
export async function completeInstituteChat(
  options: Omit<ChatRequestOptions, "tools">,
): Promise<string> {
  const response = await request("/chat/completions", {
    method: "POST",
    signal: options.signal,
    headersTimeoutMs: timeouts.complete,
    body: {
      model: options.model,
      messages: options.messages,
      max_tokens: options.maxTokens,
      temperature: options.temperature ?? 0.3,
    },
  });
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  return body.choices?.[0]?.message?.content ?? "";
}
