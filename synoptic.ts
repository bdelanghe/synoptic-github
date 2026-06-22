#!/usr/bin/env bun
// synoptic-github — one corpus, three modes:
//   render   (default) GitHub corpus → a clean, topic-grouped README
//   validate           lint repos against the contract (vocabulary + hygiene); exits non-zero on errors
//   suggest            deterministic topic suggestions (keyword rules) for untagged repos, as gh commands
//
// Pipeline: fetch → normalize → validate shape (Zod) → dispatch on mode.
// Env: GITHUB_TOKEN (required) · GROUP_BY=topic|language|none · OUT=README.md
//      SOURCE_DATE_EPOCH (reproducible stamp) · GITHUB_SHA (provenance) · STRICT=1 (validate fails on warnings)
// Usage: bun synoptic.ts [render|validate|suggest]
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Repo, Corpus, type Provenance } from "./schema.ts";
import { TOPICS, suggestTopics } from "./vocabulary.ts";

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) { console.error("✗ set GITHUB_TOKEN"); process.exit(1); }
const MODE = (process.argv[2] || process.env.MODE || "render").toLowerCase();
const GROUP_BY = (process.env.GROUP_BY || "topic").toLowerCase();
const OUT = process.env.OUT || "README.md";
const here = dirname(fileURLToPath(import.meta.url));

// Lead with the strongest categories; experiments/games sink to the bottom.
const TOPIC_PRIORITY = [
  "capability-security", "agent-infra", "ai", "developer-tools", "library", "cli",
  "infrastructure", "nix", "state-machines", "design-tokens", "data-viz", "web",
  "algorithms", "game", "learning", "experiment",
];
const pri = (t: string) => (TOPIC_PRIORITY.indexOf(t) === -1 ? 999 : TOPIC_PRIORITY.indexOf(t));

