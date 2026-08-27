/**
 * The Porter stemming algorithm (Porter, 1980).
 *
 * Stemming exists so that "connects", "connecting" and "connection" land on
 * one posting list. The algorithm is a cascade of suffix rewrites, each guarded
 * by a measure `m`: the number of vowel-consonant alternations left in the
 * stem. That guard is what stops it turning short words into nonsense.
 */

const VOWELS = new Set(["a", "e", "i", "o", "u"]);

function isConsonant(word: string, i: number): boolean {
  const ch = word[i];
  if (ch === undefined) return false;
  if (VOWELS.has(ch)) return false;
  // "y" is a vowel when the letter before it is a consonant: "sky" vs "yard".
  if (ch === "y") return i === 0 ? true : !isConsonant(word, i - 1);
  return true;
}

/** Number of vowel-consonant sequences in `word`. */
function measure(word: string): number {
  let m = 0;
  let i = 0;
  while (i < word.length && isConsonant(word, i)) i++;
  while (i < word.length) {
    while (i < word.length && !isConsonant(word, i)) i++;
    if (i >= word.length) break;
    m++;
    while (i < word.length && isConsonant(word, i)) i++;
  }
  return m;
}

function hasVowel(word: string): boolean {
  for (let i = 0; i < word.length; i++) if (!isConsonant(word, i)) return true;
  return false;
}

function endsDoubleConsonant(word: string): boolean {
  const n = word.length;
  return n >= 2 && word[n - 1] === word[n - 2] && isConsonant(word, n - 1);
}

/** consonant-vowel-consonant where the last letter is not w, x or y. */
function endsCVC(word: string): boolean {
  const n = word.length;
  if (n < 3) return false;
  if (!isConsonant(word, n - 1) || isConsonant(word, n - 2) || !isConsonant(word, n - 3)) {
    return false;
  }
  const last = word[n - 1]!;
  return last !== "w" && last !== "x" && last !== "y";
}

function replaceIf(word: string, suffix: string, replacement: string, minMeasure: number): string | null {
  if (!word.endsWith(suffix)) return null;
  const stem = word.slice(0, word.length - suffix.length);
  return measure(stem) > minMeasure ? stem + replacement : word;
}

const STEP2: [string, string][] = [
  ["ational", "ate"], ["tional", "tion"], ["enci", "ence"], ["anci", "ance"],
  ["izer", "ize"], ["abli", "able"], ["alli", "al"], ["entli", "ent"],
  ["eli", "e"], ["ousli", "ous"], ["ization", "ize"], ["ation", "ate"],
  ["ator", "ate"], ["alism", "al"], ["iveness", "ive"], ["fulness", "ful"],
  ["ousness", "ous"], ["aliti", "al"], ["iviti", "ive"], ["biliti", "ble"],
];

const STEP3: [string, string][] = [
  ["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"],
  ["ical", "ic"], ["ful", ""], ["ness", ""],
];

/**
 * Step 4 suffixes, longest first: "ement" must be tried before "ment", which
 * must be tried before "ent", or "replacement" stems as "replac" + "ent".
 */
const STEP4 = [
  "ement", "ance", "ence", "able", "ible", "ment", "ant", "ent", "ism",
  "ate", "iti", "ous", "ive", "ize", "al", "er", "ic", "ou",
].sort((a, b) => b.length - a.length);

export function stem(input: string): string {
  let word = input.toLowerCase();
  if (word.length <= 2) return word;

  // Step 1a — plurals.
  if (word.endsWith("sses")) word = word.slice(0, -2);
  else if (word.endsWith("ies")) word = word.slice(0, -2);
  else if (word.endsWith("ss")) {
    // keep
  } else if (word.endsWith("s")) word = word.slice(0, -1);

  // Step 1b — past tense and gerunds.
  let step1bApplied = false;
  if (word.endsWith("eed")) {
    if (measure(word.slice(0, -3)) > 0) word = word.slice(0, -1);
  } else if (word.endsWith("ed") && hasVowel(word.slice(0, -2))) {
    word = word.slice(0, -2);
    step1bApplied = true;
  } else if (word.endsWith("ing") && hasVowel(word.slice(0, -3))) {
    word = word.slice(0, -3);
    step1bApplied = true;
  }
  if (step1bApplied) {
    if (word.endsWith("at") || word.endsWith("bl") || word.endsWith("iz")) {
      word += "e";
    } else if (endsDoubleConsonant(word) && !/[lsz]$/.test(word)) {
      word = word.slice(0, -1);
    } else if (measure(word) === 1 && endsCVC(word)) {
      word += "e";
    }
  }

  // Step 1c — terminal y becomes i when the stem has a vowel.
  if (word.endsWith("y") && hasVowel(word.slice(0, -1))) word = word.slice(0, -1) + "i";

  // Steps 2 and 3 — derivational suffixes, one rewrite each.
  for (const [suffix, replacement] of STEP2) {
    const next = replaceIf(word, suffix, replacement, 0);
    if (next !== null) {
      word = next;
      break;
    }
  }
  for (const [suffix, replacement] of STEP3) {
    const next = replaceIf(word, suffix, replacement, 0);
    if (next !== null) {
      word = next;
      break;
    }
  }

  // Step 4 — strip the suffix entirely when plenty of stem remains.
  if (word.endsWith("ion")) {
    const stemPart = word.slice(0, -3);
    if (measure(stemPart) > 1 && /[st]$/.test(stemPart)) word = stemPart;
  } else {
    const suffix = STEP4.find((candidate) => word.endsWith(candidate));
    if (suffix !== undefined) {
      const stemPart = word.slice(0, word.length - suffix.length);
      if (measure(stemPart) > 1) word = stemPart;
    }
  }

  // Step 5 — tidy up a trailing e and a doubled l.
  if (word.endsWith("e")) {
    const stemPart = word.slice(0, -1);
    const m = measure(stemPart);
    if (m > 1 || (m === 1 && !endsCVC(stemPart))) word = stemPart;
  }
  if (measure(word) > 1 && endsDoubleConsonant(word) && word.endsWith("l")) {
    word = word.slice(0, -1);
  }

  return word;
}

export { measure as porterMeasure };
