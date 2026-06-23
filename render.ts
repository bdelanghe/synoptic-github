// Pure render layer — no fetch, no fs, no process, no top-level await.
// synoptic.ts owns IO (fetch/env/read/write); everything here is a deterministic
// function of its inputs, so it is unit-testable in isolation (see render.test.ts).
import type { Corpus, Repo } from "./schema.ts";
import { languageSlug } from "./languages.ts";

// Lead with the strongest categories; experiments/games sink to the bottom.
export const TOPIC_PRIORITY = [
  "capability-security", "agent-infra", "ai", "developer-tools", "library", "cli",
  "infrastructure", "nix", "state-machines", "design-tokens", "data-viz", "web",
  "algorithms", "game", "learning", "experiment",
];
const pri = (t: string) => (TOPIC_PRIORITY.indexOf(t) === -1 ? 999 : TOPIC_PRIORITY.indexOf(t));

// One repo → one bullet: name (link) — description `Language`.
export const repoLine = (r: Repo): string =>
  `- [${r.name}](${r.url})` + (r.description ? ` — ${r.description}` : "") + (r.language ? ` \`${r.language}\`` : "");

// Language histogram, descending by count then name (stable, deterministic).
export const languageTally = (repos: Repo[]): [string, number][] =>
  Object.entries(
    repos.reduce<Record<string, number>>((m, r) => (r.language ? ((m[r.language] = (m[r.language] || 0) + 1), m) : m), {}),
  ).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

const NINETY_DAYS = 90 * 24 * 3600;

// Signal computed straight from the corpus (no external stat cards): total stars,
// recently-active count, and org-vs-personal split. Recency is measured against
// sourceEpoch — the commit time, never wall-clock — so re-runs stay byte-identical.
// Every segment is gated, so it drops out when it carries no signal.
export const statsLine = (owner: string, shown: Repo[], sourceEpoch: number): string => {
  const totalStars = shown.reduce((s, r) => s + r.stars, 0);
  const activeRecently = sourceEpoch
    ? shown.filter((r) => sourceEpoch - Math.floor(Date.parse(r.pushedAt) / 1000) <= NINETY_DAYS).length
    : 0;
  // Org contribution: count repos owned by someone other than the profile owner,
  // tallied per org so "12 @bounded-systems" reads as real org work, not solo toys.
  const orgCounts = Object.entries(
    shown.reduce<Record<string, number>>((m, r) => {
      const o = r.fullName.split("/")[0];
      if (o.toLowerCase() !== owner.toLowerCase()) m[o] = (m[o] || 0) + 1;
      return m;
    }, {}),
  ).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return [
    `\`${owner}\``,
    `${shown.length} public repositories`,
    ...orgCounts.map(([o, n]) => `${n} @${o}`),
    ...(totalStars > 0 ? [`${totalStars} stars`] : []),
    ...(activeRecently > 0 ? [`${activeRecently} active in 90d`] : []),
    ...languageTally(shown).slice(0, 4).map(([l, n]) => `${l} ${n}`),
  ].join(" · ");
};

// Profile sub-line: location · site · company · twitter, each linked where it makes sense.
export const linksLine = (c: Pick<Corpus, "location" | "blog" | "company" | "twitter">): string => {
  const blogHref = c.blog ? (c.blog.startsWith("http") ? c.blog : `https://${c.blog}`) : null;
  const ghUser = (h: string) => `[${h}](https://github.com/${h.replace(/^@/, "")})`;
  return [
    c.location,
    blogHref ? `[${blogHref.replace(/^https?:\/\//, "")}](${blogHref})` : null,
    c.company ? (c.company.startsWith("@") ? ghUser(c.company) : c.company) : null,
    c.twitter ? `[@${c.twitter}](https://x.com/${c.twitter})` : null,
  ].filter(Boolean).join(" · ");
};

// SOURCE_DATE_EPOCH → YYYY-MM-DD, or "" when unset (keeps output reproducible).
export const stampDate = (sourceEpoch: number): string =>
  sourceEpoch ? new Date(sourceEpoch * 1000).toISOString().slice(0, 10) : "";

// FILTER="topicA,topicB" → only repos carrying one of these topics. Empty = all.
export const filterRepos = (repos: Repo[], filter?: string[]): Repo[] =>
  filter && filter.length ? repos.filter((r) => r.topics.some((t) => filter.includes(t))) : repos;

