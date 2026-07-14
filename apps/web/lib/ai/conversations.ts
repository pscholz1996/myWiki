import fs from "node:fs/promises";
import path from "node:path";
import { ensureAiWorkspace } from "@/lib/ai/knowledge-base";
import type { AiConversation, AiMessage, AiUsage } from "@/lib/ai/types";

const CONVERSATIONS_DIR = [".mywiki", "ai", "conversations"] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function conversationFilePath(projectDir: string, conversationId: string): string {
  return path.join(projectDir, ...CONVERSATIONS_DIR, `${conversationId}.json`);
}

async function ensureConversationDir(projectDir: string): Promise<string> {
  const { aiDir } = await ensureAiWorkspace(projectDir);
  const dir = path.join(aiDir, "conversations");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function readAiConversation(
  projectDir: string,
  conversationId: string,
): Promise<AiConversation | null> {
  const filePath = conversationFilePath(projectDir, conversationId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as AiConversation;
  } catch {
    return null;
  }
}

export async function writeAiConversation(
  projectDir: string,
  conversation: AiConversation,
): Promise<void> {
  const dir = await ensureConversationDir(projectDir);
  const filePath = path.join(dir, `${conversation.id}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(conversation, null, 2)}\n`, "utf8");
}

export async function deleteAiConversation(
  projectDir: string,
  conversationId: string,
): Promise<void> {
  const filePath = conversationFilePath(projectDir, conversationId);
  await fs.rm(filePath, { force: true });
}

export async function createAiConversation(params: {
  projectDir: string;
  conversationId: string;
  model?: string;
  sdkSessionId?: string;
  sourceIds?: string[];
}): Promise<AiConversation> {
  const conversation: AiConversation = {
    id: params.conversationId,
    model: params.model ?? "claude-sonnet-5",
    sdkSessionId: params.sdkSessionId,
    messages: [],
    sourceIds: params.sourceIds ?? [],
    updatedAt: nowIso(),
  };

  await writeAiConversation(params.projectDir, conversation);
  return conversation;
}

export async function updateAiConversation(
  projectDir: string,
  conversationId: string,
  updater: (conversation: AiConversation) => AiConversation | Promise<AiConversation>,
): Promise<AiConversation> {
  const current =
    (await readAiConversation(projectDir, conversationId)) ??
    (await createAiConversation({ projectDir, conversationId }));

  const next = await updater(current);
  next.updatedAt = nowIso();
  await writeAiConversation(projectDir, next);
  return next;
}

export function appendMessage(
  conversation: AiConversation,
  message: AiMessage,
): AiConversation {
  return {
    ...conversation,
    messages: [...conversation.messages, message],
  };
}

export function mergeUsage(left?: AiUsage, right?: AiUsage): AiUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0),
    cacheWriteTokens:
      (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0),
  };
}
