import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main, parseArgs } from "../src/cli.js";
import { createDemoFetcher, DEMO_SEED } from "../src/demo-site.js";
import { parseQuery } from "../src/query.js";
import { SearchIndex } from "../src/index-store.js";

function captureOutput() {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  return { lines, restore: () => log.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseArgs", () => {
  it("separates positionals, values and switches", () => {
    const flags = parseArgs(["crawl", "https://a.example/", "--depth", "2", "--all-hosts"]);
    expect(flags.positional).toEqual(["crawl", "https://a.example/"]);
    expect(flags.values.get("depth")).toBe("2");
    expect(flags.switches.has("all-hosts")).toBe(true);
  });

  it("treats a flag followed by another flag as a switch", () => {
    const flags = parseArgs(["--ignore-robots", "--out", "x.json"]);
    expect(flags.switches.has("ignore-robots")).toBe(true);
    expect(flags.values.get("out")).toBe("x.json");
  });
});

describe("main", () => {
  it("prints usage and fails when given no command", async () => {
    const output = captureOutput();
    expect(await main([])).toBe(1);
    expect(output.lines.join("\n")).toContain("crawlrank crawl");
  });

  it("prints usage and succeeds for help", async () => {
    captureOutput();
    expect(await main(["help"])).toBe(0);
  });

  it("rejects an unknown command", async () => {
    await expect(main(["frobnicate"])).rejects.toThrow(/unknown command/);
  });

  it("rejects a non-numeric flag value", async () => {
    await expect(main(["crawl", "https://a.example/", "--depth", "deep"])).rejects.toThrow(
      /expects a number/,
    );
  });

  it("requires arguments for crawl and search", async () => {
    await expect(main(["crawl"])).rejects.toThrow(/at least one URL/);
    await expect(main(["search"])).rejects.toThrow(/needs a query/);
  });

  it("runs the offline demo end to end", async () => {
    const output = captureOutput();
    expect(await main(["demo"])).toBe(0);
    const text = output.lines.join("\n");
    expect(text).toContain("https://roast.example/brewing");
    expect(text).toContain("3 indexed");
    expect(text).toContain("result(s) for");
  });

  it("searches and reports stats from an index file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crawlrank-"));
    const path = join(dir, "index.json");
    const index = new SearchIndex();
    index.addDocument("https://a.example/1", "Coffee brewing", "cold brew takes twelve hours");
    await writeFile(path, JSON.stringify(index.toJSON()));

    const search = captureOutput();
    expect(await main(["search", "cold", "brew", "--index", path])).toBe(0);
    expect(search.lines.join("\n")).toContain("https://a.example/1");
    search.restore();

    const stats = captureOutput();
    expect(await main(["stats", "--index", path])).toBe(0);
    expect(stats.lines.join("\n")).toContain("documents      1");
  });

  it("says so when nothing matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crawlrank-"));
    const path = join(dir, "index.json");
    await writeFile(path, JSON.stringify(new SearchIndex().toJSON()));
    const output = captureOutput();
    await main(["search", "anything", "--index", path]);
    expect(output.lines.join("\n")).toContain("no matches");
  });

  it("crawls and writes a loadable index file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crawlrank-"));
    const out = join(dir, "out.json");
    const { fetcher } = createDemoFetcher();
    captureOutput();
    expect(
      await main(["crawl", DEMO_SEED, "--out", out, "--delay", "0"], { fetcher }),
    ).toBe(0);

    const written = SearchIndex.fromJSON(JSON.parse(await readFile(out, "utf8")));
    expect(written.size).toBe(3);
    expect(written.search(parseQuery("cold brew"))[0]?.url).toBe("https://roast.example/brewing");
  });
});