export type RenderOptions = {
  groupBy?: string;            // "topic" | "language" | "none"
  filter?: string[];
  banner?: string | null;
  featured?: string[];
};

// The grouped repo blocks, shared by full-render and region-injection.
const groupBlocksFor = (rest: Repo[], groupBy: string, langs: [string, number][]): string[] => {
  const blocks: string[] = [];
  if (groupBy === "none") {
    blocks.push(rest.map(repoLine).join("\n"));
  } else if (groupBy === "language") {
    for (const [lang] of langs) {
      const inLang = rest.filter((r) => r.language === lang);
      if (inLang.length) blocks.push(`## [${lang}](https://github.com/trending/${languageSlug(lang)})\n\n${inLang.map(repoLine).join("\n")}`);
    }
  } else {
    const groups = new Map<string, Repo[]>();
    const other: Repo[] = [];
    for (const r of rest) (r.topics[0] ? (groups.get(r.topics[0]) ?? groups.set(r.topics[0], []).get(r.topics[0])!) : other).push(r);
    for (const [topic, rs] of [...groups].sort((a, b) => pri(a[0]) - pri(b[0]) || b[1].length - a[1].length || a[0].localeCompare(b[0])))
      blocks.push(`## ${topic}\n\n${rs.map(repoLine).join("\n")}`);
    if (other.length) blocks.push(`## other\n\n${other.map(repoLine).join("\n")}`);
  }
  return blocks;
};

// The corpus, reduced to the pieces every surface shares: the filtered set, its
// language tally, the curated Featured repos, the rest, and the grouped blocks.
const view = (corpus: Corpus, opts: RenderOptions) => {
  const shown = filterRepos(corpus.repos, opts.filter);
  const langs = languageTally(shown);
  const featured = (opts.featured ?? [])
    .map((n) => shown.find((r) => r.name === n))
    .filter((r): r is Repo => !!r);
  const featuredSet = new Set(featured.map((r) => r.name));
  const rest = shown.filter((r) => !featuredSet.has(r.name));
  const groupBlocks = groupBlocksFor(rest, opts.groupBy ?? "topic", langs);
  return { shown, langs, featured, rest, groupBlocks };
};

// Full README: banner → name → bio → links → stats → Featured → groups → stamp.
export const renderProfile = (corpus: Corpus, opts: RenderOptions): string => {
  const { shown, featured, groupBlocks } = view(corpus, opts);
  const stamp = stampDate(corpus.provenance.sourceEpoch);
  const links = linksLine(corpus);
  const md: string[] = [];
  if (opts.banner) {
    md.push(
      `<picture>\n` +
        `  <source media="(prefers-color-scheme: dark)" srcset="${opts.banner}-dark.svg">\n` +
        `  <img alt="${corpus.name} — ${corpus.bio ?? corpus.owner}" src="${opts.banner}-light.svg" width="100%">\n` +
        `</picture>`,
    );
  }
  md.push(`# ${corpus.name}`);
  if (corpus.bio) md.push(`**${corpus.bio}**`);
  if (links) md.push(links);
  md.push(statsLine(corpus.owner, shown, corpus.provenance.sourceEpoch));
  if (featured.length) md.push(`## Featured\n\n${featured.map(repoLine).join("\n")}`);
  md.push(...groupBlocks);
  md.push(`<sub>auto-updated${stamp ? ` ${stamp}` : ""}</sub>`);
  return md.join("\n\n") + "\n";
};

// The marked region for region-injection: a collapsible block of the grouped repos.
export const injectionBlock = (corpus: Corpus, opts: RenderOptions, marker: string): string => {
  const { groupBlocks } = view(corpus, opts);
  const stamp = stampDate(corpus.provenance.sourceEpoch);
  const start = `<!-- ${marker}:start -->`, end = `<!-- ${marker}:end -->`;
  return `${start}\n<details>\n<summary><b>All public repositories</b> — grouped by topic${stamp ? ` · auto-updated ${stamp}` : ""}</summary>\n\n${groupBlocks.join("\n\n")}\n\n</details>\n${end}`;
};

// Replace ONLY the marked region in `file`, preserving the rest. null = markers absent.
export const replaceMarkedRegion = (file: string, marker: string, block: string): string | null => {
  const re = new RegExp(`<!-- ${marker}:start -->[\\s\\S]*?<!-- ${marker}:end -->`);
  return re.test(file) ? file.replace(re, block) : null;
};
