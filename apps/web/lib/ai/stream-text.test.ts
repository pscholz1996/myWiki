import { describe, expect, test } from "vitest";
import { joinAssistantPart } from "./stream-text";

describe("joinAssistantPart", () => {
  test("inserts a blank line between fused parts (the live '##' bug)", () => {
    const first = "…eine Literaturstudie, die genau diese Struktur verwendet:";
    const second = "## Übersicht: KI entlang des V-Modells";
    const emitted = joinAssistantPart(first, second);
    expect(first + emitted).toBe(`${first}\n\n${second}`);
  });

  test("no separator for the first part", () => {
    expect(joinAssistantPart("", "Hello")).toBe("Hello");
  });

  test("no double separator when the previous part already ends with a newline", () => {
    expect(joinAssistantPart("para one\n", "para two")).toBe("para two");
  });

  test("no separator when the new part brings its own leading newline", () => {
    expect(joinAssistantPart("para one", "\n\npara two")).toBe("\n\npara two");
  });

  test("empty part stays empty", () => {
    expect(joinAssistantPart("something", "")).toBe("");
  });
});
