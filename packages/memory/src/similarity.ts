/**
 * Jaccard similarity over lowercased word-sets.
 */

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

export function jaccard(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;

  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Rough keyword score: what fraction of `query` tokens appear in `corpus`.
 * Tolerates empty query (returns 0).
 */
export function keywordScore(query: string, corpus: string): number {
  const Q = [...tokenize(query)];
  if (Q.length === 0) return 0;
  const C = tokenize(corpus);
  let hits = 0;
  for (const q of Q) if (C.has(q)) hits++;
  return hits / Q.length;
}
