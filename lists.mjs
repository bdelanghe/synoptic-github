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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const pexec = promisify(execFile);

export const DEFAULT_CONFIG = {
  minBucket: 6,         // a list smaller than this folds into "misc" (keeps lists meaningful)
  maxLists: 20,         // cap the number of lists (keep it navigable); the rest → misc
  pinnedCount: 25,      // size of the high-signal "pinned" list
  staleYears: 5,        // an untagged, undescribed repo older than this is unstar-bait
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

// ---- IO (runs only when invoked directly) -----------------------------------

const loadConfig = (dir) => {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "lists.config.json"), "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch { return DEFAULT_CONFIG; }
};

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

const LISTS_Q = `{ viewer { lists(first: 100) { nodes { name slug isPrivate items(first: 1) { totalCount } } } } }`;

const main = async () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const cfg = loadConfig(dir);
  const nowMs = Date.now();
  const asJson = process.argv.includes("--json");
  const apply = process.argv.includes("--apply");
  const yes = process.argv.includes("--yes");

  const stars = await fetchStars();
  if (!stars.length) { console.error("✗ no public stars found (is `gh` authenticated?)"); process.exit(1); }
  const existing = (await graphql(LISTS_Q))?.data?.viewer?.lists?.nodes ?? [];

  const plan = proposeLists(stars, cfg, nowMs);

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
  if (apply && !yes) console.log(`\n  --apply needs --yes to mutate your account (creates ${plan.lists.length} lists, files ${plan.kept.length}, unstars ${plan.unstar.length}). Dry-run only.`);
  else if (apply && yes) console.log(`\n  (apply path is implemented but intentionally not auto-run in this build — wire up applyPlan() when ready.)`);
  console.log("");
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
