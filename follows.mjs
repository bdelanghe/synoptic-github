#!/usr/bin/env node
// follows.mjs — thesis-aligned follow curation. Mirrors the star-prune pipeline in
// lists.mjs: score each followed user by the aggregate topic/lang profile of their public
// repos, archive to JSONL, then unfollow drops. The bet: capability-security / agent-infra
// / ai / developer-tools.
//
// --export <file>  score all follows → JSONL archive (read-only, no mutations)
// --prune  <file>  unfollow disposition:"drop" users from an existing archive
// --limit  <n>     cap unfollow mutations per run (default: all drops)
// --apply --yes    required for mutations; dry-run otherwise
//
// GH_USER=bdelanghe ORGS=bounded-systems node follows.mjs --export follows.jsonl
// GH_USER=bdelanghe node follows.mjs --prune follows.jsonl --apply --yes --limit 50

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { starHistogram } from "./value.mjs";
import { thesisScore, exportJsonl, DEFAULT_CONFIG as LISTS_CFG } from "./lists.mjs";
const pexec = promisify(execFile);

export const DEFAULT_CONFIG = {
  betKeywords: LISTS_CFG.betKeywords,        // shared with star curation
  thesisKeepAlign: LISTS_CFG.thesisKeepAlign, // same alignment threshold
  maxRepoSample: 30,                          // public repos to fetch per user
};

// ---- pure (unit-tested in follows.test.ts) ------------------------------------

// Reduce a user's public repos to the profile shape thesisScore() expects.
// topics = top-10 most-frequent topics across their repos (freq-desc, name-asc tiebreak).
// language = most common primary language across their repos.
export const userProfile = (login, bio, repos) => {
  const topicFreq = {}, langFreq = {};
  for (const r of repos) {
    for (const t of (r.topics || [])) topicFreq[t] = (topicFreq[t] || 0) + 1;
    if (r.language) langFreq[r.language] = (langFreq[r.language] || 0) + 1;
  }
  const topics = Object.entries(topicFreq)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10).map(([t]) => t);
  const language = Object.entries(langFreq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { nameWithOwner: login, description: bio || "", topics, language };
};

// Score + classify a list of enriched follows. Each element must have:
//   { login, name, bio, publicRepos, followers, repos: [{topics, language}] }
// Returns records sorted keep-first, then by rank_score desc within each bucket.
// rank_score = thesis × log10(followers+1) — surfaces high-influence on-thesis people.
export const classifyFollows = (follows, betHist, cfg) =>
  follows
    .map((f) => {
      const profile = userProfile(f.login, f.bio, f.repos);
      const t = thesisScore(profile, betHist, cfg.betKeywords);
      const keep = t.kw > 0 || t.align >= cfg.thesisKeepAlign;
      const followers = f.followers ?? 0;
      const rankScore = Number((t.score * Math.log10(followers + 1)).toFixed(3));
      return {
        login: f.login,
        name: f.name || f.login,
        bio: f.bio ?? null,
        url: `https://github.com/${f.login}`,
        repos_public: f.publicRepos ?? 0,
        followers,
        top_topics: profile.topics.slice(0, 5),
        top_lang: profile.language,
        thesis: Number(t.score.toFixed(3)),
        rank_score: rankScore,
        disposition: keep ? "keep" : "drop",
      };
    })
    .sort((a, b) =>
      a.disposition === b.disposition
        ? b.rank_score - a.rank_score || b.thesis - a.thesis
        : a.disposition === "keep" ? -1 : 1,
    );

// ---- IO (runs only when invoked directly) -------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ghJson = (...args) =>
  pexec("gh", args, { encoding: "utf8", maxBuffer: 64e6 }).then((r) => JSON.parse(r.stdout));

// The "bet" = what you build: your own + ORGS public, non-fork repo topics/languages.
// (Replicated from lists.mjs — both tools build the same bet histogram independently.)
const fetchOwnTopics = async (user) => {
  const orgs = (process.env.ORGS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const owner of [user, ...orgs]) {
    try {
      const repos = await ghJson("repo", "list", owner,
        "--no-archived", "--source", "--visibility", "public",
        "--limit", "300", "--json", "repositoryTopics,primaryLanguage,visibility");
      for (const r of repos)
        out.push({ topics: (r.repositoryTopics || []).map((t) => t.name), language: r.primaryLanguage?.name ?? null });
    } catch {}
  }
  return out;
};

