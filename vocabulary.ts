// The controlled topic vocabulary — the org-level contract, plus a deterministic
// suggester. Keyword rules (not an LLM) so suggestions are reproducible.
import { z } from "zod";
import type { Repo } from "./schema.ts";

/** Allowed topics. Repos may only carry these; `validate` flags anything else. */
export const TOPICS = [
  "agent-infra", "capability-security", "developer-tools", "cli", "library",
  "github-actions", "nix", "devcontainers", "design-tokens", "state-machines",
  "web", "data-viz", "ai", "game", "algorithms", "learning", "experiment", "infrastructure",
] as const;

export const Topic = z.enum(TOPICS).describe("A topic from the controlled vocabulary.");
export type Topic = z.infer<typeof Topic>;

/** Deterministic suggestion rules: a topic applies if any keyword is a substring
 *  of the repo's name + description + language (lowercased). Order = priority. */
const RULES: ReadonlyArray<readonly [Topic, readonly string[]]> = [
  ["agent-infra", ["agent", "agentic"]],
  ["capability-security", ["capability", "ocap", "door", "provenance", "signed", "security", "access control"]],
  ["ai", ["llm", "claude", "gpt", "mcp", "copilot", " ai", "ai-", "ai "]],
  ["cli", ["cli", "command-line", "command line"]],
  ["github-actions", ["github action", "workflow", "ci/cd", "gha"]],
  ["nix", ["nix", "flake", "home-manager"]],
  ["devcontainers", ["devcontainer", "dev container"]],
  ["design-tokens", ["design token", "design system", "tokens", "brand"]],
  ["state-machines", ["xstate", "state machine", "state-machine"]],
  ["data-viz", ["data viz", "visualiz", "p5", "kaggle", "pipeline", "analysis", "dataset"]],
  ["game", ["game", "puzzle", "sudoku", "tic-tac-toe", "scrabble", "menace"]],
  ["algorithms", ["algorithm", "trie", "leetcode", "ctci", "sicp", "data structure"]],
  ["infrastructure", ["oci", "docker", "registry", "infra"]],
  ["devcontainers", ["devcontainer"]],
  ["library", ["library", "sdk", "schema", "spec", "runtime", "types for"]],
  ["developer-tools", ["git ", "git-", "developer", "devtool", "tooling", "lint", "resume"]],
  ["web", ["website", "site", "vite", "react", "web app", "portfolio", "webpage"]],
  ["learning", ["recurse", "exercise", "exploration", "interview prep", "book"]],
  ["experiment", ["experiment", "prototype", "demo", "overengineer", "tiny", "round-trip"]],
];

/** Suggest up to `max` topics for a repo, deterministically. */
export function suggestTopics(repo: Pick<Repo, "name" | "description" | "language">, max = 4): Topic[] {
  const hay = `${repo.name} ${repo.description ?? ""} ${repo.language ?? ""}`.toLowerCase();
  const hits: Topic[] = [];
  for (const [topic, keywords] of RULES) {
    if (hits.includes(topic)) continue;
    if (keywords.some((k) => hay.includes(k))) hits.push(topic);
  }
  return hits.slice(0, max);
}
