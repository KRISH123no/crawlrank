/**
 * Query syntax, kept small on purpose:
 *
 *   coffee shop        both terms contribute to the score, neither is required
 *   +coffee shop       "coffee" must appear
 *   -decaf             documents containing "decaf" are dropped
 *   "cold brew"        the words must appear next to each other, in order
 *
 * Everything is run through the same tokenizer as the index, so a query for
 * "running" finds a document that said "runs".
 */

import { tokenize } from "./tokenize.js";

export interface ParsedQuery {
  /** Terms that contribute to the score. */
  readonly should: string[];
  /** Terms that every matching document must contain. */
  readonly must: string[];
  /** Terms that disqualify a document. */
  readonly mustNot: string[];
  /** Phrases as term sequences; each must appear contiguously. */
  readonly phrases: string[][];
}

const TOKEN = /"([^"]*)"|(\S+)/g;

export function parseQuery(input: string): ParsedQuery {
  const should: string[] = [];
  const must: string[] = [];
  const mustNot: string[] = [];
  const phrases: string[][] = [];

  for (const match of input.matchAll(TOKEN)) {
    const quoted = match[1];
    if (quoted !== undefined) {
      // Stop words are kept inside a phrase so positions stay contiguous.
      const terms = tokenize(quoted, { keepStopWords: true });
      if (terms.length > 1) {
        phrases.push(terms);
        should.push(...terms.filter((t) => tokenize(t).length > 0));
      } else if (terms.length === 1) {
        must.push(terms[0]!);
        should.push(terms[0]!);
      }
      continue;
    }
    const word = match[2];
    if (!word) continue;
    const negated = word.startsWith("-");
    const required = word.startsWith("+");
    const terms = tokenize(negated || required ? word.slice(1) : word);
    if (terms.length === 0) continue;
    if (negated) {
      mustNot.push(...terms);
    } else if (required) {
      must.push(...terms);
      should.push(...terms);
    } else {
      should.push(...terms);
    }
  }
  return { should: dedupe(should), must: dedupe(must), mustNot: dedupe(mustNot), phrases };
}

function dedupe(terms: string[]): string[] {
  return [...new Set(terms)];
}

export function isEmpty(query: ParsedQuery): boolean {
  return query.should.length === 0 && query.must.length === 0 && query.phrases.length === 0;
}
