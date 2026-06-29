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
import { LANGUAGE_NAMES } from "./languages.ts";
import { renderProfile, injectionBlock, replaceMarkedRegion, filterRepos, type RenderOptions } from "./render.ts";
import { renderStatus, ciOf, RepoStatus, BeadsSummary, type RepoStatus as RepoStatusT } from "./status.ts";

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) { console.error("✗ set GITHUB_TOKEN"); process.exit(1); }
const MODE = (process.argv[2] || process.env.MODE || "render").toLowerCase();
const GROUP_BY = (process.env.GROUP_BY || process.env["INPUT_GROUP-BY"] || "topic").toLowerCase();
const OUT = process.env.OUT || process.env.INPUT_OUT || "README.md";
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
const user = (GH_USER ? await gh(`/users/${GH_USER}`) : await gh("/user")) as {
  name?: string; login: string; bio?: string | null; blog?: string | null; location?: string | null;
  company?: string | null; twitter_username?: string | null;
};
const isMeta = (r: any) => r.name === ".github" || r.name.toLowerCase() === user.login.toLowerCase();
const reposPath = GH_USER ? `/users/${user.login}/repos?type=owner` : "/user/repos?affiliation=owner&visibility=public";
// ORGS (comma-separated) pulls in public org repos too — so your best work shows.
const ORGS = (process.env.ORGS || process.env.INPUT_ORGS || "").split(",").map((s) => s.trim()).filter(Boolean);
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
    if (r.language && !LANGUAGE_NAMES.has(r.language)) { console.warn(`⚠ ${r.fullName}: language not in ontology: ${r.language}`); warns++; }
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
} else if (MODE === "status") {
  // ---- monitoring layer (see status.ts) ------------------------------------
  // Right-join live signal onto the corpus: latest CI run + open PR/issue counts.
  // Wall-clock by nature, so this writes its OWN artifact (never the README) and
  // stamps real time — the one place Date.now() is correct in this tool.
  // Per repo: GET /repos (open_issues_count, default_branch) · /actions/runs?per_page=1
  //   · /pulls?state=open. One bad repo degrades to ⚪ rather than failing the board.
  const POOL = Number(process.env.STATUS_CONCURRENCY || 8);
  const statuses = new Map<string, RepoStatusT>();
  const queue = [...corpus.repos];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      try {
        const meta = (await gh(`/repos/${r.fullName}`)) as { open_issues_count: number; default_branch: string };
        const runs = (await gh(`/repos/${r.fullName}/actions/runs?branch=${meta.default_branch}&per_page=1`)) as {
          workflow_runs?: { status?: string; conclusion?: string | null; html_url?: string; created_at?: string }[];
        };
        const prs = (await gh(`/repos/${r.fullName}/pulls?state=open&per_page=100`)) as any[];
        const run = runs.workflow_runs?.[0];
        const openPRs = prs.length;
        statuses.set(r.fullName, RepoStatus.parse({
          fullName: r.fullName,
          ci: ciOf(run),
          ciUrl: run?.html_url ?? null,
          ciRunAt: run?.created_at ?? null,
          openPRs,
          openIssues: Math.max(0, meta.open_issues_count - openPRs), // open_issues_count counts PRs too
        }));
      } catch (e) {
        console.warn(`⚠ ${r.fullName}: status unavailable (${(e as Error).message.split("\n")[0]})`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, corpus.repos.length) }, worker));

  // Optional org-backlog summary. The caller (where a beads daemon is reachable —
  // never CI) computes counts and passes them as BEADS_SUMMARY JSON; synoptic stays
  // generic and just renders them. Malformed/absent → the line is simply omitted.
  let backlog = null;
  const raw = process.env.BEADS_SUMMARY || process.env.INPUT_BEADS_SUMMARY;
  if (raw) {
    const parsed = BeadsSummary.safeParse(JSON.parse(raw));
    if (parsed.success) backlog = parsed.data;
    else console.warn(`⚠ BEADS_SUMMARY ignored (does not match schema): ${parsed.error.issues[0]?.message}`);
  }

  const stampISO = new Date().toISOString(); // monitoring layer: real time is intended here
  const md = renderStatus(corpus, statuses, stampISO, backlog);
  const STATUS_OUT = process.env.STATUS_OUT || process.env.INPUT_STATUS_OUT || "STATUS.md";
  await writeFile(STATUS_OUT, md);
  await writeFile(STATUS_OUT.replace(/\.md$/, "") + ".json", JSON.stringify({ stampISO, statuses: [...statuses.values()] }, null, 2) + "\n");
  const red = [...statuses.values()].filter((s) => s.ci === "failure").length;
  console.log(`✓ wrote ${STATUS_OUT} — ${statuses.size}/${corpus.repos.length} repos, ${red} red, stamped ${stampISO}`);
} else if (MODE === "render") {
  // Render is a pure function of the corpus + options (see render.ts); this mode just
  // gathers env → options and owns the IO (write, or region-inject into an existing file).
  const opts: RenderOptions = {
    groupBy: GROUP_BY,
    filter: (process.env.FILTER || process.env.INPUT_FILTER || "").split(",").map((s) => s.trim()).filter(Boolean),
    banner: (process.env.BANNER || process.env.INPUT_BANNER)?.trim() || null,
    featured: (process.env.FEATURED || process.env.INPUT_FEATURED || "").split(",").map((s) => s.trim()).filter(Boolean),
    thesis: (process.env.THESIS || process.env.INPUT_THESIS)?.trim() || null,
    readFirst: (process.env.READ_FIRST || process.env["INPUT_READ-FIRST"])?.trim() || null,
  };
  const shownCount = filterRepos(corpus.repos, opts.filter).length;

  const injectInto = process.env.INJECT_INTO || process.env["INPUT_INJECT-INTO"];
  if (injectInto) {
    const marker = process.env.MARKER || process.env.INPUT_MARKER || "synoptic";
    const block = injectionBlock(corpus, opts, marker);
    const file = await readFile(injectInto, "utf8");
    const replaced = replaceMarkedRegion(file, marker, block);
    if (replaced === null) {
      console.error(`✗ markers not found in ${injectInto}: <!-- ${marker}:start --> … <!-- ${marker}:end -->`);
      process.exit(1);
    }
    await writeFile(injectInto, replaced);
    console.log(`✓ injected ${shownCount} repos into ${injectInto} between '${marker}' markers`);
  } else {
    await writeFile(OUT, renderProfile(corpus, opts));
    console.log(`✓ wrote ${OUT} — ${shownCount}/${corpus.repos.length} repos, grouped by ${GROUP_BY}, stamped ${corpus.provenance.version}`);
  }
} else {
  console.error(`✗ unknown mode '${MODE}' (use: render | validate | suggest)`);
  process.exit(2);
}
