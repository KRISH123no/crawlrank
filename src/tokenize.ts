/**
 * Text to terms: fold case, split on non-alphanumerics, drop stop words,
 * then stem. Indexing and querying must run the exact same pipeline, or a
 * query term will never match the posting it was meant to find.
 */

import { stem } from "./stem.js";

/** Words too common to discriminate between documents. */
export const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can",
  "do", "does", "for", "from", "had", "has", "have", "he", "her", "his",
  "how", "i", "if", "in", "into", "is", "it", "its", "not", "of", "on",
  "or", "our", "out", "she", "so", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "to", "was", "we", "were",
  "what", "when", "which", "who", "why", "will", "with", "would", "you",
  "your",
]);

export interface TokenizeOptions {
  /** Keep stop words. Useful when a phrase query needs exact positions. */
  readonly keepStopWords?: boolean;
  /** Skip stemming, for exact-match fields. */
  readonly noStem?: boolean;
}

const WORD = /[a-z0-9]+/g;

export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const out: string[] = [];
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const raw = match[0];
    if (raw.length < 2) continue; // single characters carry no signal
    if (!options.keepStopWords && STOP_WORDS.has(raw)) continue;
    // Numbers are indexed as they are; stemming them would be meaningless.
    out.push(options.noStem || /^\d+$/.test(raw) ? raw : stem(raw));
  }
  return out;
}
