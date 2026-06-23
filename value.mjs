#!/usr/bin/env node
// value — score each repo on market fit, driven entirely by STARS, GitHub's universal
// market currency (explore / trending / topics / collections are all star-ranked). Three
// axes, each a kind of star:
//   traction   — stars YOUR repo earned                (have you landed)
//   gravity    — star-mass of the repo's topic-market  (is there a market: search by topic)
//   alignment  — your 1119 outbound stars' topic/lang  (do you build where you yourself follow)
//
// ADVISORY + NON-DETERMINISTIC (live data); it proposes, you decide. Its only output that
// crosses into the reproducible render is the suggested FEATURED list. Sibling to curate.mjs.
// 100% PUBLIC data — never reads a private repo (every fetch is public-gated). No push access
// needed, so all public org repos are covered.
//
//   GH_USER=bdelanghe node value.mjs                          # ranked table + market map + FEATURED=
//   GH_USER=bdelanghe ORGS=bounded-systems node value.mjs     # include public org repos
//   GH_USER=bdelanghe node value.mjs --json                   # machine-readable
//
// Config: value.config.json (optional) shallow-overrides DEFAULT_CONFIG.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const pexec = promisify(execFile);

export const DEFAULT_CONFIG = {
  weights: { gravity: 0.40, alignment: 0.35, traction: 0.25 },
  featuredCount: 4,
  ceilingLog: 5,            // top-repo stars in a topic: 10^5 ⇒ gravity ceiling 1.0
  breadthLog: 5,            // repos in a topic:          10^5 ⇒ breadth 1.0
  ceilingWeight: 0.6,       // gravity = ceilingWeight·ceiling + (1-ceilingWeight)·breadth
  topicAffinityWeight: 0.6, // alignment = ·topicAff + (1-·)·langAff
  starredTopicsToMarket: 12,// how many of your top starred topics to price for the market map
  maxTopicFetches: 28,      // hard cap on search calls (search API is ~30/min)
  retagSuggestions: 5,
  lowGravity: 0.35,         // a primary topic below this is "mis-shelved"
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const maxVal = (m) => (m.size ? Math.max(...m.values()) : 0);

// ---- pure scoring (unit-tested in value.test.ts) -----------------------------

// Stars/repo-counts are heavy-tailed, so compress with log10 before scaling.
export const logScale = (x, capLog) => clamp01(Math.log10((x ?? 0) + 1) / capLog);

// Relative log scale across the corpus (for your own repo stars, which are small numbers).
export const logNorm = (values) => {
  const logs = values.map((v) => Math.log10((v ?? 0) + 1));
  const max = Math.max(0, ...logs);
  return logs.map((l) => (max > 0 ? l / max : 0));
};

// Topic/language histogram of what YOU star — your personal market map.
export const starHistogram = (starred) => {
  const topics = new Map(), langs = new Map();
  for (const s of starred) {
    for (const t of s.topics ?? []) topics.set(t, (topics.get(t) || 0) + 1);
    if (s.language) langs.set(s.language, (langs.get(s.language) || 0) + 1);
  }
  return { topics, langs };
};

// How central a repo's topics / language are to what you personally follow (0..1).
export const topicAffinity = (topics, hist) => {
  const max = maxVal(hist.topics);
  if (!max) return 0;
  let best = 0;
  for (const t of topics) best = Math.max(best, (hist.topics.get(t) || 0) / max);
  return best;
};
export const langAffinity = (language, hist) => {
  const max = maxVal(hist.langs);
  return max && language ? (hist.langs.get(language) || 0) / max : 0;
};
export const alignmentScore = (repo, hist, cfg) =>
  cfg.topicAffinityWeight * topicAffinity(repo.topics, hist) +
  (1 - cfg.topicAffinityWeight) * langAffinity(repo.language, hist);

// Star-mass of a single topic-market: how tall (top repo's stars) and how wide (repo count).
export const topicGravity = (market, cfg) => {
  if (!market) return 0;
  const ceiling = logScale(market.topStars, cfg.ceilingLog);
  const breadth = logScale(market.repos, cfg.breadthLog);
  return cfg.ceilingWeight * ceiling + (1 - cfg.ceilingWeight) * breadth;
};
// A repo sits in the best market any of its topics reaches.
export const repoGravity = (topics, topicMarket, cfg) => {
  let best = 0;
  for (const t of topics) best = Math.max(best, topicGravity(topicMarket.get(t), cfg));
  return best;
};

// Weighted blend, renormalized over present signals (a missing signal ≠ zero).
export const combine = (signals, weights) => {
  let wsum = 0, acc = 0;
  for (const [k, v] of Object.entries(signals)) {
    if (v == null) continue;
    const w = weights[k] ?? 0;
    wsum += w; acc += w * v;
  }
  return wsum > 0 ? acc / wsum : 0;
};

// repos: [{ name, topics, language, stars }]. ctx: { topicMarket: Map, hist }.
export const scoreRepos = (repos, ctx, cfg) => {
  const traction = logNorm(repos.map((r) => r.stars));
  return repos
    .map((r, i) => {
      const signals = {
        gravity: repoGravity(r.topics, ctx.topicMarket, cfg),
        alignment: alignmentScore(r, ctx.hist, cfg),
        traction: traction[i],
      };
      const primaryTopic = r.topics[0] ?? null;
      return {
        name: r.name, score: combine(signals, cfg.weights), signals,
        stars: r.stars, primaryTopic,
        primaryGravity: primaryTopic ? topicGravity(ctx.topicMarket.get(primaryTopic), cfg) : 0,
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
};

export const suggestFeatured = (scored, n) => scored.slice(0, n).map((s) => s.name).join(",");

// Your most-starred topics, priced by market gravity — "the markets you actually follow".
export const marketMap = (hist, topicMarket, cfg) => {
  const max = maxVal(hist.topics);
  return [...hist.topics.entries()]
    .map(([topic, youStar]) => ({
      topic, youStar, affinity: max ? youStar / max : 0,
      gravity: topicGravity(topicMarket.get(topic), cfg),
      repos: topicMarket.get(topic)?.repos ?? null,
    }))
    .sort((a, b) => b.youStar - a.youStar);
};

// High-gravity topics you personally follow but DON'T tag your own work with → re-shelf here.
export const retagCandidates = (hist, topicMarket, usedTopics, cfg) => {
  const max = maxVal(hist.topics);
  return [...hist.topics.entries()]
    .filter(([t]) => !usedTopics.has(t))
    .map(([topic, youStar]) => {
      const gravity = topicGravity(topicMarket.get(topic), cfg);
      return { topic, youStar, gravity, score: (max ? youStar / max : 0) * gravity, repos: topicMarket.get(topic)?.repos ?? null };
    })
    .filter((c) => c.gravity > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.retagSuggestions);
};

// ---- IO (runs only when invoked directly; tests import the pure parts) -------

const loadConfig = (dir) => {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "value.config.json"), "utf8"));
    return { ...DEFAULT_CONFIG, ...raw, weights: { ...DEFAULT_CONFIG.weights, ...(raw.weights ?? {}) } };
  } catch { return DEFAULT_CONFIG; }
};