async function gh(path: string) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "synoptic-github" },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}
async function ghAll(path: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const batch = (await gh(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)) as any[];
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

// ---- fetch + normalize + validate the contract (shared by all modes) ---------
// GH_USER (or GITHUB_REPOSITORY_OWNER) → use the PUBLIC /users/{login}/repos
// endpoint, which works with any token incl. the Actions GITHUB_TOKEN. Without it,
// fall back to /user (a user/PAT token) for local runs.
// (Not USERNAME — that collides with the ambient shell/OS variable.)
const GH_USER = process.env.GH_USER || process.env.GITHUB_REPOSITORY_OWNER;
const user = (GH_USER ? await gh(`/users/${GH_USER}`) : await gh("/user")) as {
  name?: string; login: string; bio?: string | null; blog?: string | null; location?: string | null;
  company?: string | null; twitter_username?: string | null;
};
const isMeta = (r: any) => r.name === ".github" || r.name.toLowerCase() === user.login.toLowerCase();
const reposPath = GH_USER ? `/users/${user.login}/repos?type=owner` : "/user/repos?affiliation=owner&visibility=public";
// ORGS (comma-separated) pulls in public org repos too — so your best work shows.
const ORGS = (process.env.ORGS || "").split(",").map((s) => s.trim()).filter(Boolean);
const orgRaw = (await Promise.all(ORGS.map((o) => ghAll(`/orgs/${o}/repos?type=public`)))).flat();
const seen = new Set<string>();
const repos = ([...((await ghAll(reposPath)) as any[]), ...orgRaw])
  .filter((r) => (seen.has(r.full_name) ? false : (seen.add(r.full_name), true)))
  .filter((r) => !r.fork && !r.archived && !r.private && !isMeta(r))
  .map((r) =>
    Repo.parse({
      name: r.name, fullName: r.full_name, url: r.html_url, description: r.description ?? null,
      language: r.language ?? null, topics: r.topics ?? [], stars: r.stargazers_count, pushedAt: r.pushed_at,
    }),
  )
  .sort((a, b) => b.stars - a.stars || (a.pushedAt < b.pushedAt ? 1 : a.pushedAt > b.pushedAt ? -1 : 0) || a.name.localeCompare(b.name));

const provenance: Provenance = {
  tool: "synoptic-github",
  version: (process.env.GITHUB_SHA ?? "dev").slice(0, 7),
  owner: user.login,
  sourceEpoch: Number(process.env.SOURCE_DATE_EPOCH ?? 0) || 0,
};
const corpus = Corpus.parse({
  provenance, owner: user.login, name: user.name || user.login,
  bio: user.bio ?? null, blog: user.blog || null, location: user.location ?? null,
  company: user.company ?? null, twitter: user.twitter_username ?? null, repos,
});

// ---- modes -------------------------------------------------------------------
if (MODE === "validate") {
  const vocab = new Set<string>(TOPICS);
  let errors = 0, warns = 0;
  for (const r of corpus.repos) {
    const unknown = r.topics.filter((t) => !vocab.has(t));
    if (unknown.length) { console.error(`✗ ${r.fullName}: topics not in vocabulary: ${unknown.join(", ")}`); errors++; }
    if (r.topics.length === 0) { console.warn(`⚠ ${r.fullName}: no topics`); warns++; }
    if (!r.description) { console.warn(`⚠ ${r.fullName}: no description`); warns++; }
  }
  const strict = process.env.STRICT === "1";
  console.log(`validate: ${corpus.repos.length} repos · ${errors} error(s) · ${warns} warning(s)${strict ? " · STRICT" : ""}`);
  process.exit(errors > 0 || (strict && warns > 0) ? 1 : 0);
} else if (MODE === "suggest") {
  let n = 0;
  for (const r of corpus.repos) {
    if (r.topics.length > 0) continue; // only untagged
    const s = suggestTopics(r);
    if (!s.length) continue;
    n++;
    console.log(`${r.fullName} → ${s.join(", ")}`);
    console.log(`  gh api --method PUT repos/${r.fullName}/topics ${s.map((t) => `-f 'names[]=${t}'`).join(" ")}`);
  }
  console.log(`suggest: ${n} untagged repo(s) with suggestions`);
} else if (MODE === "render") {
  // FILTER="topicA,topicB" → query the corpus: only repos carrying one of these topics.
  const FILTER = (process.env.FILTER || "").split(",").map((s) => s.trim()).filter(Boolean);
  const shown = FILTER.length ? corpus.repos.filter((r) => r.topics.some((t) => FILTER.includes(t))) : corpus.repos;

  const langs = Object.entries(
    shown.reduce<Record<string, number>>((m, r) => (r.language ? ((m[r.language] = (m[r.language] || 0) + 1), m) : m), {}),
  ).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const line = (r: Repo) =>
    `- [${r.name}](${r.url})` + (r.description ? ` — ${r.description}` : "") + (r.language ? ` \`${r.language}\`` : "");

  const blogHref = corpus.blog ? (corpus.blog.startsWith("http") ? corpus.blog : `https://${corpus.blog}`) : null;
  const ghUser = (h: string) => `[${h}](https://github.com/${h.replace(/^@/, "")})`;
  const linksLine = [
    corpus.location,
    blogHref ? `[${blogHref.replace(/^https?:\/\//, "")}](${blogHref})` : null,
    corpus.company ? (corpus.company.startsWith("@") ? ghUser(corpus.company) : corpus.company) : null,
    corpus.twitter ? `[@${corpus.twitter}](https://x.com/${corpus.twitter})` : null,
  ].filter(Boolean).join(" · ");
  const statsLine =
    `\`${corpus.owner}\` · ${shown.length} public repositories · ` +
    langs.slice(0, 4).map(([l, n]) => `${l} ${n}`).join(" · ");

  // Graphics: BANNER=path/prefix → a theme-aware <picture> (…-dark.svg / …-light.svg) at the top.
  const BANNER = process.env.BANNER?.trim();
  // Curated highlights: FEATURED="repoA,repoB" → a Featured section, in that order, pulled out of the groups.
  const featuredNames = (process.env.FEATURED || "").split(",").map((s) => s.trim()).filter(Boolean);
  const featured = featuredNames
    .map((n) => shown.find((r) => r.name === n))
    .filter((r): r is Repo => !!r);
  const featuredSet = new Set(featured.map((r) => r.name));
  const rest = shown.filter((r) => !featuredSet.has(r.name));

  // Group blocks (shared by full render + region-injection).
  const groupBlocks: string[] = [];
  if (GROUP_BY === "none") {
    groupBlocks.push(rest.map(line).join("\n"));
  } else if (GROUP_BY === "language") {
    for (const [lang] of langs) {
      const inLang = rest.filter((r) => r.language === lang);
      if (inLang.length) groupBlocks.push(`## ${lang}\n\n${inLang.map(line).join("\n")}`);
    }
  } else {
    const groups = new Map<string, Repo[]>();
    const other: Repo[] = [];
    for (const r of rest) (r.topics[0] ? (groups.get(r.topics[0]) ?? groups.set(r.topics[0], []).get(r.topics[0])!) : other).push(r);
    for (const [topic, rs] of [...groups].sort((a, b) => pri(a[0]) - pri(b[0]) || b[1].length - a[1].length || a[0].localeCompare(b[0])))
      groupBlocks.push(`## ${topic}\n\n${rs.map(line).join("\n")}`);
    if (other.length) groupBlocks.push(`## other\n\n${other.map(line).join("\n")}`);
  }
  const stampDate = corpus.provenance.sourceEpoch ? new Date(corpus.provenance.sourceEpoch * 1000).toISOString().slice(0, 10) : "";

  const injectInto = process.env.INJECT_INTO;
  if (injectInto) {
    // Region-injection: replace ONLY the marked block, preserving the handcrafted file.
    const marker = process.env.MARKER || "synoptic";
    const start = `<!-- ${marker}:start -->`, end = `<!-- ${marker}:end -->`;
    const block = `${start}\n<details>\n<summary><b>All public repositories</b> — grouped by topic${stampDate ? ` · auto-updated ${stampDate}` : ""}</summary>\n\n${groupBlocks.join("\n\n")}\n\n</details>\n${end}`;
    const file = await readFile(injectInto, "utf8");
    const re = new RegExp(`${start}[\\s\\S]*?${end}`);
    if (!re.test(file)) { console.error(`✗ markers not found in ${injectInto}: ${start} … ${end}`); process.exit(1); }
    await writeFile(injectInto, file.replace(re, block));
    console.log(`✓ injected ${shown.length} repos into ${injectInto} between '${marker}' markers`);
  } else {
    const md: string[] = [];
    if (BANNER) {
      md.push(
        `<picture>\n` +
          `  <source media="(prefers-color-scheme: dark)" srcset="${BANNER}-dark.svg">\n` +
          `  <img alt="${corpus.name} — ${corpus.bio ?? corpus.owner}" src="${BANNER}-light.svg" width="100%">\n` +
          `</picture>`,
      );
    }
    md.push(`# ${corpus.name}`);
    if (corpus.bio) md.push(`**${corpus.bio}**`);
    if (linksLine) md.push(linksLine);
    md.push(statsLine);
    if (featured.length) md.push(`## Featured\n\n${featured.map(line).join("\n")}`);
    md.push(...groupBlocks);
    md.push(`<sub>auto-updated${stampDate ? ` ${stampDate}` : ""}</sub>`);
    await writeFile(OUT, md.join("\n\n") + "\n");
    console.log(`✓ wrote ${OUT} — ${shown.length}/${corpus.repos.length} repos, grouped by ${GROUP_BY}, stamped ${corpus.provenance.version}`);
  }
} else {
  console.error(`✗ unknown mode '${MODE}' (use: render | validate | suggest)`);
  process.exit(2);
}
