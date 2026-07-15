// Hand-rolled lexical (keyword) search — BM25 over chunk text, fused with
// semantic search via Reciprocal Rank Fusion. Matches this codebase's
// established convention of small, unit-tested, hand-rolled algorithms
// (chunkText, dotProduct, applyExactReplace) over pulling in a search
// library for something this self-contained.
//
// Semantic (embedding) search is good at "what is this about" but weak on
// exact tokens it was never trained to weight specially — acronyms, author
// surnames, model/product names, equation variable names. BM25 is the
// opposite: it's just term frequency, so it's strong on exact-token recall
// and indifferent to meaning. Fusing both catches what either would miss
// alone, which matters for evidence-based work where a query like "Chen
// 2023 transformer" or "MBSE" needs to find the chunk that literally
// contains those tokens even if the surrounding prose doesn't paraphrase
// well into embedding space.

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with",
  "this",
  "these",
  "those",
  "but",
  "or",
  "not",
  "can",
  "which",
  "their",
  "have",
  "had",
  "been",
  "we",
  "our",
  "you",
]);

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

export interface Bm25Index {
  // term -> (docId -> term frequency in that doc)
  postings: Map<string, Map<string, number>>;
  docLength: Map<string, number>;
  avgDocLength: number;
  documentCount: number;
}

export function buildBm25Index(
  documents: Array<{ id: string; text: string }>,
): Bm25Index {
  const postings = new Map<string, Map<string, number>>();
  const docLength = new Map<string, number>();
  let totalLength = 0;

  for (const doc of documents) {
    const tokens = tokenize(doc.text);
    docLength.set(doc.id, tokens.length);
    totalLength += tokens.length;

    const termFreq = new Map<string, number>();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    }

    for (const [term, freq] of termFreq) {
      let docMap = postings.get(term);
      if (!docMap) {
        docMap = new Map();
        postings.set(term, docMap);
      }
      docMap.set(doc.id, freq);
    }
  }

  return {
    postings,
    docLength,
    avgDocLength: documents.length > 0 ? totalLength / documents.length : 0,
    documentCount: documents.length,
  };
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Okapi BM25. Returns a score per doc id that matched at least one query term — docs with a zero score are omitted, not included with 0. */
export function scoreBm25(
  index: Bm25Index,
  queryTokens: string[],
): Map<string, number> {
  const scores = new Map<string, number>();
  if (index.documentCount === 0 || queryTokens.length === 0) return scores;

  const uniqueTerms = new Set(queryTokens);

  for (const term of uniqueTerms) {
    const docMap = index.postings.get(term);
    if (!docMap) continue;

    // Standard Robertson-Sparck Jones IDF with a +1 floor so common terms
    // (present in most/all docs) still contribute a small positive weight
    // instead of going negative.
    const docFreq = docMap.size;
    const idf = Math.log(
      1 + (index.documentCount - docFreq + 0.5) / (docFreq + 0.5),
    );

    for (const [docId, termFreq] of docMap) {
      const length = index.docLength.get(docId) ?? 0;
      const lengthNorm =
        1 - BM25_B + BM25_B * (length / (index.avgDocLength || 1));
      const termScore =
        (termFreq * (BM25_K1 + 1)) / (termFreq + BM25_K1 * lengthNorm);
      scores.set(docId, (scores.get(docId) ?? 0) + idf * termScore);
    }
  }

  return scores;
}

const RRF_K = 60;

/**
 * Reciprocal Rank Fusion — combines multiple ranked lists into one, using
 * only rank position (score = sum of 1/(k + rank)) rather than raw scores.
 * Chosen over a weighted sum specifically because cosine similarity and
 * BM25 scores live on incomparable, corpus-size-dependent scales; RRF
 * sidesteps that entirely and needs no per-corpus tuning.
 */
export function reciprocalRankFusion(
  rankedLists: string[][],
  k = RRF_K,
): Map<string, number> {
  const fused = new Map<string, number>();

  for (const rankedList of rankedLists) {
    rankedList.forEach((id, rank) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }

  return fused;
}
