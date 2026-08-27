/**
 * A robots.txt parser and matcher.
 *
 * Follows the rules that matter in practice and are now written down in
 * RFC 9309: group records by user-agent, pick the most specific agent group,
 * support `*` and `$` in paths, and let the longest matching rule win with
 * Allow breaking a tie. Crawl-delay is not in the RFC but is widely used and
 * is honoured here.
 */

export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
  readonly regex: RegExp;
  /** Rule specificity: longer patterns beat shorter ones. */
  readonly length: number;
}

export interface RobotsGroup {
  readonly agents: string[];
  readonly rules: RobotsRule[];
  crawlDelay?: number;
}

export interface Robots {
  readonly groups: RobotsGroup[];
  readonly sitemaps: string[];
}

function compile(pattern: string, allow: boolean): RobotsRule | null {
  if (pattern === "") return null;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return {
    allow,
    pattern,
    regex: new RegExp("^" + escaped + (anchored ? "$" : "")),
    length: body.length,
  };
}

export function parseRobots(text: string): Robots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let expectingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      // Consecutive User-agent lines share one group of rules.
      if (!current || !expectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      expectingAgents = true;
      continue;
    }
    if (field === "sitemap") {
      sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    expectingAgents = false;

    if (field === "allow" || field === "disallow") {
      if (field === "disallow" && value === "") continue; // "Disallow:" means allow all
      const rule = compile(value, field === "allow");
      if (rule) current.rules.push(rule);
    } else if (field === "crawl-delay") {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
    }
  }
  return { groups, sitemaps };
}

/** The group that applies to `agent`: an exact match if present, else `*`. */
export function groupFor(robots: Robots, agent: string): RobotsGroup | null {
  const wanted = agent.toLowerCase();
  let wildcard: RobotsGroup | null = null;
  let best: RobotsGroup | null = null;
  let bestLength = -1;

  for (const group of robots.groups) {
    for (const candidate of group.agents) {
      if (candidate === "*") {
        wildcard ??= group;
      } else if (wanted.includes(candidate) && candidate.length > bestLength) {
        best = group;
        bestLength = candidate.length;
      }
    }
  }
  return best ?? wildcard;
}

export function isAllowed(robots: Robots, agent: string, path: string): boolean {
  const group = groupFor(robots, agent);
  if (!group) return true;

  let winner: RobotsRule | null = null;
  for (const rule of group.rules) {
    if (!rule.regex.test(path)) continue;
    if (
      !winner ||
      rule.length > winner.length ||
      // A tie between Allow and Disallow is resolved in favour of Allow.
      (rule.length === winner.length && rule.allow && !winner.allow)
    ) {
      winner = rule;
    }
  }
  return winner ? winner.allow : true;
}

export function crawlDelayFor(robots: Robots, agent: string): number | undefined {
  return groupFor(robots, agent)?.crawlDelay;
}

/** What to assume when robots.txt cannot be fetched: allow everything. */
export const PERMISSIVE: Robots = { groups: [], sitemaps: [] };