const gh = async (args) => {
  try { return (await pexec("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })).stdout; }
  catch { return null; }
};
const ghJson = async (args) => { const out = await gh(args); try { return out == null ? null : JSON.parse(out); } catch { return null; } };
const ghLines = async (args) => {
  const out = await gh(args);
  return out ? out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pool = async (items, size, fn) => {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
};

const listRepos = (owner, fields) =>
  ghJson(["repo", "list", owner, "--no-archived", "--source", "--visibility", "public", "--limit", "300", "--json", fields]);

// One search call per topic gets both breadth (total_count) and ceiling (top repo's stars).
// The Search API is rate-limited to ~30/min and returns 403 when exhausted; back off and
// retry so we never silently degrade gravity to 0 (the old failure mode).
const fetchTopicMarket = async (topic, tries = 3) => {
  for (let t = 0; ; t++) {
    const r = await ghJson(["api", `search/repositories?q=topic:${topic}&sort=stars&order=desc&per_page=1`,
      "--jq", "{repos: .total_count, topStars: (.items[0].stargazers_count // 0)}"]);
    if (r != null || t >= tries - 1) return r;
    await sleep(2500 * (t + 1)); // 2.5s, 5s — rides out a search-rate window
  }
};

// Topic-market sizes change slowly, so cache them to disk: re-runs (and dev loops) stay
// well under the search limit. TTL keeps them from going stale. `.value-cache.json` is gitignored.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const cachePath = (dir) => join(dir, ".value-cache.json");
const loadCache = (dir, nowMs) => {
  try {
    const c = JSON.parse(readFileSync(cachePath(dir), "utf8"));
    const fresh = {};
    for (const [k, v] of Object.entries(c.topics ?? {})) if (nowMs - (v.ts ?? 0) < CACHE_TTL_MS) fresh[k] = v;
    return fresh;
  } catch { return {}; }
};
const saveCache = (dir, topics) => { try { writeFileSync(cachePath(dir), JSON.stringify({ topics }, null, 2)); } catch {} };

const main = async () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const cfg = loadConfig(dir);
  const nowMs = Date.now();
  const user = process.env.GH_USER || "bdelanghe";
  const asJson = process.argv.includes("--json");
  const orgs = (process.env.ORGS || "").split(",").map((s) => s.trim()).filter(Boolean);

  // Corpus: public, non-fork, non-archived repos of the user + orgs, minus meta repos.
  // --visibility public is the gate; we re-assert on the returned visibility as a belt.
  const fields = "name,nameWithOwner,repositoryTopics,stargazerCount,primaryLanguage,visibility";
  const lists = await Promise.all([user, ...orgs].map((o) => listRepos(o, fields)));
  if (!lists[0]) { console.error("✗ could not list repos (is `gh` authenticated?)"); process.exit(1); }
  const isMeta = (n) => n.toLowerCase() === user.toLowerCase() || n === ".github";
  const seen = new Set();
  const repos = lists.filter(Boolean).flat()
    .filter((r) => String(r.visibility).toLowerCase() === "public")          // never private
    .filter((r) => (seen.has(r.nameWithOwner) ? false : (seen.add(r.nameWithOwner), true)))
    .filter((r) => !isMeta(r.name))
    .map((r) => ({
      name: r.name,
      topics: (r.repositoryTopics || []).map((t) => t.name),
      language: r.primaryLanguage?.name ?? null,
      stars: r.stargazerCount ?? 0,
    }));

  // Your outbound stars (PUBLIC only — private starred repos are filtered out in jq).
  const starred = await ghLines(["api", `users/${user}/starred?per_page=100`, "--paginate",
    "--jq", ".[] | select(.private == false) | {topics: .topics, language: .language}"]);
  const hist = starHistogram(starred);

  // Price the topic-markets we need: every topic your repos use, plus your top starred topics
  // (for the market map / re-tag suggestions). Capped to stay under the search rate limit.
  const repoTopics = new Set(repos.flatMap((r) => r.topics));
  const topStarredTopics = [...hist.topics.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, cfg.starredTopicsToMarket).map(([t]) => t);
  let toPrice = [...new Set([...repoTopics, ...topStarredTopics])];
  const truncated = toPrice.length > cfg.maxTopicFetches;
  if (truncated) toPrice = toPrice.slice(0, cfg.maxTopicFetches);

  // Serve from cache; fetch only the misses, throttled (pool 3) with per-call backoff.
  const refresh = process.argv.includes("--refresh");
  const cache = refresh ? {} : loadCache(dir, nowMs);
  const misses = toPrice.filter((t) => !cache[t]);

  // Pre-flight: check the search bucket before burning quota (mirrors github-budget's
  // gateGhArgv pattern — gate before spend, not after a 403). One core-bucket call.
  if (misses.length > 0) {
    const rl = await ghJson(["api", "rate_limit"]);
    const sb = rl?.resources?.search;
    if (sb) {
      const resetInMin = Math.ceil((sb.reset * 1000 - nowMs) / 60_000);
      if (sb.remaining < 5) {
        console.error(`✗ search budget exhausted (${sb.remaining}/${sb.limit}) — resets in ${resetInMin}m. Re-run after the window or use cached data.`);
        process.exit(1);
      }
      if (sb.remaining < misses.length + 10)
        console.error(`⚠ search budget tight: ${sb.remaining}/${sb.limit} remaining, need ${misses.length} — resets in ${resetInMin}m`);
    }
  }

  const fetched = await pool(misses, 3, fetchTopicMarket);
  misses.forEach((t, i) => { if (fetched[i]) cache[t] = { ...fetched[i], ts: nowMs }; });
  saveCache(dir, cache);

  const topicMarket = new Map(toPrice.map((t) => [t, cache[t] || null]).filter(([, v]) => v));
  const degraded = toPrice.filter((t) => !topicMarket.has(t));
  if (degraded.length) console.error(`⚠ gravity unavailable for ${degraded.length}/${toPrice.length} topics (search rate limit?) — re-run to fill cache: ${degraded.slice(0, 8).join(", ")}${degraded.length > 8 ? "…" : ""}`);

  const scored = scoreRepos(repos, { topicMarket, hist }, cfg);

  if (asJson) {
    console.log(JSON.stringify({ user, scored, marketMap: marketMap(hist, topicMarket, cfg), retag: retagCandidates(hist, topicMarket, repoTopics, cfg) }, null, 2));
    return;
  }

  const cell = (v) => (v == null ? "  --" : v.toFixed(2).padStart(4));
  console.log(`\n  VALUE — @${user}: ${scored.length} repos · ${starred.length} stars analyzed · ${topicMarket.size} topic-markets priced${truncated ? " (capped)" : ""}\n`);
  console.log(`  ${"repo".padEnd(24)} score  grav algn trac  primary topic (market)`);
  for (const s of scored) {
    const g = s.signals;
    const market = s.primaryTopic ? `${s.primaryTopic} (${topicMarket.get(s.primaryTopic)?.repos ?? "?"} repos, g=${s.primaryGravity.toFixed(2)})` : "—";
    console.log(`  ${s.name.padEnd(24)} ${s.score.toFixed(3)} ${cell(g.gravity)} ${cell(g.alignment)} ${cell(g.traction)}  ${market}`);
  }

  console.log(`\n  YOUR MARKET — top topics you star, priced by gravity`);
  for (const m of marketMap(hist, topicMarket, cfg).slice(0, 10))
    console.log(`  ${m.topic.padEnd(24)} ${m.youStar} stars · g=${m.gravity.toFixed(2)}${m.repos != null ? ` · ${m.repos} repos` : ""}`);

  const retag = retagCandidates(hist, topicMarket, repoTopics, cfg);
  if (retag.length) {
    console.log(`\n  RE-SHELF — high-gravity topics you follow but don't tag your work with:`);
    for (const c of retag) console.log(`  ${c.topic.padEnd(24)} you star ${c.youStar} · g=${c.gravity.toFixed(2)}${c.repos != null ? ` · ${c.repos} repos` : ""}`);
  }

  const misShelved = scored.filter((s) => s.primaryTopic && s.primaryGravity < cfg.lowGravity);
  if (misShelved.length) {
    console.log(`\n  MIS-SHELVED — strong-ish repos on a low-gravity (near-invisible) primary topic:`);
    for (const s of misShelved.slice(0, 8)) console.log(`  ${s.name.padEnd(24)} ${s.primaryTopic} (g=${s.primaryGravity.toFixed(2)})`);
  }

  console.log(`\n  Suggested:  FEATURED=${suggestFeatured(scored, cfg.featuredCount)}\n`);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
