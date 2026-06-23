import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseBibTool } from "./index.js";

test("chooseBibTool: a .bcf file means biblatex+biber -> biber", () => {
  assert.equal(chooseBibTool({ bcfExists: true, auxText: null }), "biber");
});

test("chooseBibTool: .bcf wins even when an .aux with citations is present", () => {
  // biblatex writes both a .bcf and \citation lines in .aux; the backend is
  // still biber, so we must not be fooled into running bibtex.
  const aux = "\\citation{smith2020}\n\\abx@aux@cite{0}{smith2020}\n";
  assert.equal(chooseBibTool({ bcfExists: true, auxText: aux }), "biber");
});

test("chooseBibTool: classic bibtex .aux (\\bibdata) -> bibtex", () => {
  const aux = "\\citation{smith2020}\n\\bibstyle{plain}\n\\bibdata{library}\n";
  assert.equal(chooseBibTool({ bcfExists: false, auxText: aux }), "bibtex");
});

test("chooseBibTool: .aux with only a \\citation still -> bibtex", () => {
  assert.equal(
    chooseBibTool({ bcfExists: false, auxText: "\\citation{x}\n" }),
    "bibtex",
  );
});

test("chooseBibTool: no .bcf and a citation-free .aux -> none", () => {
  const aux = "\\relax\n\\@writefile{toc}{...}\n";
  assert.equal(chooseBibTool({ bcfExists: false, auxText: aux }), "none");
});

test("chooseBibTool: nothing emitted -> none", () => {
  assert.equal(chooseBibTool({ bcfExists: false, auxText: null }), "none");
});
