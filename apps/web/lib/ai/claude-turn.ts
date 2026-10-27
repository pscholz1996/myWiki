import { randomUUID } from "node:crypto";
import {
  claudeCatchUp,
  closeLiveSession,
  runMyWikiChatTurn,
} from "@/lib/ai/agent";
import type { InstituteTurnEvent } from "@/lib/ai/institute-agent";
import { joinAssistantPart } from "@/lib/ai/stream-text";
import type {
  AiChatRequest,
  AiCitation,
  AiConversation,
  AiUsage,
} from "@/lib/ai/types";

/**
 * One chat turn on Claude, as it ran before the institute LLM arrived —
 * Claude researches, writes, and draws its own figures and diagrams.
 *
 * Wraps the Claude Agent SDK turn and translates its message stream into
 * the same events the institute agent produces, so the chat route speaks
 * one language and only picks the runner. The SDK-specific handling below
 * (lost sessions, rate limits, compaction, citation pairing) is the chat
 * route's from before, moved here unchanged.
 */

export type ChatTurnEvent =
  | InstituteTurnEvent
  | {
      type: "compacted";
      trigger?: string;
      preTokens?: number;
      postTokens?: number;
    }
  /** A non-fatal failure to report once the turn is over (rate limit, …). */
  | { type: "notice"; message: string }
  /** The SDK session this conversation now continues in. */
  | { type: "session"; sdkSessionId: string };

function extractUsage(message: any): AiUsage | undefined {
  const usage = message?.usage ?? message?.result?.usage;
  if (usage && typeof usage === "object") {
    return {
      inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
      outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
      cacheReadTokens:
        usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? undefined,
      cacheWriteTokens:
        usage.cache_creation_input_tokens ??
        usage.cacheWriteTokens ??
        undefined,
    };
  }

  if (typeof message?.totalTokens === "number") {
    return { inputTokens: 0, outputTokens: message.totalTokens };
  }

  return undefined;
}

function assistantTextFromMessage(message: any): string {
  const blocks = message?.message?.content ?? message?.content ?? [];
  return blocks
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text)
    .join("");
}

// SDKAssistantMessageError / SDKResultError subtypes come back as opaque
// codes (e.g. "rate_limit", "error_max_turns") that mean nothing to a user.
// Map the ones we can act on to plain language; unmapped codes fall through
// to the caller's own fallback message rather than showing a raw code.
function friendlySdkError(code: string | undefined | null): string | undefined {
  switch (code) {
    case "authentication_failed":
      return "Claude authentication failed. Try signing in to Claude Code again.";
    case "oauth_org_not_allowed":
      return "Your Claude account isn't permitted to use this integration.";
    case "billing_error":
      return "There's a billing issue with your Claude account.";
    case "rate_limit":
      return "You've hit your Claude plan's rate limit. Wait a bit and try again.";
    case "overloaded":
      return "Claude's servers are overloaded right now. Try again shortly.";
    case "invalid_request":
      return "The request to Claude was invalid.";
    case "model_not_found":
      return "The selected Claude model isn't available.";
    case "server_error":
      return "Claude hit a server error. Try again.";
    case "max_output_tokens":
      return "The response hit the maximum output length before finishing.";
    case "error_max_turns":
      return 'The assistant hit the safety cap on tool calls for a single turn and stopped. Say "continue" to let it pick up where it left off.';
    case "error_max_budget_usd":
      return "This turn exceeded its cost budget and was stopped.";
    case "error_max_structured_output_retries":
      return "The assistant couldn't produce a valid response after several attempts.";
    case "error_during_execution":
      return "An error occurred while the assistant was working.";
    default:
      return undefined;
  }
}

/**
 * Track pending mcp__mywiki__cite tool calls by tool_use id, then
 * confirm them as citations only once their tool_result comes back
 * verified. A cite() call that fails verification (quote not found on the
 * page) must never surface to the user as a citation.
 */
function collectCitation(
  sdkMessage: any,
  pending: Map<string, { sourceId: string; page: number; quote: string }>,
  citations: AiCitation[],
): void {
  const kind = sdkMessage?.type;
  const blocks = sdkMessage?.message?.content ?? [];

  if (kind === "assistant") {
    for (const block of blocks) {
      if (
        block?.type === "tool_use" &&
        block.name === "mcp__mywiki__cite" &&
        block.input &&
        typeof block.input.sourceId === "string" &&
        typeof block.input.page === "number" &&
        typeof block.input.quote === "string"
      ) {
        pending.set(block.id, {
          sourceId: block.input.sourceId,
          page: block.input.page,
          quote: block.input.quote,
        });
      }
    }
    return;
  }

  if (kind === "user") {
    for (const block of blocks) {
      if (block?.type !== "tool_result") continue;
      const call = pending.get(block.tool_use_id);
      if (!call) continue;
      pending.delete(block.tool_use_id);

      const text = Array.isArray(block.content)
        ? block.content.find((c: any) => c?.type === "text")?.text
        : undefined;
      if (typeof text !== "string") continue;

      try {
        const parsed = JSON.parse(text);
        if (parsed?.verified === true) {
          citations.push(call);
        }
      } catch {
        // Not a JSON tool result — not a verified citation.
      }
    }
  }
}

