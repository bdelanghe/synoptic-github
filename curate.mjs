#!/usr/bin/env node
// curate — give every repo a disposition so none is purposeless. Deterministic;
// proposes, you decide. Dispositions (cf. @bounded-systems/disposition):
//   move    → on-mission, belongs in the org
//   keep    → active, clear purpose, stays personal
//   archive → learning/throwaway/superseded/no ongoing purpose
//   review  → thin + stale; a human should look
//
//   GH_USER=bdelanghe node curate.mjs
//
// The classifier (disposition/classify) is a pure function of the repo metadata
// and a clock — unit-tested in curate.test.ts. The gh fetch + print run only
// when the file is invoked directly.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.4;
export const monthsOld = (d, nowMs) => (nowMs - Date.parse(d)) / MS_PER_MONTH;

const STALE_MONTHS = 12;    // gates `move` and thin+stale review
const ANCIENT_MONTHS = 48;  // 4yr untouched + has a description → surface for review

// active personal config / identity — always keep
const KEEP = /dotfile|home-?manager|nix-darwin|chezmoi|yadm|^bdelanghe$|^site$|claude-skills/i;
// Featured on the profile README (mirror the `featured:` input in
// bdelanghe/bdelanghe/.github/workflows/readme.yml). Never propose move/archive
// for these — moving them blanks a pinned slot on the hiring surface.
const FEATURED = new Set(["ssh-doctor", "first-pass", "git-tidy", "synoptic-github"]);
// on-mission → org. Topics count ONLY via this explicit allowlist; they are NOT
// folded into the MISSION regex (generic discovery topics like agents/ai-agent,
// added for SEO, must not masquerade as a thesis signal).
const MISSION_TOPIC = new Set(["capability-security", "agent-infra", "infrastructure"]);
// Thesis-specific phrasing only. Deliberately NARROW: generic developer-tooling
// words (agent, registry, signed, contract, schema-, wasm, sandbox, …) appear in
// any engineer's repos and must not promote one into the flagship org by themselves.
const MISSION = /capabilit|ocap|provenance|attestation|\bslsa\b|verbspec|bounded[- ]?(authorit|system)|capability[- ]?secur|scoped[- ]?(door|capabilit)|\bdoor-(keeper|scout|net|concierge|kit|peercred)\b|guest-room/i;
// personal domains that should never be "move" even if a keyword matches
const PERSONAL = /obsidian|vault|json-?ld|ai-?home|kaggle|finance|portfolio|\bgame\b/i;
// clearly done / throwaway → archive
const THROWAWAY_NAME = /hello-?world|^trie|c4-|gen-py|thanos|pocket|follow-?for-?follow|lst-contact|airtable|slow-dict|hacker-?rank|sudoku|terraform|mars|recurse-contacts|^new$|syboptic|^re-cursor$|overengineer|warehouse/i;
const THROWAWAY_DESC = /^'|figuring out|solving|first attempt|exclusively|pairing session|move recurse|beat josh/i;

// Pure: classify one repo. `nowMs` is injected so the result is deterministic.
// Returns { name, d, why, age, desc }.
export const disposition = (r, nowMs) => {
  const topics = (r.repositoryTopics || []).map((t) => t.name);
  const blob = `${r.name} ${r.description || ""} ${topics.join(" ")}`.toLowerCase();
  const text = `${r.name} ${r.description || ""}`.toLowerCase(); // MISSION reads name+desc only, never topics
  const age = monthsOld(r.pushedAt, nowMs);
  const stale = age > STALE_MONTHS;
  const thin = !r.description;
  // A mission match must not override clear abandonment: a dead (stale) or
  // throwaway repo is never promoted into the org. Topics count only via the
  // MISSION_TOPIC allowlist; MISSION matches name+desc, never topics.
  const onMission = !stale && !THROWAWAY_NAME.test(r.name) && !THROWAWAY_DESC.test(r.description || "")
    && !PERSONAL.test(blob) && (topics.some((t) => MISSION_TOPIC.has(t)) || MISSION.test(text));
  let d, why;
  if (KEEP.test(r.name)) { d = "keep"; why = "active config / identity"; }
  else if (FEATURED.has(r.name)) { d = "keep"; why = "featured on profile README"; }
  else if (onMission) { d = "move"; why = "on-mission signal"; }
  else if (THROWAWAY_NAME.test(r.name) || THROWAWAY_DESC.test(r.description || "") || topics.includes("game") || topics.includes("learning") || topics.includes("experiment")) { d = "archive"; why = "learning / throwaway / experiment / done"; }
  else if (thin && stale) { d = "review"; why = `no description, ${Math.round(age)}mo stale`; }
  else if (age > ANCIENT_MONTHS) { d = "review"; why = `${Math.round(age)}mo untouched — keep or archive?`; }
  else { d = "keep"; why = "has a stated purpose"; }
  return { name: r.name, d, why, age: Math.round(age), desc: (r.description || "—").slice(0, 64) };
};

const ORDER = { move: 0, review: 1, archive: 2, keep: 3 };
// Pure: classify every repo and sort move → review → archive → keep, then name.
export const classify = (repos, nowMs) =>
  repos.map((r) => disposition(r, nowMs)).sort((a, b) => ORDER[a.d] - ORDER[b.d] || a.name.localeCompare(b.name));

// ---- IO (runs only when invoked directly) -------------------------------------
const main = () => {
  const user = process.env.GH_USER || "bdelanghe";
  const repos = JSON.parse(
    execFileSync("gh", ["repo", "list", user, "--no-archived", "--source", "--limit", "300", "--json", "name,description,repositoryTopics,pushedAt"], { encoding: "utf8" }),
  );
  const disp = classify(repos, Date.now());
  const count = (k) => disp.filter((x) => x.d === k).length;
  console.log(`\n  CURATION — @${user}: ${count("move")} move · ${count("review")} review · ${count("archive")} archive · ${count("keep")} keep\n`);
  let last = "";
  for (const x of disp) {
    if (x.d !== last) { console.log(`  ── ${x.d.toUpperCase()} ──`); last = x.d; }
    console.log(`  ${x.name.padEnd(24)} ${x.age}mo  ${x.why}`);
  }
  console.log("");
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
