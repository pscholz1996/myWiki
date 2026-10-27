import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import {
  _setTimeoutsForTesting,
  createToolCallAccumulator,
  InstituteLlmNotConfiguredError,
  InstituteLlmUnavailableError,
  resolveInstituteModel,
  streamInstituteChat,
  takeSseData,
} from "./institute-llm";

describe("header timeout", () => {
  const saved = process.env.MYWIKI_LLM_BASE_URL;
  let server: http.Server | undefined;
  afterEach(() => {
    process.env.MYWIKI_LLM_BASE_URL = saved;
    _setTimeoutsForTesting({});
    server?.close();
  });

  async function serve(handler: http.RequestListener): Promise<void> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    process.env.MYWIKI_LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
  }

  const delta = (text: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

  // The regression: the timeout used to ride on the fetch signal and so cut
  // every answer that streamed for longer than it — seen live at 16 s.
  test("a stream that outlasts the timeout still arrives in full", async () => {
    _setTimeoutsForTesting({ stream: 150 });
    await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const words = ["Ein ", "langer ", "Satz ", "kommt ", "an."];
      let index = 0;
      const timer = setInterval(() => {
        if (index < words.length) {
          res.write(delta(words[index]));
          index += 1;
        } else {
          clearInterval(timer);
          res.end("data: [DONE]\n\n");
        }
      }, 80); // 5 × 80 ms = 400 ms, well past the 150 ms timeout
    });

    let text = "";
    for await (const event of streamInstituteChat({
      model: "m",
      messages: [],
    })) {
      if (event.type === "text") text += event.delta;
    }
    expect(text).toBe("Ein langer Satz kommt an.");
  });

  test("a server that never answers counts as unreachable", async () => {
    _setTimeoutsForTesting({ stream: 150 });
    await serve(() => {
      // accepts the connection, never sends headers
    });
    const run = async () => {
      for await (const _ of streamInstituteChat({ model: "m", messages: [] })) {
        // drain
      }
    };
    await expect(run()).rejects.toBeInstanceOf(InstituteLlmUnavailableError);
  });
});

describe("unreachable or missing server", () => {
  const saved = process.env.MYWIKI_LLM_BASE_URL;
  afterEach(() => {
    process.env.MYWIKI_LLM_BASE_URL = saved;
  });

  // No VPN looks exactly like this: the host name doesn't resolve. The chat
  // must say so in plain words — and must not quietly try a cloud model
  // instead (a user decision). .invalid is reserved and never resolves.
  test("a host that doesn't resolve reads as 'connect the VPN'", async () => {
    process.env.MYWIKI_LLM_BASE_URL = "https://llm.example.invalid:8080/v1";
    const attempt = resolveInstituteModel();
    await expect(attempt).rejects.toBeInstanceOf(InstituteLlmUnavailableError);
    await expect(attempt).rejects.toThrow(/VPN/);
  });

  test("no configured server says where to configure it", async () => {
    process.env.MYWIKI_LLM_BASE_URL = "";
    await expect(resolveInstituteModel()).rejects.toBeInstanceOf(
      InstituteLlmNotConfiguredError,
    );
  });
});

describe("takeSseData", () => {
  test("returns complete data payloads and keeps the unfinished line", () => {
    const { payloads, rest } = takeSseData(
      'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"',
    );
    expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('data: {"c"');
  });

  test("drops the [DONE] sentinel and non-data lines", () => {
    const { payloads } = takeSseData(
      ': keep-alive\nevent: x\ndata: {"a":1}\ndata: [DONE]\n',
    );
    expect(payloads).toEqual(['{"a":1}']);
  });

  // A network chunk can end anywhere — mid-line, mid-JSON.
  test("reassembles a payload split across chunks", () => {
    const first = takeSseData('data: {"text":"Hal');
    expect(first.payloads).toEqual([]);
    const second = takeSseData(`${first.rest}lo"}\n`);
    expect(second.payloads).toEqual(['{"text":"Hallo"}']);
  });

  test("tolerates CRLF line endings", () => {
    expect(takeSseData('data: {"a":1}\r\n\r\n').payloads).toEqual(['{"a":1}']);
  });
});

describe("createToolCallAccumulator", () => {
  // The shape vLLM actually sent for gemma on 19.10.2026: two parallel
  // searches, id and name once, arguments spread over several deltas.
  test("reassembles parallel calls streamed in fragments", () => {
    const acc = createToolCallAccumulator();
    acc.add({
      index: 0,
      id: "call-a",
      function: { name: "search_knowledge_base", arguments: "" },
    });
    acc.add({
      index: 1,
      id: "call-b",
      function: { name: "search_knowledge_base", arguments: "" },
    });
    acc.add({ index: 0, function: { arguments: '{"query": "Surr' } });
    acc.add({ index: 1, function: { arguments: '{"query": "EMS-' } });
    acc.add({ index: 0, function: { arguments: 'ogatmodelle"}' } });
    acc.add({ index: 1, function: { arguments: 'Architektur"}' } });

    const calls = acc.finish();
    expect(calls.map((call) => call.id)).toEqual(["call-a", "call-b"]);
    expect(calls.map((call) => JSON.parse(call.function.arguments))).toEqual([
      { query: "Surrogatmodelle" },
      { query: "EMS-Architektur" },
    ]);
  });

  test("orders calls by index, not by arrival", () => {
    const acc = createToolCallAccumulator();
    acc.add({ index: 1, id: "second", function: { name: "b" } });
    acc.add({ index: 0, id: "first", function: { name: "a" } });
    expect(acc.finish().map((call) => call.id)).toEqual(["first", "second"]);
  });

  // The tool result message must reference an id; an empty one would make
  // the next request pair results with the wrong calls.
  test("invents a unique id when the server omits it", () => {
    const acc = createToolCallAccumulator();
    acc.add({ index: 0, function: { name: "cite", arguments: "{}" } });
    acc.add({ index: 1, function: { name: "cite", arguments: "{}" } });
    const ids = acc.finish().map((call) => call.id);
    expect(ids[0]).not.toBe("");
    expect(new Set(ids).size).toBe(2);
  });
});
