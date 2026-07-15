// Looks up a source's real bibliographic record from CrossRef instead of
// guessing harder at PDF layout — a match is a publisher-submitted database
// record, not an extraction, which is the strongest answer available to
// "don't present a guess as fact" for anything that's actually been
// published. Best-effort and non-blocking: any failure (network, timeout,
// no match, low-confidence match) just returns undefined so the caller
// falls back to whatever it already had.

const CROSSREF_API = "https://api.crossref.org/works";
// CrossRef's bibliographic search can genuinely take 15-20s for a longer,
// specific query (confirmed live) — generous on purpose, since this runs
// during upload where the SSE progress bar already shows a "verifying"
// status, so the wait isn't silent even when it's this long.
const CROSSREF_TIMEOUT_MS = 25000;

// Below this, a "match" is more likely a coincidentally-similar but wrong
// paper than the real one — reject rather than risk attaching someone
// else's authors/year to this source. Deliberately conservative: a missed
// match falls back to the heuristic path (still recoverable by the user),
// but a wrong match silently posing as verified data would not be.
const MIN_TITLE_SIMILARITY = 0.7;

export interface CrossrefMetadata {
  title: string;
  authors: string[];
  year?: string;
  doi?: string;
}

function normalizeForComparison(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

// Jaccard similarity over word sets — simple, dependency-free, and
// insensitive to punctuation/case differences between how a title was
// extracted locally and how it's recorded in CrossRef.
export function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeForComparison(a));
  const wordsB = new Set(normalizeForComparison(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection += 1;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function extractCrossrefYear(item: Record<string, unknown>): string | undefined {
  const dateFields = ["published", "published-print", "published-online", "issued"];
  for (const field of dateFields) {
    const container = item[field] as { "date-parts"?: unknown } | undefined;
    const dateParts = container?.["date-parts"];
    const first = Array.isArray(dateParts) ? dateParts[0] : undefined;
    const year = Array.isArray(first) ? first[0] : undefined;
    if (typeof year === "number") return String(year);
  }
  return undefined;
}

export async function lookupCrossrefMetadata(
  title: string,
): Promise<CrossrefMetadata | undefined> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return undefined;

  const url = `${CROSSREF_API}?query.bibliographic=${encodeURIComponent(trimmedTitle)}&rows=3`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CROSSREF_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        // CrossRef's "polite pool" gets faster/more reliable rate limits
        // for requests with a descriptive User-Agent; requests without one
        // still work, just via the lower-priority public pool.
        "User-Agent": "OpenLatex/0.1 (+https://github.com/xTazah/OpenLatex)",
      },
      signal: controller.signal,
    });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) return undefined;

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return undefined;
  }

  const items = (data as { message?: { items?: unknown } })?.message?.items;
  if (!Array.isArray(items) || items.length === 0) return undefined;

  // CrossRef's own relevance ranking doesn't always put the real match
  // first (confirmed live) — score every returned candidate and take the
  // best-matching one, not just whichever it ranked #1.
  let best: Record<string, unknown> | undefined;
  let bestTitle = "";
  let bestSimilarity = 0;
  for (const rawItem of items) {
    const item = rawItem as Record<string, unknown>;
    const candidateTitle = Array.isArray(item.title) ? item.title[0] : undefined;
    if (typeof candidateTitle !== "string" || !candidateTitle.trim()) continue;
    const similarity = titleSimilarity(trimmedTitle, candidateTitle);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestTitle = candidateTitle;
      best = item;
    }
  }

  if (!best || bestSimilarity < MIN_TITLE_SIMILARITY) return undefined;

  const rawAuthors = Array.isArray(best.author) ? best.author : [];
  const authors = rawAuthors
    .map((author) => {
      const a = author as { given?: unknown; family?: unknown };
      return [a.given, a.family]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join(" ")
        .trim();
    })
    .filter((name) => name.length > 0);

  return {
    title: bestTitle.trim(),
    authors,
    year: extractCrossrefYear(best),
    doi: typeof best.DOI === "string" ? best.DOI : undefined,
  };
}

/**
 * Publisher PDFs (Elsevier especially) often carry the DOI — sometimes AS
 * the Title field. A DOI is an exact key, so when one is present, resolving
 * it beats any fuzzy bibliographic search: /works/{doi} either returns the
 * one true record or 404s.
 */
export function extractDoi(text: string): string | undefined {
  const match = text.match(/\b(10\.\d{4,9}\/[^\s"'<>]+)/);
  return match ? match[1].replace(/[).,;]+$/, "") : undefined;
}

export async function lookupCrossrefByDoi(
  doi: string,
): Promise<CrossrefMetadata | undefined> {
  const url = `${CROSSREF_API}/${encodeURIComponent(doi)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CROSSREF_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "OpenLatex/0.1 (+https://github.com/xTazah/OpenLatex)",
      },
      signal: controller.signal,
    });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) return undefined;

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return undefined;
  }

  const item = (data as { message?: Record<string, unknown> })?.message;
  const title = Array.isArray(item?.title) ? item.title[0] : undefined;
  if (!item || typeof title !== "string" || !title.trim()) return undefined;

  const rawAuthors = Array.isArray(item.author) ? item.author : [];
  const authors = rawAuthors
    .map((author) => {
      const a = author as { given?: unknown; family?: unknown };
      return [a.given, a.family]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join(" ")
        .trim();
    })
    .filter((name) => name.length > 0);

  return {
    title: title.trim(),
    authors,
    year: extractCrossrefYear(item),
    doi: typeof item.DOI === "string" ? item.DOI : doi,
  };
}
