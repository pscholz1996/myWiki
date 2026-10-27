import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  appendMessage,
  createAiConversation,
  mergeUsage,
  readAiConversation,
  updateAiConversation,
} from "@/lib/ai/conversations";
import {
  consumeInstituteInterrupt,
  runInstituteChatTurn,
} from "@/lib/ai/institute-agent";
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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AiChatRequest;
    const message = body.message.trim();

    if (!message) {
      return NextResponse.json({ error: "Missing message" }, { status: 400 });
    }

    const projectDir = getProjectDir();
    const conversationId = body.conversationId ?? MAIN_CONVERSATION_ID;
    const existing = await readAiConversation(projectDir, conversationId);
    let conversation: AiConversation =
      existing ?? (await createAiConversation({ projectDir, conversationId }));

    conversation = {
      ...conversation,
      // History list titles come from the opening question.
      title: conversation.title ?? message.slice(0, 80),
      sourceIds: body.sourceIds ?? conversation.sourceIds,
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
        let contextTokens: number | undefined;
        const citations: AiCitation[] = [];

        // Read once: looking at the stop flag consumes it.
        let stopped: boolean | null = null;
        const wasStopped = () => {
          stopped ??= consumeInstituteInterrupt(projectDir, conversation.id);
          return stopped;
        };

        // Shared by the normal path and the error path — a turn that dies
        // partway through still keeps the text it produced, and a turn that
        // produced none keeps the reason. A toast is gone in seconds; the
        // conversation is forever (seen live: an answer left blank with no
        // clue why).
        const persistAssistantReply = async (
          turnErrorMessage?: string,
        ): Promise<AiConversation> => {
          const failureNote = wasStopped()
            ? "You stopped this answer."
            : assistantText.trim().length === 0
              ? (turnErrorMessage ??
                "The assistant turn ended without producing an answer — likely a transient error. Please ask again.")
              : turnErrorMessage;
          const assistantMessage: AiMessage = {
            id: randomUUID(),
            role: "assistant",
            content: assistantText.trim(),
            createdAt: nowIso(),
            usage,
            error: failureNote,
            citations: citations.length > 0 ? citations : undefined,
          };
          const nextConversation = appendMessage(
            conversation,
            assistantMessage,
          );
          nextConversation.usage = cumulativeUsage;
          nextConversation.contextTokens =
            contextTokens ?? conversation.contextTokens;
          await updateAiConversation(
            projectDir,
            nextConversation.id,
            async () => nextConversation,
          );
          return nextConversation;
        };

        try {
          try {
            for await (const event of runInstituteChatTurn(
              projectDir,
              conversation,
              body,
            )) {
              if (event.type === "model") {
                // Which model actually answered. The server decides it, so
                // the client's request can't be the record.
                conversation = { ...conversation, model: event.model };
              } else if (event.type === "text") {
                assistantText += event.text;
                push("assistant_chunk", { text: event.text });
              } else if (event.type === "citation") {
                citations.push(event.citation);
              } else if (event.type === "tool") {
                console.log(
                  `[ai/chat] ${event.name} ${event.ok ? "ok" : `FAILED: ${event.detail}`} (${event.ms} ms)`,
                );
                push("tool", event);
              } else if (event.type === "usage") {
                usage = event.usage;
                cumulativeUsage = mergeUsage(conversation.usage, usage);
                contextTokens = event.contextTokens;
                push("usage", { usage: cumulativeUsage, contextTokens });
              }
            }
          } catch (error) {
            // The stop button aborts the request mid-stream, which lands
            // here as an abort error. That is the user's choice, not a
            // failure: keep what was written and end the turn normally.
            if (!wasStopped()) throw error;
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
          controller.close();
        } catch (error) {
          // Never log-and-forget: a turn that dies mid-stream is otherwise
          // invisible on the server side.
          console.error("[ai/chat] Turn failed:", error);
          const errorMessage =
            error instanceof Error ? error.message : "Chat failed";

          try {
            await persistAssistantReply(errorMessage);
          } catch (persistError) {
            console.error(
              "[ai/chat] Failed to persist the assistant reply:",
              persistError,
            );
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
