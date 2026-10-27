import { describe, expect, test } from "vitest";
import { claudeCatchUp } from "./agent";
import { type AiConversation, type AiMessage, modelProvider } from "./types";

describe("modelProvider", () => {
  test("recognizes Claude aliases and wire ids", () => {
    for (const model of [
      "opus",
      "sonnet",
      "haiku",
      "default",
      "opus[1m]",
      "claude-opus-5-5",
      "claude-fable-5-1[1m]",
    ]) {
      expect(modelProvider(model)).toBe("claude");
    }
  });

  // Anything not recognizably Claude stays in-house: a question must never
  // leave the institute without the user having picked a Claude model.
  test("everything else is the institute", () => {
    for (const model of ["institute", "google/gemma-4-31B-it", "", undefined]) {
      expect(modelProvider(model)).toBe("institute");
    }
  });
});

function message(role: "user" | "assistant", content: string): AiMessage {
  return { id: content, role, content, createdAt: "2026-10-27T10:00:00Z" };
}

function conversation(
  overrides: Partial<AiConversation>,
  contents: string[],
): AiConversation {
  return {
    id: "c1",
    model: "institute",
    sourceIds: [],
    updatedAt: "2026-10-27T10:00:00Z",
    messages: contents.map((content, index) =>
      message(index % 2 === 0 ? "user" : "assistant", content),
    ),
    ...overrides,
  };
}

describe("claudeCatchUp", () => {
  // The case it exists for: Claude answered, then the institute LLM did,
  // now Claude again — it must get the turns it never saw.
  test("hands over exactly the turns Claude's session missed", () => {
    const result = claudeCatchUp(
      conversation(
        {
          sdkSessionId: "s1",
          claudeSeenCount: 2,
          model: "google/gemma-4-31B-it",
        },
        [
          "q1 (claude)",
          "a1 (claude)",
          "q2 (institute)",
          "a2 (institute)",
          "q3 now",
        ],
      ),
    );
    expect(result.fresh).toBe(false);
    expect(result.missed.map((entry) => entry.content)).toEqual([
      "q2 (institute)",
      "a2 (institute)",
    ]);
  });

  test("nothing missed when Claude answered the turn before", () => {
    const result = claudeCatchUp(
      conversation({ sdkSessionId: "s1", claudeSeenCount: 2, model: "opus" }, [
        "q1",
        "a1",
        "q2 now",
      ]),
    );
    expect(result).toEqual({ missed: [], fresh: false });
  });

  test("a conversation that never ran on Claude starts fresh with its whole history", () => {
    const result = claudeCatchUp(conversation({}, ["q1", "a1", "q2 now"]));
    expect(result.fresh).toBe(true);
    expect(result.missed.map((entry) => entry.content)).toEqual(["q1", "a1"]);
  });

  // From before claudeSeenCount existed.
  test("an older Claude-only conversation resumes as it always did", () => {
    const result = claudeCatchUp(
      conversation({ sdkSessionId: "s1", model: "claude-opus-5-5" }, [
        "q1",
        "a1",
        "q2 now",
      ]),
    );
    expect(result).toEqual({ missed: [], fresh: false });
  });

  test("an older conversation last answered in-house starts fresh rather than guess", () => {
    const result = claudeCatchUp(
      conversation({ sdkSessionId: "s1", model: "google/gemma-4-31B-it" }, [
        "q1",
        "a1",
        "q2 now",
      ]),
    );
    expect(result.fresh).toBe(true);
    expect(result.missed).toHaveLength(2);
  });
});
