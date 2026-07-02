import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  appendMessage,
  createAiConversation,
  readAiConversation,
  updateAiConversation,
} from "@/lib/ai/conversations";
import { runOpenLatexChatTurn } from "@/lib/ai/agent";
import type {
  AiChatRequest,
  AiCitation,
  AiConversation,
  AiMessage,
  AiUsage,
} from "@/lib/ai/types";
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

/**
 * Track pending mcp__openlatex__cite tool calls by tool_use id, then
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
        block.name === "mcp__openlatex__cite" &&
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
    const conversationId = body.conversationId ?? randomUUID();
    const existing = await readAiConversation(projectDir, conversationId);
    let conversation: AiConversation =
      existing ??
      (await createAiConversation({
        projectDir,
        conversationId,
        intent: body.intent,
        model: body.model,
      }));

    conversation = {
      ...conversation,
      intent: body.intent ?? conversation.intent,
      model: body.model ?? conversation.model,
      sourceIds: body.sourceIds ?? conversation.sourceIds,
      sdkSessionId: conversation.sdkSessionId ?? conversation.id,
      title:
        conversation.title === "New conversation"
          ? message.slice(0, 64)
          : conversation.title,
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

        push("conversation", {
          id: conversation.id,
          title: conversation.title,
          intent: conversation.intent,
        });

        let assistantText = "";
        let usage: AiUsage | undefined;
        const pendingCitations = new Map<
          string,
          { sourceId: string; page: number; quote: string }
        >();
        const citations: AiCitation[] = [];

        try {
          for await (const sdkMessage of runOpenLatexChatTurn(
            projectDir,
            conversation,
            body,
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
            }

            if (kind === "result") {
              usage = extractUsage(sdkMessage);
              if (usage) {
                push("usage", usage);
              }
            }
          }

          const assistantMessage: AiMessage = {
            id: randomUUID(),
            role: "assistant",
            content: assistantText.trim(),
            createdAt: nowIso(),
            usage,
            citations: citations.length > 0 ? citations : undefined,
          };

          const nextConversation = appendMessage(
            conversation,
            assistantMessage,
          );
          nextConversation.usage = usage;
          await updateAiConversation(
            projectDir,
            nextConversation.id,
            async () => nextConversation,
          );
          push("assistant_done", {
            conversationId: nextConversation.id,
            usage,
            content: assistantMessage.content,
            citations: assistantMessage.citations,
          });
          controller.close();
        } catch (error) {
          push("error", {
            conversationId: conversation.id,
            message: error instanceof Error ? error.message : "Chat failed",
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