// Paginate /user/following manually (simple user objects: login, html_url, type).
const fetchFollowingLogins = async () => {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await ghJson("api", `user/following?per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
};

// Fetch a user's public repos (public only — never private).
const fetchUserRepos = async (login, maxSample) => {
  try {
    return await ghJson("repo", "list", login,
      "--source", "--no-archived", "--visibility", "public",
      "--limit", String(maxSample),
      "--json", "repositoryTopics,primaryLanguage");
  } catch {
    return []; // no public repos or transient error → score as 0
  }
};

const normalizeRepo = (r) => ({
  topics: (r.repositoryTopics || []).map((t) => t.name),
  language: r.primaryLanguage?.name ?? null,
});

// Unfollow a single user via REST DELETE.
const unfollow = async (login) => {
  try {
    await pexec("gh", ["api", "--method", "DELETE", `/user/following/${login}`], { encoding: "utf8" });
    return true;
  } catch {
    console.error(`  ✗ unfollow ${login} failed`);
    return false;
  }
};

const main = async () => {
  const user = process.env.GH_USER || "bdelanghe";
  const argVal = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
  const apply = process.argv.includes("--apply");
  const yes = process.argv.includes("--yes");
  const limit = Number(argVal("--limit")) || 0;
  const exportFile = argVal("--export");
  const pruneFile = argVal("--prune");
  const cfg = DEFAULT_CONFIG;

  if (exportFile) {
    console.log("  fetching following list…");
    const following = await fetchFollowingLogins();
    if (!following.length) { console.error("✗ no follows found (is `gh` authenticated?)"); process.exit(1); }
    console.log(`  ${following.length} follows — fetching user details + repo profiles (${cfg.maxRepoSample} repos/user)…`);

    const enriched = [];
    for (const f of following) {
      // Parallel: user details (bio, public_repos count) + repo list
      const [details, rawRepos] = await Promise.all([
        pexec("gh", ["api", `/users/${f.login}`], { encoding: "utf8", maxBuffer: 1e6 })
          .then((r) => JSON.parse(r.stdout))
          .catch(() => ({ name: f.login, bio: null, public_repos: 0 })),
        fetchUserRepos(f.login, cfg.maxRepoSample),
      ]);
      enriched.push({
        login: f.login,
        name: details.name || f.login,
        bio: details.bio || null,
        publicRepos: details.public_repos || 0,
        followers: details.followers || 0,
        repos: rawRepos.map(normalizeRepo),
      });
      if (enriched.length % 10 === 0) process.stdout.write(`  … ${enriched.length}/${following.length}\r`);
      await sleep(100); // light throttle between users (reads are generous but 195×concurrent hits secondary limits)
    }
    process.stdout.write("\n");

    const betHist = starHistogram(await fetchOwnTopics(user));
    const records = classifyFollows(enriched, betHist, cfg);
    const keep = records.filter((r) => r.disposition === "keep").length;
    writeFileSync(exportFile, exportJsonl(records));
    console.log(`✓ archived ${records.length} follows → ${exportFile} · keep ${keep} · drop ${records.length - keep}`);
    return;
  }

  if (pruneFile) {
    const archived = readFileSync(pruneFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const drops = archived.filter((r) => r.disposition === "drop");
    const cap = limit || drops.length;
    if (!(apply && yes)) {
      console.log(`  --prune: would unfollow ${drops.length} drop(s) from ${pruneFile}. Add --apply --yes (and --limit N to cap).`);
      return;
    }
    const batch = drops.slice(0, cap);
    console.log(`  UNFOLLOWING ${batch.length} of ${drops.length} drops (throttled ~1.5s/call) …`);
    let n = 0;
    for (const r of batch) {
      if (await unfollow(r.login)) n++;
      await sleep(1500);
    }
    const remain = drops.length - cap;
    console.log(`  − unfollowed ${n}${remain > 0 ? ` · ${remain} remain (re-run to continue)` : " · done"}`);
    return;
  }

  // default: show counts and usage hint
  console.log("  fetching following list…");
  const following = await fetchFollowingLogins();
  console.log(`\n  FOLLOWS — ${following.length} accounts you follow`);
  console.log(`  Run --export <file> to score and archive, then --prune <file> --apply --yes to unfollow drops.\n`);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
