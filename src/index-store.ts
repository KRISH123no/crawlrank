/**
 * An inverted index with BM25 ranking.
 *
 * Each document is stored as one token stream: the title tokens first, then
 * the body. Recording where the title ends means title matches can be boosted
 * and phrase queries can span the title, without storing the title twice.
 */

import { isEmpty, type ParsedQuery } from "./query.js";
import { tokenize } from "./tokenize.js";

export interface IndexedDoc {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  /** Token count, used by BM25 to normalise for document length. */
  readonly length: number;
  /** Tokens before this position came from the title. */
  readonly titleLength: number;
  /** A prefix of the body text, kept so results can show a snippet. */
  readonly excerpt: string;
}

export interface Posting {
  readonly docId: number;
  /** Positions in the token stream, ascending. */
  readonly positions: number[];
}

export interface SearchHit {
  readonly url: string;
  readonly title: string;
  readonly score: number;
  readonly snippet: string;
}

export interface Bm25Params {
  /** Term-frequency saturation. Higher means repetition keeps counting. */
  readonly k1: number;
  /** Length normalisation, 0 to 1. */
  readonly b: number;
  /** How many times a title occurrence counts compared with a body one. */
  readonly titleBoost: number;
}

export const DEFAULT_BM25: Bm25Params = { k1: 1.2, b: 0.75, titleBoost: 3 };

const EXCERPT_CHARS = 400;

interface SerializedIndex {
  readonly version: 1;
  readonly params: Bm25Params;
  readonly docs: IndexedDoc[];
  readonly terms: [string, [number, number[]][]][];
}

export class SearchIndex {
  private readonly docs: IndexedDoc[] = [];
  private readonly postings = new Map<string, Map<number, number[]>>();
  private totalLength = 0;
  readonly params: Bm25Params;

  constructor(params: Partial<Bm25Params> = {}) {
    this.params = { ...DEFAULT_BM25, ...params };
  }

  get size(): number {
    return this.docs.length;
  }

  get vocabularySize(): number {
    return this.postings.size;
  }

  get averageLength(): number {
    return this.docs.length === 0 ? 0 : this.totalLength / this.docs.length;
  }

  /** Add a document. Re-adding the same URL replaces nothing; callers dedupe. */
  addDocument(url: string, title: string, text: string): number {
    const titleTokens = tokenize(title);
    const bodyTokens = tokenize(text);
    const stream = [...titleTokens, ...bodyTokens];
    const id = this.docs.length;

    for (let position = 0; position < stream.length; position++) {
      const term = stream[position]!;
      let byDoc = this.postings.get(term);
      if (!byDoc) {
        byDoc = new Map();
        this.postings.set(term, byDoc);
      }
      const positions = byDoc.get(id);
      if (positions) positions.push(position);
      else byDoc.set(id, [position]);
    }

    this.docs.push({
      id,
      url,
      title,
      length: stream.length,
      titleLength: titleTokens.length,
      excerpt: text.slice(0, EXCERPT_CHARS),
    });
    this.totalLength += stream.length;
    return id;
  }

  documentFrequency(term: string): number {
    return this.postings.get(term)?.size ?? 0;
  }

  postingsFor(term: string): Posting[] {
    const byDoc = this.postings.get(term);
    if (!byDoc) return [];
    return [...byDoc].map(([docId, positions]) => ({ docId, positions }));
  }

  /**
   * Robertson-Sparck Jones IDF, in the form that stays positive for terms
   * appearing in more than half the collection.
   */
  private idf(term: string): number {
    const df = this.documentFrequency(term);
    if (df === 0) return 0;
    return Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
  }

