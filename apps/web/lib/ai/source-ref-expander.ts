/**
 * Turns short source references like "[Q1, S. 12]" in a text stream into
 * the full clickable links the UI renders as source chips.
 *
 * The institute model is given a short handle per source ("Q1") instead of
 * a ready-made link, because it did not copy the long links reliably: after
 * reading a few pages it abbreviated them to "[Annex 1, S. 12]" — plain,
 * unclickable, and ambiguous between two annexes. A three-character handle
 * survives; the link is rebuilt here, deterministically.
 *
 * Streaming-safe like placeholder-expander.ts: a reference split across
 * deltas is held back until its closing "]" arrives or it clearly isn't one.
 */

// "[Q1, S. 12]", "[Q1, S.12]", "[Q1 S. 12]", "[Q1, p. 12]", "[Q1, Seite 12]",
// several pages ("[Q1, S. 13, 14]", "[Q1, S. 13–15]", "[Q1, S. 3 und 7]" —
// seen live), and "[Q1]" for the source as a whole.
export const SOURCE_REF =
  /\[\s*(Q\d+)\s*(?:,?\s*(?:S\.|p\.|pp\.|Seiten?|pages?)\s*(\d+(?:\s*(?:,|–|-|und|and|&)\s*\d+)*))?\s*\]/i;
const REF = new RegExp(`^${SOURCE_REF.source}$`, "i");

/** "13, 14" → first page 13 (the link target) plus the text for the label. */
export function parsePages(spec: string | undefined): {
  page: number | null;
  pages: string | undefined;
} {
  if (!spec) return { page: null, pages: undefined };
  return {
    page: Number(spec.match(/\d+/)?.[0]),
    pages: spec.replace(/\s+/g, " ").trim(),
  };
}

// "[Q12, Seiten 123, 125 und 130]" is about 30 characters. Anything far
// longer that starts with "[" is ordinary text (a markdown link, a remark).
const MAX_PENDING = 40;

export function createSourceRefExpander(
  resolve: (
    handle: string,
    page: number | null,
    pages: string | undefined,
  ) => string | undefined,
) {
  let pending = "";

  const drain = (final: boolean): string => {
    let out = "";
    for (;;) {
      const open = pending.indexOf("[");
      if (open < 0) {
        out += pending;
        pending = "";
        return out;
      }
      out += pending.slice(0, open);
      pending = pending.slice(open);
      const close = pending.indexOf("]");
      // "]" as the very last character: the "(" that would make this link
      // text may be in the next delta. Decide once it's there.
      if (close === pending.length - 1 && !final) return out;
      if (close >= 0) {
        const token = pending.slice(0, close + 1);
        const match = token.match(REF);
        // A markdown link "[text](url)" is not a reference, even if its
        // text happened to look like one.
        const isLinkText = pending[close + 1] === "(";
        const { page, pages } = parsePages(match?.[2]);
        const link =
          match && !isLinkText
            ? resolve(match[1].toUpperCase(), page, pages)
            : undefined;
        out += link ?? token;
        pending = pending.slice(close + 1);
        continue;
      }
      if (final || pending.length > MAX_PENDING) {
        out += pending.slice(0, 1);
        pending = pending.slice(1);
        continue;
      }
      return out;
    }
  };

  return {
    push(text: string): string {
      pending += text;
      return drain(false);
    },
    flush(): string {
      return drain(true);
    },
  };
}
