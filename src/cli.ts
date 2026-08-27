#!/usr/bin/env node
/** Command line interface: crawl, search, stats, demo. */

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { Crawler, type Fetcher } from "./crawler.js";
import { createDemoFetcher, DEMO_SEED } from "./demo-site.js";
import { SearchIndex } from "./index-store.js";
import { parseQuery } from "./query.js";

interface Flags {
  readonly positional: string[];
  readonly values: Map<string, string>;
  readonly switches: Set<string>;
}

export function parseArgs(argv: string[]): Flags {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next);
      i++;
    } else {
      switches.add(name);
    }
  }
  return { positional, values, switches };
}

function number(flags: Flags, name: string, fallback: number): number {
  const raw = flags.values.get(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} expects a number, got ${raw}`);
  return parsed;
}

const USAGE = `crawlrank — a polite crawler and a BM25 search index

  crawlrank crawl <url...> [--out index.json] [--max-pages 50] [--depth 3]
                           [--concurrency 4] [--delay 500] [--all-hosts]
                           [--ignore-robots]
  crawlrank search <query> [--index index.json] [--limit 10]
  crawlrank stats          [--index index.json]
  crawlrank demo           crawl a built-in fake site, offline

Query syntax: bare terms rank, +term requires, -term excludes, "quoted phrase"
must appear contiguously.`;

async function loadIndex(path: string): Promise<SearchIndex> {
  const raw = await readFile(path, "utf8");
  return SearchIndex.fromJSON(JSON.parse(raw));
}

function printHits(index: SearchIndex, query: string, limit: number): void {
  const hits = index.search(parseQuery(query), limit);
  if (hits.length === 0) {
    console.log(`no matches for ${JSON.stringify(query)} in ${index.size} documents`);
    return;
  }
  console.log(`${hits.length} result(s) for ${JSON.stringify(query)}:\n`);
  for (const [position, hit] of hits.entries()) {
    console.log(`${position + 1}. ${hit.title || hit.url}`);
    console.log(`   ${hit.url}`);
    console.log(`   score ${hit.score.toFixed(3)}`);
    if (hit.snippet) console.log(`   ${hit.snippet}`);
    console.log();
  }
}

/** Injected for tests, so a CLI crawl can run without touching the network. */
export interface MainDeps {
  readonly fetcher?: Fetcher;
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const flags = parseArgs(argv);
  const command = flags.positional[0];

  if (command === undefined || command === "help" || flags.switches.has("help")) {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command === "crawl") {
    const seeds = flags.positional.slice(1);
    if (seeds.length === 0) throw new Error("crawl needs at least one URL");
    const crawler = new Crawler({
      ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
      maxPages: number(flags, "max-pages", 50),
      maxDepth: number(flags, "depth", 3),
      concurrency: number(flags, "concurrency", 4),
      delayMs: number(flags, "delay", 500),
      sameHostOnly: !flags.switches.has("all-hosts"),
      obeyRobots: !flags.switches.has("ignore-robots"),
      onPage: (page) => console.log(`  [${page.depth}] ${page.url}`),
      onError: (url, error) => console.error(`  !  ${url}: ${error.message}`),
    });
    const { index, report } = await crawler.crawl(seeds);
    const out = flags.values.get("out") ?? "index.json";
    await writeFile(out, JSON.stringify(index.toJSON()));
    console.log(
      `\n${report.pages} page(s) indexed from ${report.requests} request(s) ` +
        `in ${(report.elapsedMs / 1000).toFixed(1)}s, ${report.errors} error(s)`,
    );
    console.log(
      `skipped: ${report.skipped.robots} by robots.txt, ${report.skipped.status} by status, ` +
        `${report.skipped.contentType} by content type, ${report.skipped.noindex} by noindex`,
    );
    console.log(`wrote ${out}`);
    return 0;
  }

  if (command === "search") {
    const query = flags.positional.slice(1).join(" ");
    if (query === "") throw new Error("search needs a query");
    const index = await loadIndex(flags.values.get("index") ?? "index.json");
    printHits(index, query, number(flags, "limit", 10));
    return 0;
  }

  if (command === "stats") {
    const index = await loadIndex(flags.values.get("index") ?? "index.json");
    console.log(`documents      ${index.size}`);
    console.log(`vocabulary     ${index.vocabularySize}`);
    console.log(`avg length     ${index.averageLength.toFixed(1)} tokens`);
    console.log(`bm25           k1=${index.params.k1} b=${index.params.b} title=${index.params.titleBoost}x`);
    return 0;
  }

  if (command === "demo") {
    const { fetcher, log } = createDemoFetcher();
    const crawler = new Crawler({
      fetcher,
      delayMs: 0,
      concurrency: 2,
      maxPages: 20,
      onPage: (page) => console.log(`  [${page.depth}] ${page.url}  ${page.title}`),
    });
    console.log(`crawling the built-in demo site at ${DEMO_SEED}\n`);
    const { index, report } = await crawler.crawl([DEMO_SEED]);
    console.log(
      `\n${report.pages} indexed, ${log.length} request(s), ` +
        `${report.skipped.robots} blocked by robots.txt, ${report.skipped.noindex} noindex\n`,
    );
    for (const query of ['cold brew', 'beans -decaf', '"small batches"']) {
      printHits(index, query, 3);
    }
    return 0;
  }

  throw new Error(`unknown command ${command}. Run "crawlrank help" for usage.`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: Error) => {
      console.error(`error: ${error.message}`);
      process.exit(1);
    });
}
