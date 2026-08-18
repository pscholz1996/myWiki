import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  findModelOption,
  toPickerOptions,
  type AiConversation,
  type AiModelOption,
} from "./types";

// A stand-in for the SDK's Query. The real one is a CLI subprocess, so the
// model-switch logic — the part that actually broke — can only be observed
// through the control calls the session makes on it.
const harness = vi.hoisted(() => {
  class FakeQuery {
    /** Model each turn actually ran under, in order. */
    readonly turnModels: string[] = [];
    readonly setModelCalls: string[] = [];
    setModelRejects = false;
    closed = false;
    currentModel: string;

    private pending: Array<(value: IteratorResult<unknown>) => void> = [];
    private buffered: unknown[] = [];
    private done = false;

    constructor(readonly options: any) {
      this.currentModel = options?.options?.model;
      void this.consumePrompt();
    }

    // Mirrors the real CLI: each user message on the prompt stream produces
    // an assistant message and then a result, which is what ends a turn.
    private async consumePrompt(): Promise<void> {
      for await (const _message of this.options.prompt) {
        this.turnModels.push(this.currentModel);
        this.emit({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
          },
        });
        this.emit({ type: "result", subtype: "success", is_error: false });
      }
      this.finish();
    }

    private emit(message: unknown): void {
      const waiter = this.pending.shift();
      if (waiter) waiter({ value: message, done: false });
      else this.buffered.push(message);
    }

    private finish(): void {
      this.done = true;
      for (const waiter of this.pending.splice(0)) {
        waiter({ value: undefined, done: true });
      }
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      while (true) {
        if (this.buffered.length > 0) {
          yield this.buffered.shift();
          continue;
        }
        if (this.done) return;
        const result = await new Promise<IteratorResult<unknown>>((resolve) => {
          this.pending.push(resolve);
        });
        if (result.done) return;
        yield result.value;
      }
    }

    async setMcpServers(): Promise<void> {}

    async setModel(model: string): Promise<void> {
      this.setModelCalls.push(model);
      if (this.setModelRejects) throw new Error("control request failed");
      this.currentModel = model;
    }

    async supportedModels(): Promise<unknown[]> {
      return [
        {
          value: "sonnet",
          resolvedModel: "claude-sonnet-5",
          displayName: "Sonnet",
          description: "d",
        },
      ];
    }

    async interrupt(): Promise<void> {}

    close(): void {
      this.closed = true;
      this.finish();
    }
  }

  const created: FakeQuery[] = [];
  return { FakeQuery, created };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (options: unknown) => {
    const instance = new harness.FakeQuery(options);
    harness.created.push(instance);
    return instance;
  },
  createSdkMcpServer: () => ({}),
  tool: () => ({}),
}));

const { closeLiveSession, runMyWikiChatTurn } = await import("./agent");

let projectDir: string;

function conversation(model: string): AiConversation {
  return {
    id: "conv-model-test",
    model,
    sdkSessionId: "11111111-2222-3333-4444-555555555555",
    messages: [],
    sourceIds: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Runs one full turn and discards the streamed messages. */
async function runTurn(model: string, isNewSession: boolean): Promise<void> {
  for await (const _message of runMyWikiChatTurn(
    projectDir,
    conversation(model),
    { message: "hi", conversationId: "conv-model-test", model },
    isNewSession,
  )) {
    // Draining the stream is what makes the turn complete.
  }
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "mywiki-model-"));
  harness.created.length = 0;
});

