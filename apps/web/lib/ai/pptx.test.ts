import { describe, expect, test } from "vitest";
import JSZip from "jszip";
import { extractPptxSlides, extractPptxTitle, extractSlideText } from "./pptx";

function slideXml(paragraphs: string[][]): string {
  const body = paragraphs
    .map(
      (runs) =>
        `<a:p>${runs.map((run) => `<a:r><a:t>${run}</a:t></a:r>`).join("")}</a:p>`,
    )
    .join("");
  return `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:txBody>${body}</p:txBody></p:sld>`;
}

async function buildPptx(
  slides: string[][][],
  title?: string,
): Promise<Uint8Array> {
  const zip = new JSZip();
  slides.forEach((paragraphs, index) => {
    zip.file(`ppt/slides/slide${index + 1}.xml`, slideXml(paragraphs));
  });
  if (title) {
    zip.file(
      "docProps/core.xml",
      `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`,
    );
  }
  return zip.generateAsync({ type: "uint8array" });
}

describe("extractSlideText", () => {
  test("joins runs within a paragraph and newlines between paragraphs", () => {
    const xml = slideXml([
      ["V-Modell ", "Übersicht"],
      ["Verifikation und Validierung"],
    ]);
    expect(extractSlideText(xml)).toBe(
      "V-Modell Übersicht\nVerifikation und Validierung",
    );
  });

  test("decodes XML entities", () => {
    const xml = slideXml([["Design &amp; Test &lt;V&gt;"]]);
    expect(extractSlideText(xml)).toBe("Design & Test <V>");
  });

  test("skips empty paragraphs", () => {
    const xml = slideXml([["Titel"], [""], ["Inhalt"]]);
    expect(extractSlideText(xml)).toBe("Titel\nInhalt");
  });
});

describe("extractPptxSlides", () => {
  test("returns slides in numeric order with their text", async () => {
    const data = await buildPptx([
      [["Slide eins"]],
      [["Slide zwei"], ["Details"]],
    ]);
    const slides = await extractPptxSlides(data);
    expect(slides).toEqual([
      { slide: 1, text: "Slide eins" },
      { slide: 2, text: "Slide zwei\nDetails" },
    ]);
  });

  test("orders slide10 after slide2 (numeric, not lexicographic)", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide2.xml", slideXml([["two"]]));
    zip.file("ppt/slides/slide10.xml", slideXml([["ten"]]));
    const data = await zip.generateAsync({ type: "uint8array" });
    const slides = await extractPptxSlides(data);
    expect(slides.map((s) => s.slide)).toEqual([2, 10]);
  });

  test("rejects a zip without slides", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "not a deck");
    const data = await zip.generateAsync({ type: "uint8array" });
    await expect(extractPptxSlides(data)).rejects.toThrow(/No slides found/);
  });
});

describe("extractPptxTitle", () => {
  test("reads dc:title from core properties", async () => {
    const data = await buildPptx([[["x"]]], "Systems Engineering Grundlagen");
    expect(await extractPptxTitle(data)).toBe("Systems Engineering Grundlagen");
  });

  test("returns undefined without core.xml", async () => {
    const data = await buildPptx([[["x"]]]);
    expect(await extractPptxTitle(data)).toBeUndefined();
  });
});
