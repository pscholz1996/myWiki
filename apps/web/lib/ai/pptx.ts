import JSZip from "jszip";

/**
 * Minimal PPTX reader: slide text for indexing/search, one entry per slide
 * (a slide is this format's "page" — search hits, citations, and image
 * attribution all use slide numbers). Embedded media extraction lives in
 * images.ts; this module is text-only.
 */

export interface PptxSlide {
  slide: number;
  text: string;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/g, "&");
}

/**
 * Pulls the visible text runs (<a:t>) out of one slide's XML. Paragraph
 * boundaries (<a:p>) become newlines so headings/bullets don't fuse into
 * one long token soup.
 */
export function extractSlideText(xml: string): string {
  const paragraphs = xml.split(/<\/a:p>/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const runs = [...paragraph.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(
      (match) => decodeXmlEntities(match[1]),
    );
    const line = runs.join("").trim();
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

export async function extractPptxSlides(data: Uint8Array): Promise<PptxSlide[]> {
  const zip = await JSZip.loadAsync(data);
  const slideFiles = Object.keys(zip.files)
    .map((name) => {
      const match = name.match(/^ppt\/slides\/slide(\d+)\.xml$/);
      return match ? { name, slide: Number(match[1]) } : null;
    })
    .filter((entry): entry is { name: string; slide: number } => entry !== null)
    .sort((a, b) => a.slide - b.slide);

  if (slideFiles.length === 0) {
    throw new Error("No slides found — is this a valid .pptx file?");
  }

  const slides: PptxSlide[] = [];
  for (const { name, slide } of slideFiles) {
    const xml = await zip.files[name].async("string");
    slides.push({ slide, text: extractSlideText(xml) });
  }
  return slides;
}

/** The PPTX core-properties title, when the author set one. */
export async function extractPptxTitle(
  data: Uint8Array,
): Promise<string | undefined> {
  const zip = await JSZip.loadAsync(data);
  const core = zip.files["docProps/core.xml"];
  if (!core) return undefined;
  const xml = await core.async("string");
  const match = xml.match(/<dc:title>([\s\S]*?)<\/dc:title>/);
  const title = match ? decodeXmlEntities(match[1]).trim() : "";
  return title || undefined;
}
