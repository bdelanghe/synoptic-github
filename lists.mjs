#!/usr/bin/env node
// lists — triage your starred repos into GitHub Lists. Stars are an INBOX; Lists are the
// destination. Anything in no list is inbox; every star should be filed into a list or
// unstarred. Goal: inbox → 0. DRY-RUN by default (proposes, you decide); --apply --yes
// executes the account mutations via GraphQL (createUserList / updateUserListsForItem /
// removeStar). Sibling to curate.mjs / value.mjs.
//
//   GH_USER=bdelanghe node lists.mjs            # dry-run plan
//   GH_USER=bdelanghe node lists.mjs --json     # machine-readable plan
//   GH_USER=bdelanghe node lists.mjs --apply --yes   # EXECUTE (creates lists, files, unstars)
//
// 100% your own account, public stars only (private starred repos are skipped).
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { alignmentScore, starHistogram, DEFAULT_CONFIG as VALUE_CFG } from "./value.mjs";
const pexec = promisify(execFile);

export const DEFAULT_CONFIG = {
  minBucket: 6,         // a list smaller than this folds into "misc" (keeps lists meaningful)
  maxLists: 20,         // cap the number of lists (keep it navigable); the rest → misc
  pinnedCount: 25,      // size of the high-signal "pinned" list
  staleYears: 5,        // an untagged, undescribed repo older than this is unstar-bait
  // Thesis keep-filter: a star stays starred only if it signals the bet (what you build).
  betKeywords: ["agent", "agentic", "mcp", "claude", "llm", "skill", "ocap", "capabilit",
    "provenance", "attestation", "slsa", "sandbox", "spec-driven", "spec-kit", "codex", "subagent", "harness"],
  thesisKeepAlign: 0.5, // alignment ≥ this (vs your own repo topics) also keeps a star
};

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

// ---- pure triage (unit-tested in lists.test.ts) ------------------------------

export const ageYears = (iso, nowMs) => (iso ? (nowMs - Date.parse(iso)) / YEAR_MS : 0);

// Unstar-bait: clearly dead weight — archived, or no topic + no description + long stale.
export const lowSignal = (s, cfg, nowMs) =>
  !!s.isArchived || (s.topics.length === 0 && !s.description && ageYears(s.pushedAt, nowMs) > cfg.staleYears);

// The list a kept star belongs in: the most-common topic it carries (topics are the shared
// vocabulary), else its primary language (lowercased, so it merges with a same-named topic
// list — e.g. language "Python" folds into topic "python"), else "untagged".
export const listFor = (s, topicFreq) => {
  let label = null, best = -1;
  for (const t of s.topics) {
    const f = topicFreq.get(t) ?? 0;
    if (f > best || (f === best && label !== null && t < label)) { best = f; label = t; }
  }
  return label ?? (s.language ? s.language.toLowerCase() : "untagged");
};

// Whole triage plan from the star inbox: { lists, pinned, unstar, kept }. Every kept star
// lands in exactly one list; small/overflow buckets and "untagged" fold into "misc", so
// nothing is left in the inbox.
export const proposeLists = (stars, cfg, nowMs) => {
  const unstar = stars.filter((s) => lowSignal(s, cfg, nowMs));
  const kept = stars.filter((s) => !lowSignal(s, cfg, nowMs));

  const topicFreq = new Map();
  for (const s of kept) for (const t of s.topics) topicFreq.set(t, (topicFreq.get(t) || 0) + 1);

  const buckets = new Map();
  for (const s of kept) {
    const label = listFor(s, topicFreq);
    (buckets.get(label) ?? buckets.set(label, []).get(label)).push(s);
  }

  // Rank by size; keep the top maxLists buckets that clear minBucket (never "untagged"),
  // fold everything else into "misc" so every star stays filed.
  const ranked = [...buckets.entries()].map(([label, items]) => ({ label, items }))
    .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
  const keep = [], overflow = [];
  for (const b of ranked) {
    (keep.length < cfg.maxLists && b.items.length >= cfg.minBucket && b.label !== "untagged" ? keep : overflow).push(b);
  }
  const miscItems = overflow.flatMap((b) => b.items);
  if (miscItems.length) keep.push({ label: "misc", items: miscItems });
  const lists = keep.sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));

  const pinned = [...kept].sort((a, b) => b.stars - a.stars || a.nameWithOwner.localeCompare(b.nameWithOwner)).slice(0, cfg.pinnedCount);

  return { lists, pinned, unstar, kept, topicFreq };
};

