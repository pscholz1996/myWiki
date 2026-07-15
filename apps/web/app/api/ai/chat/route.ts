import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  appendMessage,
  createAiConversation,
  mergeUsage,
  readAiConversation,
  updateAiConversation,
} from "@/lib/ai/conversations";
import { runMyWikiChatTurn } from "@/lib/ai/agent";
import type {
  AiChatRequest,
  AiCitation,
  AiConversation,
  AiMessage,
  AiUsage,
} from "@/lib/ai/types";
import { MAIN_CONVERSATION_ID } from "@/lib/ai/types";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function nowIso(): string {
  return new Date().toISOString();
}

function sse(type: string, data: unknown): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

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
      return "The assistant used too many tool calls for this turn and stopped early. Try a more specific request.";
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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AiChatRequest;
    const message = body.message.trim();

    if (!message) {
      return NextResponse.json({ error: "Missing message" }, { status: 400 });
    }

    const projectDir = getProjectDir();
    const conversationId = MAIN_CONVERSATION_ID;
    const existing = await readAiConversation(projectDir, conversationId);
    // No prior turns means no SDK session has been established yet — see
    // the isNewSession/resume split in runMyWikiChatTurn.
    const isNewSession = !existing || existing.messages.length === 0;
    let conversation: AiConversation =
      existing ??
      (await createAiConversation({
        projectDir,
        conversationId,
        model: body.model,
      }));

    conversation = {
      ...conversation,
      model: body.model ?? conversation.model,
      sourceIds: body.sourceIds ?? conversation.sourceIds,
      // Must be a real UUID, independent of conversation.id: the Claude
      // Agent SDK accepts any caller-chosen string for a brand-new session
      // (sessionId, first turn only), but --resume on every turn after
      // that requires a real UUID or session title. conversation.id is now
      // the fixed, human-readable MAIN_CONVERSATION_ID ("main") rather than
      // a UUID (see the single-continuing-conversation change), so it can
      // no longer double as the SDK session id the way it used to.
      sdkSessionId: conversation.sdkSessionId ?? randomUUID(),
    };

    const userMessage: AiMessage = {
      id: randomUUID(),
      role: "user",
      content: message,
      createdAt: nowIso(),
    };

    conversation = appendMessage(conversation, userMessage);
    await updateAiConversation(
      projectDir,
      conversation.id,
      async () => conversation,
    );

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const push = (type: string, data: unknown) => {
          controller.enqueue(sse(type, data));
        };

        let assistantText = "";
        let usage: AiUsage | undefined;
        // Cumulative across the whole conversation, not just this turn —
        // what the panel's "N in / M out" header is meant to represent.
        let cumulativeUsage: AiUsage | undefined = conversation.usage;
        // Approximate current context-window size: cacheReadTokens +
        // inputTokens of the latest turn is what was actually loaded for
        // that API call (see the AiConversation.contextTokens doc comment
        // for why this is an estimate, not the SDK's exact figure).
        let contextTokens: number | undefined;
        // The first recognizable failure this turn hits (auth, billing,
        // rate limit, overload, etc.) — surfaced as a friendly toast
        // instead of leaving the user to infer it from a stalled response.
        let turnErrorMessage: string | undefined;
        const pendingCitations = new Map<
          string,
          { sourceId: string; page: number; quote: string }
        >();
        const citations: AiCitation[] = [];

        // Shared by both the normal completion path and the error path
        // below — a turn that dies partway through (e.g. during citation
        // verification) should still save whatever text was actually
        // generated, not throw it away along with the failure.
        const persistAssistantReply = async (): Promise<AiConversation> => {
          const assistantMessage: AiMessage = {
            id: randomUUID(),
            role: "assistant",
            content: assistantText.trim(),
            createdAt: nowIso(),
            usage,
            citations: citations.length > 0 ? citations : undefined,
          };
          const nextConversation = appendMessage(conversation, assistantMessage);
          nextConversation.usage = cumulativeUsage;
          nextConversation.contextTokens = contextTokens ?? conversation.contextTokens;
          await updateAiConversation(
            projectDir,
            nextConversation.id,
            async () => nextConversation,
          );
          return nextConversation;
        };

        try {
          for await (const sdkMessage of runMyWikiChatTurn(
            projectDir,
            conversation,
            body,
            isNewSession,
          )) {
            push("sdk", sdkMessage);
            collectCitation(sdkMessage, pendingCitations, citations);

            const kind = (sdkMessage as any)?.type;
            if (kind === "assistant") {
              const chunk = assistantTextFromMessage(sdkMessage);
              if (chunk) {
                assistantText += chunk;
                push("assistant_chunk", { text: chunk });
              }
              const assistantError = (sdkMessage as any).error;
              if (assistantError) {
                turnErrorMessage = friendlySdkError(assistantError) ?? turnErrorMessage;
              }
            }

            if (kind === "result") {
              usage = extractUsage(sdkMessage);
              if (usage) {
                cumulativeUsage = mergeUsage(conversation.usage, usage);
                contextTokens = (usage.cacheReadTokens ?? 0) + usage.inputTokens;
                push("usage", { usage: cumulativeUsage, contextTokens });
              }
              if ((sdkMessage as any).is_error) {
                const resultMessage = sdkMessage as any;
                turnErrorMessage =
                  friendlySdkError(resultMessage.subtype) ??
                  resultMessage.errors?.[0] ??
                  turnErrorMessage ??
                  "The assistant turn ended with an error.";
              }
            }

            // Proactive plan rate-limit status (five-hour/seven-day windows
            // for claude.ai subscription users) — only worth surfacing once
            // it actually blocks the request, not on every utilization tick.
            if (kind === "rate_limit_event") {
              const info = (sdkMessage as any).rate_limit_info;
              if (info?.status === "rejected") {
                const resetText = info.resetsAt
                  ? ` Resets around ${new Date(info.resetsAt).toLocaleTimeString()}.`
                  : "";
                turnErrorMessage = `You've hit your Claude plan's rate limit.${resetText}`;
              }
            }

            // The SDK compacted this conversation's history to stay within
            // the context window (see agent.ts's autoCompactEnabled). This
            // doesn't change anything we need to do — the SDK's own
            // persisted session already summarized what it dropped — but
            // the user should know it happened rather than just noticing
            // the model "forgot" something from many turns ago.
            if (kind === "system" && (sdkMessage as any)?.subtype === "compact_boundary") {
              const metadata = (sdkMessage as any).compact_metadata ?? {};
              push("compacted", {
                trigger: metadata.trigger,
                preTokens: metadata.pre_tokens,
                postTokens: metadata.post_tokens,
              });
            }
          }

          const nextConversation = await persistAssistantReply();
          push("assistant_done", {
            conversationId: nextConversation.id,
            usage: cumulativeUsage,
            contextTokens: nextConversation.contextTokens,
            content:
              nextConversation.messages.at(-1)?.content ?? assistantText.trim(),
            citations: citations.length > 0 ? citations : undefined,
          });
          if (turnErrorMessage) {
            push("error", {
              conversationId: nextConversation.id,
              message: turnErrorMessage,
            });
          }
          controller.close();
        } catch (error) {
          // Never log-and-forget: a turn that dies mid-stream is otherwise
          // invisible — the user's own message was already persisted before
          // streaming started, but with nothing here, the assistant side
          // stays silently blank forever (no saved reply, no server-side
          // trace to diagnose from) even if real work — tokens, tool calls,
          // partial text — already happened before the failure.
          console.error("[ai/chat] Turn failed:", error);

          const errorMessage =
            turnErrorMessage ??
            (error instanceof Error ? error.message : "Chat failed");

          // Persist whatever text the model produced before it failed, so a
          // late-turn error (e.g. during citation verification) doesn't
          // throw away real, already-generated content along with it.
          if (assistantText.trim()) {
            try {
              await persistAssistantReply();
            } catch (persistError) {
              console.error(
                "[ai/chat] Failed to persist partial assistant message:",
                persistError,
              );
            }
          }

          push("error", {
            conversationId: conversation.id,
            message: errorMessage,
          });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    if (error instanceof NoProjectSelectedError) {
      return NextResponse.json(
        { error: "no-project-selected" },
        { status: 409 },
      );
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
