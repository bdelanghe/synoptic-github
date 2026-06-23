// Tests for the pure disposition layer of curate.mjs. No network/gh.
import { test, expect } from "bun:test";
import { disposition, classify } from "./curate.mjs";

// Fixed clock so `age`/`stale` are deterministic. 2026-06-23 in ms.
const NOW = Date.parse("2026-06-23T00:00:00Z");
const ago = (months: number) => new Date(NOW - months * 1000 * 60 * 60 * 24 * 30.4).toISOString();

const repo = (over: Record<string, unknown> = {}) => ({
  name: "thing",
  description: "a useful tool",
  repositoryTopics: [],
  pushedAt: ago(1),
  ...over,
});
const topics = (...names: string[]) => names.map((name) => ({ name }));
const d = (over: Record<string, unknown> = {}) => disposition(repo(over), NOW).d;

// ---- the topic-contamination regression (the bug this fix exists for) ---------

test("generic agent/ai discovery topics do NOT promote a repo to move", () => {
  // A personal repo whose ONLY 'agent' signal is SEO topics added for discovery.
  // It must not be flagged move — topics are not folded into the MISSION regex.
  expect(d({ name: "mcp-conversations-sqlite", description: "sqlite store for MCP history", pushedAt: ago(2),
    repositoryTopics: topics("agents", "ai-agent", "claude", "mcp") })).not.toBe("move");
  expect(d({ name: "first-pass", description: "resume builder CLI", pushedAt: ago(2),
    repositoryTopics: topics("agents", "ai-agent", "ai-agents") })).not.toBe("move");
});

test("MISSION matches name/description phrasing, never topics", () => {
  // thesis phrasing in the description → move
  expect(d({ name: "thing", description: "capability security for agents", pushedAt: ago(1) })).toBe("move");
  // same words present only as a topic string → NOT move
  expect(d({ name: "thing", description: "a tool", pushedAt: ago(1),
    repositoryTopics: topics("capability-security-related") })).not.toBe("move");
});

// ---- the MISSION_TOPIC allowlist (the sanctioned topic path) ------------------

test("an allowlisted topic still promotes to move", () => {
  expect(d({ name: "thing", description: "a tool", pushedAt: ago(1),
    repositoryTopics: topics("capability-security") })).toBe("move");
  expect(d({ name: "thing", description: "a tool", pushedAt: ago(1),
    repositoryTopics: topics("agent-infra") })).toBe("move");
});

// ---- featured veto ------------------------------------------------------------

test("featured repos are kept even with an on-mission signal", () => {
  const r = disposition(repo({ name: "first-pass", description: "capability security tool", pushedAt: ago(1) }), NOW);
  expect(r.d).toBe("keep");
  expect(r.why).toBe("featured on profile README");
});

// ---- stale gate ---------------------------------------------------------------

test("a stale on-mission repo is not promoted (abandonment beats mission)", () => {
  // fresh → move; stale → not move
  expect(d({ description: "ocap provenance library", pushedAt: ago(2) })).toBe("move");
  expect(d({ description: "ocap provenance library", pushedAt: ago(18) })).not.toBe("move");
});

// ---- the other branches still work --------------------------------------------

test("config/identity names keep", () => {
  expect(disposition(repo({ name: "dotfiles" }), NOW).why).toBe("active config / identity");
  expect(d({ name: "nix-darwin" })).toBe("keep");
});

test("throwaway names archive", () => {
  expect(d({ name: "hello-world", description: "first attempt" })).toBe("archive");
  expect(d({ name: "thing", repositoryTopics: topics("game") })).toBe("archive");
});

test("thin + stale → review", () => {
  expect(d({ description: "", pushedAt: ago(20) })).toBe("review");
});

test("personal-domain veto blocks move even on a mission keyword", () => {
  // 'kaggle' (personal) present → never move, even with thesis phrasing
  expect(d({ name: "imdb-kaggle", description: "capability security experiment", pushedAt: ago(1) })).not.toBe("move");
});

// ---- classify: ordering + totals ----------------------------------------------

test("classify sorts move → review → archive → keep, then by name", () => {
  const out = classify([
    repo({ name: "zeta", description: "ocap door kit", pushedAt: ago(1) }),       // move
    repo({ name: "dotfiles" }),                                                    // keep
    repo({ name: "hello-world", description: "first attempt" }),                   // archive
    repo({ name: "alpha", description: "ocap provenance", pushedAt: ago(1) }),     // move
  ], NOW);
  expect(out.map((x) => x.d)).toEqual(["move", "move", "archive", "keep"]);
  expect(out[0].name).toBe("alpha"); // move group sorted by name
  expect(out[1].name).toBe("zeta");
});