// Thesis score: alignment of a star's topics/language to what YOU build (betHist) plus
// keyword hits in its name/description. Reuses value.mjs's alignment, so stars are scored
// the same way as your own repos — the bet is "does this signal what I build?".
export const thesisScore = (repo, betHist, keywords) => {
  const align = alignmentScore(repo, betHist, VALUE_CFG);
  const hay = `${repo.nameWithOwner} ${repo.description ?? ""}`.toLowerCase();
  const kw = keywords.filter((k) => hay.includes(k)).length;
  return { score: align + 0.5 * kw, align, kw };
};

// Disposition every star: keep (on-thesis → stays starred) or drop (archive → unstar).
// `cluster` is the topical bucket (from proposeLists), independent of keep/drop.
export const classify = (stars, betHist, cfg, nowMs) => {
  const plan = proposeLists(stars, cfg, nowMs);
  const cluster = new Map();
  for (const l of plan.lists) for (const r of l.items) cluster.set(r.nameWithOwner, l.label);
  for (const r of plan.unstar) cluster.set(r.nameWithOwner, "low-signal");
  return stars
    .map((r) => {
      const t = thesisScore(r, betHist, cfg.betKeywords);
      const keep = t.kw > 0 || t.align >= cfg.thesisKeepAlign;
      return {
        repo: r.nameWithOwner, id: r.id, url: `https://github.com/${r.nameWithOwner}`,
        stars: r.stars, language: r.language, topics: r.topics, description: r.description,
        cluster: cluster.get(r.nameWithOwner) ?? "misc",
        thesis: Number(t.score.toFixed(3)), disposition: keep ? "keep" : "drop",
      };
    })
    .sort((a, b) => (a.disposition === b.disposition ? b.thesis - a.thesis : a.disposition === "keep" ? -1 : 1));
};

// NDJSON archive: one record per star. The persistent record (a GitHub List needs stars; a
// file doesn't), so live stars can be pruned to the keep-set without losing anything.
export const exportJsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

// ---- IO (runs only when invoked directly) -----------------------------------