export async function* runClaudeChatTurn(
  projectDir: string,
  conversation: AiConversation,
  request: AiChatRequest,
): AsyncGenerator<ChatTurnEvent> {
  let { missed, fresh } = claudeCatchUp(conversation);
  // Must be a real UUID: the SDK accepts any string for a brand-new session
  // but --resume requires a UUID, and conversation ids aren't (e.g. "main").
  let sdkSessionId = fresh
    ? randomUUID()
    : (conversation.sdkSessionId ?? randomUUID());
  if (fresh) closeLiveSession(projectDir, conversation.id);
  yield { type: "session", sdkSessionId };
  if (request.model) yield { type: "model", model: request.model };

  let text = "";
  let turnErrorMessage: string | undefined;
  // Verbatim SDK result errors — inspected (not shown) to recognize
  // recoverable failures like a lost session transcript.
  let rawResultErrors = "";
  const pendingCitations = new Map<
    string,
    { sourceId: string; page: number; quote: string }
  >();

  async function* run(asNewSession: boolean): AsyncGenerator<ChatTurnEvent> {
    for await (const sdkMessage of runMyWikiChatTurn(
      projectDir,
      { ...conversation, sdkSessionId },
      request,
      asNewSession,
      missed,
    )) {
      const citations: AiCitation[] = [];
      collectCitation(sdkMessage, pendingCitations, citations);
      for (const citation of citations) yield { type: "citation", citation };

      const kind = (sdkMessage as any)?.type;
      if (kind === "assistant") {
        const chunk = assistantTextFromMessage(sdkMessage);
        if (chunk) {
          const emitted = joinAssistantPart(text, chunk);
          text += emitted;
          yield { type: "text", text: emitted };
        }
        const assistantError = (sdkMessage as any).error;
        if (assistantError) {
          turnErrorMessage =
            friendlySdkError(assistantError) ?? turnErrorMessage;
        }
      }

      if (kind === "result") {
        const usage = extractUsage(sdkMessage);
        if (usage) {
          yield {
            type: "usage",
            usage,
            contextTokens: (usage.cacheReadTokens ?? 0) + usage.inputTokens,
          };
        }
        if ((sdkMessage as any).is_error) {
          const resultMessage = sdkMessage as any;
          rawResultErrors = (resultMessage.errors ?? []).join("; ");
          turnErrorMessage =
            friendlySdkError(resultMessage.subtype) ??
            resultMessage.errors?.[0] ??
            turnErrorMessage ??
            "The assistant turn ended with an error.";
        }
      }

      // Proactive plan rate-limit status — only worth surfacing once it
      // actually blocks the request, not on every utilization tick.
      if (kind === "rate_limit_event") {
        const info = (sdkMessage as any).rate_limit_info;
        if (info?.status === "rejected") {
          const resetText = info.resetsAt
            ? ` Resets around ${new Date(info.resetsAt).toLocaleTimeString()}.`
            : "";
          turnErrorMessage = `You've hit your Claude plan's rate limit.${resetText}`;
        }
      }

      // The SDK compacted this conversation's history to stay within the
      // context window. Nothing to do here, but the user should know.
      if (
        kind === "system" &&
        (sdkMessage as any)?.subtype === "compact_boundary"
      ) {
        const metadata = (sdkMessage as any).compact_metadata ?? {};
        yield {
          type: "compacted",
          trigger: metadata.trigger,
          preTokens: metadata.pre_tokens,
          postTokens: metadata.post_tokens,
        };
      }
    }
  }

  yield* run(fresh);

  // The SDK stores session transcripts per working directory, so a moved
  // knowledge folder (or a cleaned ~/.claude) makes --resume fail with "No
  // conversation found with session ID". Recoverable: a fresh session, with
  // the whole conversation handed over as history.
  if (
    rawResultErrors.includes("No conversation found with session ID") &&
    text.trim().length === 0
  ) {
    console.warn(
      `[ai/chat] SDK session ${sdkSessionId} not found (knowledge folder moved?) — starting a fresh session for conversation ${conversation.id}`,
    );
    closeLiveSession(projectDir, conversation.id);
    sdkSessionId = randomUUID();
    missed = conversation.messages.slice(0, -1);
    rawResultErrors = "";
    turnErrorMessage = undefined;
    yield { type: "session", sdkSessionId };
    yield* run(true);
  }

  if (turnErrorMessage) yield { type: "notice", message: turnErrorMessage };
}
