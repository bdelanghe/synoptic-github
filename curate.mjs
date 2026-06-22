#!/usr/bin/env node
// curate — give every repo a disposition so none is purposeless. Deterministic;
// proposes, you decide. Dispositions (cf. @bounded-systems/disposition):
//   move    → on-mission, belongs in the org
//   keep    → active, clear purpose, stays personal
//   archive → learning/throwaway/superseded/no ongoing purpose
//   review  → thin + stale; a human should look
//
//   GH_USER=bdelanghe node curate.mjs
import { execFileSync } from "node:child_process";

const user = process.env.GH_USER || "bdelanghe";
const repos = JSON.parse(
  execFileSync("gh", ["repo", "list", user, "--no-archived", "--source", "--limit", "300", "--json", "name,description,repositoryTopics,pushedAt"], { encoding: "utf8" }),
);
const now = Date.now();
const monthsOld = (d) => (now - Date.parse(d)) / (1000 * 60 * 60 * 24 * 30.4);

// active personal config / identity — always keep
const KEEP = /dotfile|home-?manager|nix-darwin|chezmoi|yadm|^bdelanghe$|^site$|claude-skills/i;
// on-mission → org
const MISSION_TOPIC = new Set(["capability-security", "agent-infra", "infrastructure"]);
const MISSION = /capabilit|contract|provenance|attestation|signed|ocap|slsa|sandbox|seam|polic(y|ies)|schema-|devcontainer|registry|traceab|bounded|\bagent|verbspec|round-?trip|ast-based|fidelity|lefthook|wasm|hooksmith/i;
// personal domains that should never be "move" even if a keyword matches
const PERSONAL = /obsidian|vault|json-?ld|ai-?home|kaggle|finance|portfolio|\bgame\b/i;
// clearly done / throwaway → archive
const THROWAWAY_NAME = /hello-?world|^trie|c4-|gen-py|thanos|pocket|follow-?for-?follow|lst-contact|airtable|slow-dict|hacker-?rank|sudoku|terraform|mars|recurse-contacts|^new$|syboptic|^re-cursor$|overengineer|warehouse/i;
const THROWAWAY_DESC = /^'|figuring out|solving|first attempt|exclusively|pairing session|move recurse|beat josh/i;

const disp = [];
for (const r of repos) {
  const topics = (r.repositoryTopics || []).map((t) => t.name);
  const blob = `${r.name} ${r.description || ""} ${topics.join(" ")}`.toLowerCase();
  const stale = monthsOld(r.pushedAt) > 12;
  const thin = !r.description;
  let d, why;
  if (KEEP.test(r.name)) { d = "keep"; why = "active config / identity"; }
  else if (!THROWAWAY_NAME.test(r.name) && !THROWAWAY_DESC.test(r.description || "") && !PERSONAL.test(blob) && (topics.some((t) => MISSION_TOPIC.has(t)) || MISSION.test(blob))) { d = "move"; why = "on-mission signal"; }
  else if (THROWAWAY_NAME.test(r.name) || THROWAWAY_DESC.test(r.description || "") || topics.includes("game") || topics.includes("learning")) { d = "archive"; why = "learning / throwaway / done"; }
  else if (thin && stale) { d = "review"; why = `no description, ${Math.round(monthsOld(r.pushedAt))}mo stale`; }
  else { d = "keep"; why = "has a stated purpose"; }
  disp.push({ name: r.name, d, why, age: Math.round(monthsOld(r.pushedAt)), desc: (r.description || "—").slice(0, 64) });
}

const order = { move: 0, review: 1, archive: 2, keep: 3 };
disp.sort((a, b) => order[a.d] - order[b.d] || a.name.localeCompare(b.name));
const count = (k) => disp.filter((x) => x.d === k).length;
console.log(`\n  CURATION — @${user}: ${count("move")} move · ${count("review")} review · ${count("archive")} archive · ${count("keep")} keep\n`);
let last = "";
for (const x of disp) {
  if (x.d !== last) { console.log(`  ── ${x.d.toUpperCase()} ──`); last = x.d; }
  console.log(`  ${x.name.padEnd(24)} ${x.age}mo  ${x.why}`);
}
console.log("");
