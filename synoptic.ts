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
const user = (GH_USER ? await gh(`/users/${GH_USER}`) : await gh("/user")) as { name?: string; login: string };
const isMeta = (r: any) => r.name === ".github" || r.name.toLowerCase() === user.login.toLowerCase();
const reposPath = GH_USER ? `/users/${user.login}/repos?type=owner` : "/user/repos?affiliation=owner&visibility=public";
const repos = ((await ghAll(reposPath)) as any[])
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
const corpus = Corpus.parse({ provenance, owner: user.login, name: user.name || user.login, repos });

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
  const emojis = await (async () => {
    try {
      const txt = await readFile(join(here, "action", "language_emojis.txt"), "utf8");
      return Object.fromEntries(txt.split("\n").map((l) => l.split(":")).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
    } catch { return {} as Record<string, string>; }
  })();
  const langs = Object.entries(
    corpus.repos.reduce<Record<string, number>>((m, r) => (r.language ? ((m[r.language] = (m[r.language] || 0) + 1), m) : m), {}),
  ).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const line = (r: Repo) =>
    `- [${r.name}](${r.url})` + (r.description ? ` — ${r.description}` : "") + (r.language ? ` \`${emojis[r.language] ?? ""}${r.language}\`` : "");

  const md: string[] = [
    `# ${corpus.name}`,
    `\`${corpus.owner}\` · ${corpus.repos.length} public repositories · ${langs.slice(0, 4).map(([l, n]) => `${l} ${n}`).join(" · ")}`,
  ];
  if (GROUP_BY === "none") {
    md.push(corpus.repos.map(line).join("\n"));
  } else if (GROUP_BY === "language") {
    for (const [lang] of langs) {
      const inLang = corpus.repos.filter((r) => r.language === lang);
      if (inLang.length) md.push(`## ${emojis[lang] ?? ""}${lang}\n\n${inLang.map(line).join("\n")}`);
    }
  } else {
    const groups = new Map<string, Repo[]>();
    const other: Repo[] = [];
    for (const r of corpus.repos) (r.topics[0] ? (groups.get(r.topics[0]) ?? groups.set(r.topics[0], []).get(r.topics[0])!) : other).push(r);
    for (const [topic, rs] of [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])))
      md.push(`## ${topic}\n\n${rs.map(line).join("\n")}`);
    if (other.length) md.push(`## other\n\n${other.map(line).join("\n")}`);
  }
  const stamp = corpus.provenance.sourceEpoch ? ` · ${new Date(corpus.provenance.sourceEpoch * 1000).toISOString().slice(0, 10)}` : "";
  md.push(`<sub>Generated by <a href="https://github.com/bdelanghe/synoptic-github">synoptic-github</a> @ ${corpus.provenance.version}${stamp} — grouped by self-labeled topic.</sub>`);

  await writeFile(OUT, md.join("\n\n") + "\n");
  console.log(`✓ wrote ${OUT} — ${corpus.repos.length} repos, grouped by ${GROUP_BY}, stamped ${corpus.provenance.version}`);
} else {
  console.error(`✗ unknown mode '${MODE}' (use: render | validate | suggest)`);
  process.exit(2);
}
