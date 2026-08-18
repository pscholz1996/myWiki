import { describe, expect, test } from "vitest";
import { DEFAULT_TAGLINE_TAIL, sanitizeTaglineTail } from "./types";

describe("sanitizeTaglineTail", () => {
  test("keeps a clause that already obeys the brief", () => {
    expect(
      sanitizeTaglineTail("let's work through your systems material."),
    ).toBe("let's work through your systems material.");
  });

  test("strips the quotes models like to wrap the answer in", () => {
    expect(sanitizeTaglineTail('"let\'s dig into your vessel research."')).toBe(
      "let's dig into your vessel research.",
    );
  });

  test("drops the dash it was shown in the sentence template", () => {
    expect(
      sanitizeTaglineTail("— let's explore your control theory notes."),
    ).toBe("let's explore your control theory notes.");
  });

  test("takes only the first line when it answers in several", () => {
    expect(
      sanitizeTaglineTail(
        "let's explore your thermodynamics sources.\n\nHope that helps!",
      ),
    ).toBe("let's explore your thermodynamics sources.");
  });

  test("adds the missing full stop", () => {
    expect(sanitizeTaglineTail("let's map your propulsion sources")).toBe(
      "let's map your propulsion sources.",
    );
  });

  test("collapses the whitespace of a wrapped reply", () => {
    expect(
      sanitizeTaglineTail("  let's review   your   naval sources.  "),
    ).toBe("let's review your naval sources.");
  });

  // Everything below falls back to DEFAULT_TAGLINE_TAIL rather than putting a
  // broken line under the heading.
  test("rejects an empty answer", () => {
    expect(sanitizeTaglineTail("   \n  ")).toBeNull();
  });

  test("rejects a clause too long for the line", () => {
    expect(sanitizeTaglineTail(`let's ${"very ".repeat(20)}long.`)).toBeNull();
  });

  test("rejects markdown, which would render as literal characters", () => {
    expect(
      sanitizeTaglineTail("let's explore your **systems** sources."),
    ).toBeNull();
    expect(
      sanitizeTaglineTail("- let's explore your [sources](x)."),
    ).toBeNull();
  });

  test("the default is a usable clause by its own rules", () => {
    expect(sanitizeTaglineTail(DEFAULT_TAGLINE_TAIL)).toBe(
      DEFAULT_TAGLINE_TAIL,
    );
  });
});