const loadConfig = (dir) => {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "lists.config.json"), "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch { return DEFAULT_CONFIG; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const graphql = async (query, vars = {}) => {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-F", `${k}=${v}`);
  try { return JSON.parse((await pexec("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })).stdout); }
  catch (e) { console.error(`✗ graphql: ${String(e).split("\n")[0]}`); return null; }
};

const STARS_Q = `query($after: String) {
  viewer {
    starredRepositories(first: 100, after: $after, orderBy: {field: STARRED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id nameWithOwner isArchived isPrivate stargazerCount pushedAt description
        primaryLanguage { name }
        repositoryTopics(first: 20) { nodes { topic { name } } }
      }
    }
  }
}`;

const fetchStars = async () => {
  const out = [];
  let after = null;
  for (;;) {
    const r = await graphql(STARS_Q, after ? { after } : {});
    const conn = r?.data?.viewer?.starredRepositories;
    if (!conn) break;
    for (const n of conn.nodes) {
      if (n.isPrivate) continue; // public stars only
      out.push({
        id: n.id, nameWithOwner: n.nameWithOwner, isArchived: n.isArchived,
        stars: n.stargazerCount ?? 0, pushedAt: n.pushedAt, description: n.description || null,
        language: n.primaryLanguage?.name ?? null,
        topics: (n.repositoryTopics?.nodes ?? []).map((t) => t.topic.name),
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
};

// The "bet" = what you build: your own + ORGS public, non-fork repo topics/languages.
const fetchOwnTopics = async (user) => {
  const orgs = (process.env.ORGS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const fields = "repositoryTopics,primaryLanguage,visibility";
  const out = [];
  for (const owner of [user, ...orgs]) {
    try {
      const repos = JSON.parse((await pexec("gh", ["repo", "list", owner, "--no-archived", "--source", "--visibility", "public", "--limit", "300", "--json", fields], { encoding: "utf8", maxBuffer: 64e6 })).stdout);
      for (const r of repos) out.push({ topics: (r.repositoryTopics || []).map((t) => t.name), language: r.primaryLanguage?.name ?? null });
    } catch {}
  }
  return out;
};

const LISTS_Q = `{ viewer { lists(first: 100) { nodes { id name slug isPrivate items(first: 1) { totalCount } } } } }`;

// --- mutations (only fire under --apply --yes). IDs are GitHub node ids, inlined because
// gh api can't pass GraphQL list-typed ($listIds: [ID!]) variables cleanly; values are
// JSON.stringify'd so a stray quote can't break out. ---
const createList = (label) =>
  graphql(`mutation { createUserList(input: {name: ${JSON.stringify(label)}, description: ${JSON.stringify(`${label} — starred repos, auto-filed by lists.mjs`)}, isPrivate: false}) { list { id name } } }`);
const fileItem = (repoId, listId) =>
  graphql(`mutation { updateUserListsForItem(input: {itemId: ${JSON.stringify(repoId)}, listIds: [${JSON.stringify(listId)}]}) { clientMutationId } }`);
const unstarItem = (repoId) =>
  graphql(`mutation { removeStar(input: {starrableId: ${JSON.stringify(repoId)}}) { clientMutationId } }`);

// Execute the plan: ensure each target list exists (reuse by case-insensitive name), file
// its repos. Unstarring is destructive and stays opt-in (--unstar). --only/--limit scope it.
const applyPlan = async (plan, existing, opts) => {
  const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l.id]));
  let lists = plan.lists.filter((l) => l.label !== "misc"); // don't auto-create a junk drawer
  if (opts.only) { const set = new Set(opts.only.toLowerCase().split(",").map((s) => s.trim())); lists = lists.filter((l) => set.has(l.label.toLowerCase())); }
  if (!lists.length) { console.error(`✗ no proposed list to apply${opts.only ? ` for --only ${opts.only}` : ""}`); return; }

  let created = 0, filed = 0;
  for (const l of lists) {
    let id = byName.get(l.label.toLowerCase());
    if (!id) {
      id = (await createList(l.label))?.data?.createUserList?.list?.id;
      if (!id) { console.error(`  ✗ could not create list '${l.label}'`); continue; }
      byName.set(l.label.toLowerCase(), id); created++;
      console.log(`  + created list '${l.label}'`);
    }
    const items = opts.limit ? l.items.slice(0, opts.limit) : l.items;
    for (const r of items) { (await fileItem(r.id, id))?.data ? filed++ : console.error(`  ✗ file ${r.nameWithOwner}`); await sleep(180); } // throttle: dodge secondary rate limits
    console.log(`  → filed ${items.length} into '${l.label}'`);
  }

  let unstarred = 0;
  if (opts.unstar) {
    const cull = opts.limit ? plan.unstar.slice(0, opts.limit) : plan.unstar;
    for (const r of cull) { if ((await unstarItem(r.id))?.data) unstarred++; await sleep(180); }
    console.log(`  − unstarred ${unstarred}`);
  }
  console.log(`\n  applied: ${created} list(s) created · ${filed} repo(s) filed${opts.unstar ? ` · ${unstarred} unstarred` : " · unstar skipped (pass --unstar)"}\n`);
};

const main = async () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const cfg = loadConfig(dir);
  const nowMs = Date.now();
  const argVal = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
  const asJson = process.argv.includes("--json");
  const apply = process.argv.includes("--apply");
  const yes = process.argv.includes("--yes");
  const only = argVal("--only");
  const doUnstar = process.argv.includes("--unstar");
  const limit = Number(argVal("--limit")) || 0;

  const stars = await fetchStars();
  if (!stars.length) { console.error("✗ no public stars found (is `gh` authenticated?)"); process.exit(1); }
  const existing = (await graphql(LISTS_Q))?.data?.viewer?.lists?.nodes ?? [];

  const plan = proposeLists(stars, cfg, nowMs);

  // --export <file>: thesis-classify every star and write the JSONL archive (keep/drop).
  // --prune <file>:  unstar the disposition:"drop" repos listed in an existing archive —
  //   archive-driven, so the record is guaranteed saved first. Throttled + capped.
  const exportFile = argVal("--export");
  const pruneFile = argVal("--prune");
  if (exportFile || pruneFile) {
    if (exportFile) {
      const betHist = starHistogram(await fetchOwnTopics(user));
      const records = classify(stars, betHist, cfg, nowMs);
      const keep = records.filter((r) => r.disposition === "keep").length;
      writeFileSync(exportFile, exportJsonl(records));
      console.log(`✓ archived ${records.length} stars → ${exportFile} · keep ${keep} · drop ${records.length - keep}`);
    }
    if (pruneFile) {
      const archived = readFileSync(pruneFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const drops = archived.filter((r) => r.disposition === "drop" && r.id);
      const cap = limit || drops.length;
      if (!(apply && yes)) { console.log(`  --prune: would unstar ${drops.length} drop(s) from ${pruneFile}. Add --apply --yes (and --limit N to cap a run).`); return; }
      console.log(`  PRUNING ${Math.min(cap, drops.length)} of ${drops.length} drops (throttled ~1.3s/call) …`);
      let n = 0;
      for (const r of drops.slice(0, cap)) { if ((await unstarItem(r.id))?.data) n++; await sleep(1300); }
      console.log(`  − unstarred ${n}${drops.length > cap ? ` · ${drops.length - cap} remain (re-run to continue)` : ""}`);
    }
    return;
  }

  if (asJson) {
    console.log(JSON.stringify({
      counts: { stars: stars.length, kept: plan.kept.length, unstar: plan.unstar.length, lists: plan.lists.length },
      existingLists: existing.map((l) => ({ name: l.name, items: l.items.totalCount })),
      lists: plan.lists.map((l) => ({ label: l.label, count: l.items.length, sample: l.items.slice(0, 5).map((r) => r.nameWithOwner) })),
      pinned: plan.pinned.map((r) => r.nameWithOwner),
      unstar: plan.unstar.map((r) => r.nameWithOwner),
    }, null, 2));
    return;
  }

  console.log(`\n  STAR TRIAGE — ${stars.length} public stars → ${plan.lists.length} lists · ${plan.unstar.length} unstar · ${plan.kept.length} kept`);
  if (existing.length) console.log(`  existing lists: ${existing.map((l) => `${l.name}(${l.items.totalCount})`).join(", ")}`);

  console.log(`\n  PROPOSED LISTS`);
  for (const l of plan.lists) {
    console.log(`  ${l.label.padEnd(22)} ${String(l.items.length).padStart(4)}  ${l.items.slice(0, 3).map((r) => r.nameWithOwner).join(", ")}${l.items.length > 3 ? " …" : ""}`);
  }

  console.log(`\n  PINNED (top ${plan.pinned.length} by stars — the landmark refs)`);
  for (const r of plan.pinned.slice(0, 12)) console.log(`  ${String(r.stars).padStart(7)}★  ${r.nameWithOwner}`);
  if (plan.pinned.length > 12) console.log(`  … and ${plan.pinned.length - 12} more`);

  console.log(`\n  UNSTAR CANDIDATES (${plan.unstar.length} — archived / untagged+undescribed+stale)`);
  for (const r of plan.unstar.slice(0, 12)) console.log(`  ${r.nameWithOwner}${r.isArchived ? " [archived]" : ""}`);
  if (plan.unstar.length > 12) console.log(`  … and ${plan.unstar.length - 12} more`);

  console.log(`\n  After triage: every kept star filed into a list, ${plan.unstar.length} unstarred → inbox 0.`);
  if (apply && !yes) {
    console.log(`\n  --apply needs --yes to mutate your account (creates ~${plan.lists.length} lists, files ${plan.kept.length}). Dry-run only.`);
  } else if (apply && yes) {
    console.log(`\n  APPLYING${only ? ` (--only ${only})` : ""}${limit ? ` (--limit ${limit})` : ""}${doUnstar ? " +unstar" : ""} …`);
    await applyPlan(plan, existing, { only, unstar: doUnstar, limit });
  }
  console.log("");
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
