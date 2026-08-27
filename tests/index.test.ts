import { describe, expect, it } from "vitest";

import { Frontier } from "../src/frontier.js";
import { SearchIndex } from "../src/index-store.js";
import { parseQuery } from "../src/query.js";

function corpus(): SearchIndex {
  const index = new SearchIndex();
  index.addDocument("https://a.example/1", "Coffee brewing", "Cold brew takes twelve hours to brew properly.");
  index.addDocument("https://a.example/2", "Bean varieties", "Ethiopian beans and a decaf blend of coffee beans.");
  index.addDocument("https://a.example/3", "Tea", "Tea is not coffee, though both are drinks.");
  return index;
}

describe("SearchIndex", () => {
  it("counts documents, vocabulary and average length", () => {
    const index = corpus();
    expect(index.size).toBe(3);
    expect(index.vocabularySize).toBeGreaterThan(5);
    expect(index.averageLength).toBeGreaterThan(0);
  });

  it("ranks a document whose title matches above one that only mentions the term", () => {
    const hits = corpus().search(parseQuery("coffee"));
    expect(hits[0]?.url).toBe("https://a.example/1");
  });

  it("gives a rarer term more weight than a common one", () => {
    const index = corpus();
    const common = index.documentFrequency("coffe");
    const rare = index.documentFrequency("ethiopian");
    expect(common).toBeGreaterThan(rare);
    const hits = index.search(parseQuery("ethiopian coffee"));
    expect(hits[0]?.url).toBe("https://a.example/2");
  });

  it("saturates term frequency instead of counting linearly", () => {
    const index = new SearchIndex();
    index.addDocument("https://a.example/once", "", "spam filler filler filler filler");
    index.addDocument("https://a.example/many", "", "spam spam spam spam spam");
    const [top, second] = index.search(parseQuery("spam"));
    expect(top?.url).toBe("https://a.example/many");
    // Five occurrences must not score five times one occurrence.
    expect(top!.score).toBeLessThan(second!.score * 5);
  });

  it("requires +terms and excludes -terms", () => {
    const index = corpus();
    expect(index.search(parseQuery("coffee -decaf")).map((hit) => hit.url)).not.toContain(
      "https://a.example/2",
    );
    const required = index.search(parseQuery("+ethiopian coffee"));
    expect(required).toHaveLength(1);
    expect(required[0]?.url).toBe("https://a.example/2");
  });

  it("matches a phrase only when the words are adjacent and in order", () => {
    const index = new SearchIndex();
    index.addDocument("https://a.example/yes", "", "we serve cold brew daily");
    index.addDocument("https://a.example/no", "", "brew it cold, never the other way");
    const hits = index.search(parseQuery('"cold brew"'));
    expect(hits.map((hit) => hit.url)).toEqual(["https://a.example/yes"]);
  });

  it("matches a phrase that starts in the title and continues into the body", () => {
    const index = new SearchIndex();
    index.addDocument("https://a.example/1", "Small batch", "roasting is our thing");
    const hits = index.search(parseQuery('"batch roasting"'));
    expect(hits).toHaveLength(1);
  });

  it("returns nothing for an empty or unknown query", () => {
    const index = corpus();
    expect(index.search(parseQuery(""))).toEqual([]);
    expect(index.search(parseQuery("zzzznotaword"))).toEqual([]);
    expect(new SearchIndex().search(parseQuery("anything"))).toEqual([]);
  });

  it("honours the result limit", () => {
    expect(corpus().search(parseQuery("coffee tea beans"), 2)).toHaveLength(2);
  });

  it("returns a snippet drawn from the document text", () => {
    const hit = corpus().search(parseQuery("ethiopian"))[0];
    expect(hit?.snippet).toContain("Ethiopian");
  });

  it("survives a JSON round trip with identical ranking", () => {
    const index = corpus();
    const before = index.search(parseQuery("coffee beans"));
    const after = SearchIndex.fromJSON(JSON.parse(JSON.stringify(index.toJSON())));
    expect(after.size).toBe(index.size);
    expect(after.vocabularySize).toBe(index.vocabularySize);
    expect(after.search(parseQuery("coffee beans"))).toEqual(before);
  });

  it("rejects an index written by a future version", () => {
    expect(() => SearchIndex.fromJSON({ version: 99 })).toThrow(/unsupported/);
  });

  it("takes BM25 parameters from the caller", () => {
    const index = new SearchIndex({ k1: 2, b: 0, titleBoost: 1 });
    expect(index.params).toEqual({ k1: 2, b: 0, titleBoost: 1 });
  });

  it("stops favouring long documents when b is 0", () => {
    const short = new SearchIndex({ b: 0 });
    short.addDocument("https://a.example/short", "", "coffee");
    short.addDocument("https://a.example/long", "", `coffee ${"filler ".repeat(50)}`);
    const [first, second] = short.search(parseQuery("coffee"));
    expect(first!.score).toBeCloseTo(second!.score, 10);
  });
});

describe("Frontier", () => {
  it("refuses duplicates and reports whether a URL was accepted", () => {
    const frontier = new Frontier();
    expect(frontier.add("https://a.example/1", 0)).toBe(true);
    expect(frontier.add("https://a.example/1", 0)).toBe(false);
    expect(frontier.size).toBe(1);
    expect(frontier.seenCount).toBe(1);
  });

  it("refuses URLs past the depth limit", () => {
    const frontier = new Frontier({ maxDepth: 1 });
    expect(frontier.add("https://a.example/deep", 2)).toBe(false);
    expect(frontier.add("https://a.example/ok", 1)).toBe(true);
  });

  it("refuses hosts outside the allow list", () => {
    const frontier = new Frontier({ allowedHosts: ["a.example"] });
    expect(frontier.add("https://b.example/1", 0)).toBe(false);
    expect(frontier.add("https://a.example/1", 0)).toBe(true);
  });

  it("rotates between hosts instead of draining one", () => {
    const frontier = new Frontier();
    frontier.add("https://a.example/1", 0);
    frontier.add("https://a.example/2", 0);
    frontier.add("https://b.example/1", 0);
    const order = [frontier.next(), frontier.next(), frontier.next()].map((entry) => entry?.url);
    expect(order).toEqual([
      "https://a.example/1",
      "https://b.example/1",
      "https://a.example/2",
    ]);
  });

  it("returns undefined when it is empty", () => {
    const frontier = new Frontier();
    expect(frontier.next()).toBeUndefined();
    frontier.add("https://a.example/1", 0);
    frontier.next();
    expect(frontier.next()).toBeUndefined();
  });
});
