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

        try {
          for await (const sdkMessage of runOpenLatexChatTurn(
            projectDir,
            conversation,
            body,
          )) {
            push("sdk", sdkMessage);

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
