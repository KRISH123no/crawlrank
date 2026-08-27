/**
 * The URL frontier.
 *
 * Two jobs: never queue the same page twice, and hand work out in host
 * round-robin order. Without the rotation, a breadth-first crawl of one site
 * would hand every worker a URL on the same host, and the politeness delay
 * would then serialise all of them behind each other.
 */

export interface FrontierEntry {
  readonly url: string;
  readonly depth: number;
}

export interface FrontierOptions {
  readonly maxDepth?: number;
  /** Only accept URLs on one of these hosts. Empty means no restriction. */
  readonly allowedHosts?: Iterable<string>;
}

import { hostOf } from "./url.js";

export class Frontier {
  private readonly queues = new Map<string, FrontierEntry[]>();
  private readonly hosts: string[] = [];
  private cursor = 0;
  private readonly seen = new Set<string>();
  private readonly allowed: Set<string>;
  private pending = 0;
  readonly maxDepth: number;

  constructor(options: FrontierOptions = {}) {
    this.maxDepth = options.maxDepth ?? 3;
    this.allowed = new Set(options.allowedHosts ?? []);
  }

  get size(): number {
    return this.pending;
  }

  get seenCount(): number {
    return this.seen.size;
  }

  has(url: string): boolean {
    return this.seen.has(url);
  }

  /** Returns false when the URL was a duplicate, too deep, or off-limits. */
  add(url: string, depth: number): boolean {
    if (depth > this.maxDepth) return false;
    if (this.seen.has(url)) return false;
    const host = hostOf(url);
    if (host === "") return false;
    if (this.allowed.size > 0 && !this.allowed.has(host)) return false;

    this.seen.add(url);
    let queue = this.queues.get(host);
    if (!queue) {
      queue = [];
      this.queues.set(host, queue);
      this.hosts.push(host);
    }
    queue.push({ url, depth });
    this.pending++;
    return true;
  }

  /** Next URL, rotating hosts so no single host monopolises the workers. */
  next(): FrontierEntry | undefined {
    for (let attempts = 0; attempts < this.hosts.length; attempts++) {
      const host = this.hosts[this.cursor % this.hosts.length]!;
      this.cursor++;
      const queue = this.queues.get(host);
      const entry = queue?.shift();
      if (entry) {
        this.pending--;
        return entry;
      }
    }
    return undefined;
  }
}
