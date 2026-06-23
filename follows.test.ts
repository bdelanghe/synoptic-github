// Tests for the pure scoring layer of follows.mjs. No network/gh.
import { test, expect } from "bun:test";
import { DEFAULT_CONFIG, userProfile, classifyFollows } from "./follows.mjs";
import { starHistogram } from "./value.mjs";
import { exportJsonl } from "./lists.mjs";

const cfg = DEFAULT_CONFIG;

// Synthetic bet: the user builds capability-security + developer-tools things in TypeScript.
const betHist = starHistogram([
  ...Array(6).fill({ topics: ["capability-security"], language: "TypeScript" }),
  ...Array(4).fill({ topics: ["developer-tools"], language: "TypeScript" }),
]);

const repo = (topics, language = null) => ({ topics, language });
const follow = (login, bio, repos, followers = 0) => ({ login, name: login, bio, publicRepos: repos.length, followers, repos });

// ---- userProfile ---------------------------------------------------------------

test("userProfile: top topics sorted by frequency then name (stable, deterministic)", () => {
  const repos = [repo(["ai", "cli"]), repo(["ai", "developer-tools"]), repo(["cli"])];
  const p = userProfile("alice", "ai things", repos);
  expect(p.topics[0]).toBe("ai");       // freq=2, highest
  expect(p.topics[1]).toBe("cli");      // freq=2, same freq but "cli" < "developer-tools"
  expect(p.nameWithOwner).toBe("alice");
  expect(p.description).toBe("ai things");
});

test("userProfile: language = most common primary language across repos", () => {
  const repos = [repo(["ai"], "TypeScript"), repo([], "TypeScript"), repo([], "Rust")];
  const p = userProfile("alice", null, repos);
  expect(p.language).toBe("TypeScript");
});

test("userProfile: empty repos → empty topics, null language, empty description", () => {
  const p = userProfile("ghost", null, []);
  expect(p.topics).toEqual([]);
  expect(p.language).toBeNull();
  expect(p.description).toBe("");
});

test("userProfile: caps topics at 10", () => {
  const repos = Array.from({ length: 20 }, (_, i) => repo([`t${i}`]));
  expect(userProfile("x", null, repos).topics.length).toBe(10);
});

// ---- classifyFollows -----------------------------------------------------------

test("classifyFollows: topic-aligned follow → keep", () => {
  const follows = [follow("alice", null, [repo(["capability-security"]), repo(["developer-tools"])])];
  const out = classifyFollows(follows, betHist, cfg);
  expect(out[0].disposition).toBe("keep");
  expect(out[0].thesis).toBeGreaterThan(0);
});

test("classifyFollows: keyword in bio saves a user with no aligned topics", () => {
  const follows = [follow("bob", "building claude mcp agent harnesses", [repo(["cooking"])])];
  const out = classifyFollows(follows, betHist, cfg);
  expect(out[0].disposition).toBe("keep");
});

test("classifyFollows: keyword in login name is matched", () => {
  // thesisScore scans `nameWithOwner + description` — login doubles as nameWithOwner
  const follows = [follow("ocap-builder", null, [repo(["cooking"])])];
  const out = classifyFollows(follows, betHist, cfg);
  expect(out[0].disposition).toBe("keep");
});

test("classifyFollows: off-thesis → drop", () => {
  const follows = [follow("chef", "food recipes", [repo(["cooking"]), repo(["recipes"])])];
  const out = classifyFollows(follows, betHist, cfg);
  expect(out[0].disposition).toBe("drop");
});

test("classifyFollows: keeps sorted before drops, within keeps by thesis desc", () => {
  const follows = [
    follow("off",       "recipes",                   [repo(["cooking"])]),
    follow("on-weak",   "mcp sandbox",               [repo(["capability-security"])]),
    follow("on-strong", "ocap mcp claude subagent",  [repo(["capability-security"])]),
  ];
  const out = classifyFollows(follows, betHist, cfg);
  const keeps = out.filter((r) => r.disposition === "keep");
  const drops = out.filter((r) => r.disposition === "drop");
  expect(keeps.length).toBeGreaterThanOrEqual(1);
  expect(drops.map((r) => r.login)).toContain("off");
  // keeps come before drops in the output
  expect(out.indexOf(drops[0])).toBeGreaterThan(out.indexOf(keeps[keeps.length - 1]));
  // within keeps, rank_score (then thesis as tiebreaker) is non-increasing
  for (let i = 1; i < keeps.length; i++) {
    const prev = keeps[i - 1], curr = keeps[i];
    expect(prev.rank_score > curr.rank_score || (prev.rank_score === curr.rank_score && prev.thesis >= curr.thesis)).toBe(true);
  }
});

test("classifyFollows: output record has all required fields with correct types", () => {
  const follows = [follow("x", "bio text", [repo(["ai"], "TypeScript")], 500)];
  const r = classifyFollows(follows, betHist, cfg)[0];
  expect(r).toHaveProperty("login", "x");
  expect(r).toHaveProperty("name");
  expect(r).toHaveProperty("bio", "bio text");
  expect(r).toHaveProperty("url", "https://github.com/x");
  expect(r).toHaveProperty("repos_public");
  expect(r).toHaveProperty("followers", 500);
  expect(r).toHaveProperty("top_topics");
  expect(r).toHaveProperty("top_lang");
  expect(typeof r.thesis).toBe("number");
  expect(typeof r.rank_score).toBe("number");
  expect(["keep", "drop"]).toContain(r.disposition);
  expect(r.url).toMatch(/^https:\/\/github\.com\//);
});

test("rank_score increases with followers; higher-follower on-thesis follow sorts first", () => {
  const small = follow("a", "mcp agent", [repo(["capability-security"])], 100);
  const large = follow("b", "mcp agent", [repo(["capability-security"])], 10000);
  const out = classifyFollows([small, large], betHist, cfg);
  // large comes first (higher rank_score)
  expect(out[0].login).toBe("b");
  expect(out[0].rank_score).toBeGreaterThan(out[1].rank_score);
});

test("classifyFollows is deterministic", () => {
  const follows = [follow("alice", "mcp", [repo(["ai"])]), follow("bob", "food", [repo(["cooking"])])];
  expect(classifyFollows(follows, betHist, cfg)).toEqual(classifyFollows(follows, betHist, cfg));
});

// ---- exportJsonl (imported from lists.mjs — test the follows record shape) ----

test("exportJsonl round-trips follows records faithfully", () => {
  const follows = [follow("alice", "mcp agent", [repo(["capability-security"])])];
  const records = classifyFollows(follows, betHist, cfg);
  const lines = exportJsonl(records).trim().split("\n");
  expect(lines.length).toBe(records.length);
  const obj = JSON.parse(lines[0]);
  expect(obj).toHaveProperty("login");
  expect(obj).toHaveProperty("disposition");
  expect(obj).toHaveProperty("top_topics");
  expect(obj).toHaveProperty("thesis");
});
