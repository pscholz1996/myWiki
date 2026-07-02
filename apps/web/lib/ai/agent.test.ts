import { describe, expect, test } from "vitest";
import { findStaleCitedSourceIds } from "./agent";
import type { AiConversation, AiMessage } from "./types";

function conversation(messages: AiMessage[]): AiConversation {
  return {
    id: "conv-1",
    title: "Test conversation",
    intent: "research",
    model: "claude-sonnet-5",
    messages,
    sourceIds: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function assistantMessage(citations: AiMessage["citations"]): AiMessage {
  return {
    id: "msg-1",
    role: "assistant",
    content: "answer",
    createdAt: "2026-01-01T00:00:00.000Z",
    citations,
  };
}

describe("findStaleCitedSourceIds — the deletion-safety gate", () => {
  test("returns nothing when no messages have citations", () => {
    const conv = conversation([assistantMessage(undefined)]);
    expect(findStaleCitedSourceIds(conv, new Set(["src-1"]))).toEqual([]);
  });

  test("returns nothing when every cited source still exists", () => {
    const conv = conversation([
      assistantMessage([{ sourceId: "src-1", page: 2, quote: "q" }]),
    ]);
    expect(findStaleCitedSourceIds(conv, new Set(["src-1", "src-2"]))).toEqual([]);
  });

  test("flags a source that was cited but no longer exists", () => {
    const conv = conversation([
      assistantMessage([{ sourceId: "src-1", page: 2, quote: "q" }]),
    ]);
    expect(findStaleCitedSourceIds(conv, new Set())).toEqual(["src-1"]);
  });

  test("dedupes a source cited multiple times across turns", () => {
    const conv = conversation([
      assistantMessage([{ sourceId: "src-1", page: 2, quote: "a" }]),
      assistantMessage([{ sourceId: "src-1", page: 5, quote: "b" }]),
    ]);
    expect(findStaleCitedSourceIds(conv, new Set())).toEqual(["src-1"]);
  });

  test("only flags the deleted source, not ones still present", () => {
    const conv = conversation([
      assistantMessage([
        { sourceId: "src-1", page: 1, quote: "a" },
        { sourceId: "src-2", page: 1, quote: "b" },
      ]),
    ]);
    expect(findStaleCitedSourceIds(conv, new Set(["src-2"]))).toEqual(["src-1"]);
  });
});
