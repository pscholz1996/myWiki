import { describe, expect, test } from "vitest";
import { applyExactReplace, findStaleCitedSourceIds } from "./agent";
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

describe("applyExactReplace — the targeted-edit matching gate", () => {
  test("replaces a unique match", () => {
    const result = applyExactReplace("intro\nbody\noutro", "body", "middle");
    expect(result).toEqual({ content: "intro\nmiddle\noutro" });
  });

  test("errors when old_text is absent", () => {
    const result = applyExactReplace("intro\nbody\noutro", "missing", "x");
    expect("error" in result).toBe(true);
  });

  test("errors when old_text matches more than once, without editing", () => {
    const result = applyExactReplace("dup\nfiller\ndup", "dup", "x");
    expect("error" in result).toBe(true);
  });

  test("deletes the snippet when new_text is empty", () => {
    const result = applyExactReplace("keep this\nand this", "this\nand ", "");
    expect(result).toEqual({ content: "keep this" });
  });

  test("does not treat literal $ in new_text as a replacement pattern", () => {
    // LaTeX math mode ("$x^2$") looks like String.replace's special "$&"
    // substitution syntax to a naive content.replace(old, new) call — this
    // is exactly the bug applyExactReplace's function-form replace avoids.
    const result = applyExactReplace("Let x be a value.", "a value", "$x^2$");
    expect(result).toEqual({ content: "Let x be $x^2$." });
  });
});