  search(query: ParsedQuery, limit = 10): SearchHit[] {
    if (this.docs.length === 0 || isEmpty(query)) return [];

    let candidates: Set<number> | null = null;
    for (const term of query.must) {
      candidates = intersect(candidates, new Set(this.postings.get(term)?.keys() ?? []));
    }
    for (const phrase of query.phrases) {
      candidates = intersect(candidates, this.phraseMatches(phrase));
    }
    if (candidates === null) {
      candidates = new Set<number>();
      for (const term of query.should) {
        for (const docId of this.postings.get(term)?.keys() ?? []) candidates.add(docId);
      }
    }
    for (const term of query.mustNot) {
      for (const docId of this.postings.get(term)?.keys() ?? []) candidates.delete(docId);
    }

    const { k1, b, titleBoost } = this.params;
    const avgdl = this.averageLength || 1;
    const hits: SearchHit[] = [];

    for (const docId of candidates) {
      const doc = this.docs[docId];
      if (!doc) continue;
      let score = 0;
      for (const term of query.should) {
        const positions = this.postings.get(term)?.get(docId);
        if (!positions) continue;
        const inTitle = positions.filter((p) => p < doc.titleLength).length;
        const weighted = positions.length + (titleBoost - 1) * inTitle;
        const denominator = weighted + k1 * (1 - b + (b * doc.length) / avgdl);
        score += this.idf(term) * ((weighted * (k1 + 1)) / denominator);
      }
      if (score <= 0 && query.should.length > 0) continue;
      hits.push({
        url: doc.url,
        title: doc.title,
        score,
        snippet: this.snippet(doc, query),
      });
    }

    hits.sort((a, b2) => b2.score - a.score || (a.url < b2.url ? -1 : 1));
    return hits.slice(0, limit);
  }

  /** Documents where the phrase terms appear at consecutive positions. */
  private phraseMatches(phrase: string[]): Set<number> {
    const result = new Set<number>();
    const first = phrase[0];
    if (first === undefined) return result;
    const firstPostings = this.postings.get(first);
    if (!firstPostings) return result;

    const rest = phrase.slice(1).map((term) => this.postings.get(term));
    if (rest.some((byDoc) => byDoc === undefined)) return result; // a term is absent everywhere

    for (const [docId, startPositions] of firstPostings) {
      const matches = startPositions.some((start) =>
        rest.every((byDoc, offset) => {
          const positions = byDoc?.get(docId);
          return positions !== undefined && binarySearch(positions, start + offset + 1);
        }),
      );
      if (matches) result.add(docId);
    }
    return result;
  }

  private snippet(doc: IndexedDoc, query: ParsedQuery): string {
    const words = [...query.should, ...query.must];
    const text = doc.excerpt;
    if (words.length === 0) return text.slice(0, 160);
    const lowered = text.toLowerCase();
    for (const term of words) {
      const at = lowered.indexOf(term.slice(0, Math.max(4, term.length - 2)));
      if (at === -1) continue;
      const from = Math.max(0, at - 60);
      return (from > 0 ? "…" : "") + text.slice(from, from + 160).trim() + (text.length > from + 160 ? "…" : "");
    }
    return text.slice(0, 160);
  }

  // --------------------------------------------------------------- persistence

  toJSON(): SerializedIndex {
    return {
      version: 1,
      params: this.params,
      docs: this.docs,
      terms: [...this.postings].map(([term, byDoc]) => [term, [...byDoc]] as [string, [number, number[]][]]),
    };
  }

  static fromJSON(raw: unknown): SearchIndex {
    const data = raw as SerializedIndex;
    if (!data || data.version !== 1) throw new Error("unsupported index format");
    const index = new SearchIndex(data.params);
    for (const doc of data.docs) {
      index.docs.push(doc);
      index.totalLength += doc.length;
    }
    for (const [term, byDoc] of data.terms) {
      index.postings.set(term, new Map(byDoc));
    }
    return index;
  }

  allDocuments(): readonly IndexedDoc[] {
    return this.docs;
  }
}

function intersect(current: Set<number> | null, next: Set<number>): Set<number> {
  if (current === null) return next;
  const out = new Set<number>();
  for (const value of current) if (next.has(value)) out.add(value);
  return out;
}

/** Positions are ascending, so membership is a binary search. */
function binarySearch(sorted: number[], target: number): boolean {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const value = sorted[mid]!;
    if (value === target) return true;
    if (value < target) low = mid + 1;
    else high = mid - 1;
  }
  return false;
}
