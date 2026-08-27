import { describe, expect, it } from "vitest";

import { decodeEntities, extract } from "../src/html.js";
import { parseQuery } from "../src/query.js";
import { stem } from "../src/stem.js";
import { STOP_WORDS, tokenize } from "../src/tokenize.js";

/** Porter's own worked examples, from the 1980 paper. */
const PORTER_CASES: Record<string, string> = {
  caresses: "caress", ponies: "poni", ties: "ti", cats: "cat",
  feed: "feed", agreed: "agre", plastered: "plaster", bled: "bled",
  motoring: "motor", sing: "sing", conflated: "conflat", troubled: "troubl",
  sized: "size", hopping: "hop", tanned: "tan", falling: "fall",
  hissing: "hiss", fizzed: "fizz", failing: "fail", filing: "file",
  happy: "happi", sky: "sky", relational: "relat", conditional: "condit",
  rational: "ration", valenci: "valenc", digitizer: "digit",
  conformabli: "conform", radicalli: "radic", differentli: "differ",
  vileli: "vile", analogousli: "analog", vietnamization: "vietnam",
  predication: "predic", operator: "oper", feudalism: "feudal",
  decisiveness: "decis", hopefulness: "hope", callousness: "callous",
  formaliti: "formal", sensitiviti: "sensit", sensibiliti: "sensibl",
  triplicate: "triplic", formative: "form", formalize: "formal",
  electriciti: "electr", electrical: "electr", hopeful: "hope",
  goodness: "good", revival: "reviv", allowance: "allow",
  inference: "infer", airliner: "airlin", gyroscopic: "gyroscop",
  adjustable: "adjust", defensible: "defens", irritant: "irrit",
  replacement: "replac", adjustment: "adjust", dependent: "depend",
  communism: "commun", activate: "activ", angulariti: "angular",
  homologous: "homolog", effective: "effect", bowdlerize: "bowdler",
  probate: "probat", rate: "rate", cease: "ceas", controll: "control",
  roll: "roll",
};

describe("stem", () => {
  it.each(Object.entries(PORTER_CASES))("stems %s to %s", (word, expected) => {
    expect(stem(word)).toBe(expected);
  });

  it("collapses a word family onto one stem", () => {
    const stems = new Set(["connect", "connects", "connected", "connecting", "connection"].map(stem));
    expect(stems.size).toBe(1);
  });

  it("leaves very short words alone", () => {
    expect(stem("is")).toBe("is");
    expect(stem("go")).toBe("go");
  });
});

describe("tokenize", () => {
  it("folds case, drops punctuation and single characters", () => {
    expect(tokenize("Hello, World! A b c 42")).toEqual(["hello", "world", "42"]);
  });

  it("removes stop words by default and keeps them on request", () => {
    expect(tokenize("the cat and the hat")).toEqual(["cat", "hat"]);
    expect(tokenize("the cat", { keepStopWords: true })).toEqual(["the", "cat"]);
    expect(STOP_WORDS.has("the")).toBe(true);
  });

  it("does not stem numbers", () => {
    expect(tokenize("2026 releases")).toEqual(["2026", "releas"]);
  });

  it("runs the same pipeline for a document and a query", () => {
    expect(tokenize("running")).toEqual(tokenize("runs"));
  });
});

describe("decodeEntities", () => {
  it("handles named, decimal and hex references", () => {
    expect(decodeEntities("caf&eacute; &amp; bar")).toBe("café & bar");
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
  });

  it("leaves an unknown entity untouched", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
  });
});

describe("extract", () => {
  const html = `<html><head><title>Caf&eacute; &amp; Bar</title>
      <meta name="robots" content="noindex, nofollow"></head>
    <body>
      <script>var trap = '<a href="/script-link">no</a>';</script>
      <style>.a { color: red }</style>
      <h1>Heading</h1><p>First para.</p><p>Second para.</p>
      <a href="/about">About</a>
      <a href="https://elsewhere.example/page?utm_source=x#frag">Elsewhere</a>
      <a href="#top">Anchor</a>
      <a href="mailto:hi@example.com">Mail</a>
      <a rel="nofollow" href="/sponsored">Sponsored</a>
    </body></html>`;
  const page = extract(html, "https://site.example/blog/");

  it("reads the title and decodes it", () => {
    expect(page.title).toBe("Café & Bar");
  });

  it("keeps head and script content out of the body text", () => {
    expect(page.text).toContain("First para. Second para.");
    expect(page.text).not.toContain("trap");
    expect(page.text).not.toContain("color");
    expect(page.text).not.toContain("Café");
  });

  it("resolves, normalises and filters links", () => {
    expect(page.links).toEqual([
      "https://site.example/about",
      "https://elsewhere.example/page",
    ]);
  });

  it("reads robots meta directives", () => {
    expect(page.noIndex).toBe(true);
    expect(page.noFollow).toBe(true);
  });

  it("never throws on broken markup", () => {
    const broken = extract("<html><title>unclosed<body><p>text<a href=", "https://x.example/");
    expect(broken.text).toContain("text");
    expect(broken.links).toEqual([]);
  });
});

describe("parseQuery", () => {
  it("splits terms into should, must and mustNot", () => {
    const query = parseQuery("coffee +beans -decaf");
    expect(query.should).toContain("coffe");
    expect(query.must).toEqual(["bean"]);
    expect(query.mustNot).toEqual(["decaf"]);
  });

  it("keeps stop words inside a phrase so positions stay contiguous", () => {
    const query = parseQuery('"the cold brew"');
    expect(query.phrases).toEqual([["the", "cold", "brew"]]);
  });

  it("treats a one-word phrase as a required term", () => {
    expect(parseQuery('"coffee"').must).toEqual(["coffe"]);
  });

  it("ignores punctuation-only input", () => {
    expect(parseQuery("!!! ???").should).toEqual([]);
  });
});
