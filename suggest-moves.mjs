#!/usr/bin/env node
// suggest-moves — propose which personal repos are candidates to move into an org,
// by mission fit. Deterministic rules: a candidate has an on-mission signal and no
// personal signal. It PROPOSES; you curate — move-candidacy is a human decision
// (the rules miss things like hooksmith and over-match things like ai-home, which
// is exactly why the final call stays yours).
//
//   GH_USER=bdelanghe node suggest-moves.mjs
import { execFileSync } from "node:child_process";

const user = process.env.GH_USER || "bdelanghe";
const repos = JSON.parse(
  execFileSync("gh", ["repo", "list", user, "--no-archived", "--source", "--limit", "200", "--json", "name,description,repositoryTopics"], { encoding: "utf8" }),
);

// on-mission: capability security / contracts / provenance / agent infra / build substrate
const MISSION_TOPIC = new Set(["capability-security", "agent-infra", "infrastructure"]);
const MISSION = /capabilit|contract|provenance|attestation|signed|ocap|slsa|sandbox|seam|polic(y|ies)|schema|devcontainer|registry|traceab|bounded|\bagent|verbspec|round-?trip|ast-based|fidelity|lefthook|wasm|\bhooks?\b/i;
// personal: configs / portfolio / data / learning / games — never move
const PERSONAL = /dotfile|home.?manager|nix-darwin|chezmoi|yadm|\bprofile\b|portfolio|obsidian|vault|kaggle|finance|resume|sudoku|hacker.?rank|hello.?world|notebook|pocket|follow|contact|trie|terraform|mars|\bgame\b|slide|macos|clean.?install|ai.?home|home skills|\bconfigs?\b/i;

const candidates = [];
for (const r of repos) {
  const topics = (r.repositoryTopics || []).map((t) => t.name);
  const blob = `${r.name} ${r.description || ""} ${topics.join(" ")}`.toLowerCase();
  if (PERSONAL.test(blob)) continue;
  const onTopic = topics.some((t) => MISSION_TOPIC.has(t));
  const onKw = MISSION.test(blob);
  if (!onTopic && !onKw) continue;
  candidates.push({
    name: r.name,
    score: (onTopic ? 2 : 0) + (onKw ? 1 : 0),
    why: [onTopic && "on-mission topic", onKw && "mission keyword"].filter(Boolean).join(" + "),
    desc: (r.description || "").slice(0, 72),
    topics: topics.join(","),
  });
}
candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

console.log(`\n  bounded-systems move candidates for @${user} (${candidates.length}) — propose, then curate\n`);
for (const c of candidates) {
  console.log(`  [${c.score}] ${c.name.padEnd(22)} ${c.why}`);
  console.log(`      ${c.desc}${c.topics ? `  [${c.topics}]` : ""}`);
}
console.log("");
