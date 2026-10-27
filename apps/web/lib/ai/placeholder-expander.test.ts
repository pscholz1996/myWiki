import { describe, expect, test } from "vitest";
import { createPlaceholderExpander } from "./placeholder-expander";

const VISUALS: Record<string, string> = {
  v1: "![Schema](/api/ai/images/img-1)\n*Source: own illustration*",
};
const resolve = (id: string) => VISUALS[id];

function run(deltas: string[]) {
  const expander = createPlaceholderExpander(resolve);
  const out = deltas.map((delta) => expander.push(delta)).join("");
  return { text: out + expander.flush(), used: expander.used() };
}

describe("createPlaceholderExpander", () => {
  test("swaps a placeholder for its visual, as its own paragraph", () => {
    const { text, used } = run(["Siehe:{{visual:v1}}Danach."]);
    expect(text).toBe(`Siehe:\n\n${VISUALS.v1}\n\nDanach.`);
    expect([...used]).toEqual(["v1"]);
  });

  // The case the state machine exists for: token boundaries fall anywhere.
  test("handles a placeholder split across many deltas", () => {
    const { text } = run(["A {", "{vis", "ual:", "v1}", "} B"]);
    expect(text).toBe(`A \n\n${VISUALS.v1}\n\n B`);
  });

  test("never shows a half placeholder before it closes", () => {
    const expander = createPlaceholderExpander(resolve);
    expect(expander.push("Text {{visu")).toBe("Text ");
    expect(expander.push("al:v1}}")).toBe(`\n\n${VISUALS.v1}\n\n`);
  });

  test("tolerates whitespace the model adds inside the braces", () => {
    expect(run(["{{ visual : v1 }}"]).text).toContain(VISUALS.v1);
  });

  test("leaves other {{…}} text untouched", () => {
    expect(run(["Vorlage {{name}} hier"]).text).toBe("Vorlage {{name}} hier");
  });

  // A visual that never came (declined, or an invented id) must not reach
  // the reader as a raw "{{visual:…}}".
  test("drops a placeholder whose visual never arrives", () => {
    expect(run(["Davor {{visual:nope}} danach"]).text).toBe("Davor  danach");
  });

  // The live case: the model drafts the answer, placeholder included, in the
  // same reply that requests the visual — before it exists.
  test("holds text at an early placeholder and places the visual on retry", () => {
    const visuals = new Map<string, string>();
    const expander = createPlaceholderExpander((id) => visuals.get(id));

    expect(expander.push("Erklärung.\n\n{{visual:v1}}\n\nWeiter")).toBe(
      "Erklärung.\n\n",
    );
    expect(expander.push(" im Text.")).toBe(""); // still held
    expect(expander.retry()).toBe(""); // tool not done yet

    visuals.set("v1", "![Grafik](/api/ai/images/img-1)");
    const released = expander.retry();
    expect(released).toBe(
      "\n\n![Grafik](/api/ai/images/img-1)\n\n\n\nWeiter im Text.",
    );
    expect([...expander.used()]).toEqual(["v1"]);
  });

  // LaTeX like \frac{{a}}{b} or a template example must not be swallowed.
  test("lets text with an unclosed {{ flow on", () => {
    const long = `x{{${"y".repeat(80)}`;
    expect(run([long]).text).toBe(long);
    expect(run(["Ende {{"]).text).toBe("Ende {{");
  });

  test("passes plain text straight through", () => {
    const expander = createPlaceholderExpander(resolve);
    expect(expander.push("Hallo Welt.")).toBe("Hallo Welt.");
    expect(expander.flush()).toBe("");
  });
});