afterEach(() => {
  closeLiveSession(projectDir);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("findModelOption", () => {
  // Shaped like the real list: "default" and "sonnet" both resolve to the
  // same wire id today, which is exactly where picking the wrong row hurts.
  const options: AiModelOption[] = [
    {
      value: "default",
      resolvedModel: "claude-sonnet-5",
      displayName: "Default (recommended)",
      description: "d",
    },
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "d",
    },
    {
      value: "opus[1m]",
      resolvedModel: "claude-opus-4-8[1m]",
      displayName: "Opus",
      description: "d",
    },
  ];

  test("matches a row by its own value", () => {
    expect(findModelOption(options, "opus[1m]")?.displayName).toBe("Opus");
  });

  // The whole reason resolvedModel exists: conversations created before the
  // picker persisted the wire id, not the alias the SDK now returns.
  test("matches a persisted wire id to its alias row", () => {
    expect(findModelOption(options, "claude-sonnet-5")?.value).toBe("sonnet");
  });

  test('"default" stays selectable in its own right', () => {
    expect(findModelOption(options, "default")?.value).toBe("default");
  });

  // "default" tracks whatever Anthropic recommends; a pinned wire id does
  // not. Showing the moving row for a pinned model misreports what will run.
  test('prefers the pinned row over "default" for the same wire id', () => {
    expect(findModelOption(options, "claude-sonnet-5")?.displayName).toBe(
      "Sonnet",
    );
  });

  test('falls back to "default" when it is the only row that resolves', () => {
    const onlyDefault: AiModelOption[] = [
      {
        value: "default",
        resolvedModel: "claude-sonnet-5",
        displayName: "Default (recommended)",
        description: "d",
      },
    ];
    expect(findModelOption(onlyDefault, "claude-sonnet-5")?.value).toBe(
      "default",
    );
  });

  test("returns nothing for an unknown or missing model", () => {
    expect(findModelOption(options, "claude-ancient-1")).toBeUndefined();
    expect(findModelOption(options, undefined)).toBeUndefined();
  });

  // Conversations that picked "default" while the picker still offered it
  // keep that string on disk, and would otherwise highlight no row at all.
  test('a stored "default" lands on the recommended row once the row is gone', () => {
    expect(findModelOption(toPickerOptions(options), "default")?.value).toBe(
      "sonnet",
    );
  });
});

describe("toPickerOptions", () => {
  const options: AiModelOption[] = [
    {
      value: "default",
      resolvedModel: "claude-sonnet-5",
      displayName: "Default",
      description: "d",
    },
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "d",
    },
    {
      value: "opus[1m]",
      resolvedModel: "claude-opus-4-8[1m]",
      displayName: "Opus",
      description: "d",
    },
  ];

  test('drops "default" once a pinned row covers the same model', () => {
    expect(toPickerOptions(options).map((option) => option.value)).toEqual([
      "sonnet",
      "opus[1m]",
    ]);
  });

  test("marks the row the recommendation currently points at", () => {
    const [sonnet, opus] = toPickerOptions(options);
    expect(sonnet.recommended).toBe(true);
    // The mark is a label, not a model change: the row still selects the
    // pinned "sonnet", never the moving "default".
    expect(sonnet.value).toBe("sonnet");
    expect(opus.recommended).toBeUndefined();
  });

  // The mark has to follow the recommendation, not a constant, or it would
  // sit on Sonnet the day the SDK starts recommending something else.
  test("follows the recommendation when it moves to another row", () => {
    const moved = toPickerOptions([
      { ...options[0], resolvedModel: "claude-opus-4-8[1m]" },
      options[1],
      options[2],
    ]);
    expect(
      moved.map((option) => [option.value, option.recommended === true]),
    ).toEqual([
      ["sonnet", false],
      ["opus[1m]", true],
    ]);
  });

  // Dropping it here would make the model unreachable rather than redundant.
  test('keeps "default" when no other row resolves to it', () => {
    const unmatched: AiModelOption[] = [
      {
        value: "default",
        resolvedModel: "claude-unlisted-9",
        displayName: "Default",
        description: "d",
      },
      options[2],
    ];
    expect(toPickerOptions(unmatched)).toEqual(unmatched);
  });

  // The offline fallback list has no "default" row at all, and still needs
  // the recommended marker on the model the app asks for by default.
  test('marks the app default when the list has no "default" row', () => {
    const marked = toPickerOptions([options[1], options[2]]);
    expect(
      marked.map((option) => [option.value, option.recommended === true]),
    ).toEqual([
      ["sonnet", true],
      ["opus[1m]", false],
    ]);
  });
});

describe("runMyWikiChatTurn — model switching", () => {
  test("runs the first turn on the requested model", async () => {
    await runTurn("opus[1m]", true);

    expect(harness.created).toHaveLength(1);
    expect(harness.created[0].options.options.model).toBe("opus[1m]");
    expect(harness.created[0].turnModels).toEqual(["opus[1m]"]);
  });

  test("reuses the session and issues no control call when the model is unchanged", async () => {
    await runTurn("sonnet", true);
    await runTurn("sonnet", false);

    expect(harness.created).toHaveLength(1);
    expect(harness.created[0].setModelCalls).toEqual([]);
    expect(harness.created[0].turnModels).toEqual(["sonnet", "sonnet"]);
  });

  // The regression this feature turns on: switching mid-conversation used to
  // be accepted by the UI and then silently ignored, because a live session
  // only ever received its model in the constructor.
  test("switches a live session's model in place, keeping the session", async () => {
    await runTurn("sonnet", true);
    await runTurn("opus[1m]", false);

    expect(harness.created).toHaveLength(1);
    expect(harness.created[0].setModelCalls).toEqual(["opus[1m]"]);
    expect(harness.created[0].turnModels).toEqual(["sonnet", "opus[1m]"]);
    expect(harness.created[0].closed).toBe(false);
  });

  test("rebuilds the session by resuming when the switch can't be applied", async () => {
    await runTurn("sonnet", true);
    harness.created[0].setModelRejects = true;
    await runTurn("opus[1m]", false);

    expect(harness.created).toHaveLength(2);
    expect(harness.created[0].closed).toBe(true);

    const rebuilt = harness.created[1];
    expect(rebuilt.options.options.model).toBe("opus[1m]");
    expect(rebuilt.turnModels).toEqual(["opus[1m]"]);
    // Resume, never a second sessionId: re-declaring an id the SDK has
    // already persisted kills the CLI process.
    expect(rebuilt.options.options.resume).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(rebuilt.options.options.sessionId).toBeUndefined();
  });
});
