// Tests for the pure scoring layer of value.mjs (star-driven model). No network/gh.
import { test, expect } from "bun:test";
import {
  DEFAULT_CONFIG, logScale, logNorm, starHistogram, topicAffinity, langAffinity,
  alignmentScore, topicGravity, repoGravity, combine, scoreRepos, suggestFeatured,
  marketMap, retagCandidates,
} from "./value.mjs";

const cfg = DEFAULT_CONFIG;

// ---- logScale / logNorm ------------------------------------------------------
test("logScale compresses heavy tails to 0..1 against an absolute cap", () => {
  expect(logScale(0, 5)).toBe(0);
  expect(logScale(99999, 5)).toBeCloseTo(1, 1);   // ~10^5 ⇒ ~1
  expect(logScale(10 ** 6, 5)).toBe(1);           // clamped
  expect(logScale(null, 5)).toBe(0);
  expect(logScale(99, 5)).toBeLessThan(logScale(9999, 5));
});

test("logNorm scales relative to the corpus max, nulls treated as 0", () => {
  const [a, b, c] = logNorm([0, 9, 99]);
  expect(a).toBe(0);
  expect(c).toBe(1);
  expect(b).toBeGreaterThan(0);
  expect(b).toBeLessThan(1);
  expect(logNorm([0, 0])).toEqual([0, 0]);
  expect(logNorm([null, 9])[0]).toBe(0);
});

// ---- starHistogram -----------------------------------------------------------
test("starHistogram counts topics and languages across your stars", () => {
  const h = starHistogram([
    { topics: ["ai", "cli"], language: "Rust" },
    { topics: ["ai"], language: "Go" },
    { topics: [], language: "Rust" },
  ]);
  expect(h.topics.get("ai")).toBe(2);
  expect(h.topics.get("cli")).toBe(1);
  expect(h.langs.get("Rust")).toBe(2);
  expect(h.langs.get("Go")).toBe(1);
});

// ---- affinity / alignment ----------------------------------------------------
const richHist = starHistogram([
  ...Array(10).fill({ topics: ["ai"], language: "TypeScript" }),
  ...Array(4).fill({ topics: ["cli"], language: "Go" }),
  ...Array(2).fill({ topics: ["nix"], language: "Nix" }),
]);

test("topicAffinity is the repo's best topic relative to your most-starred topic", () => {
  expect(topicAffinity(["ai"], richHist)).toBeCloseTo(1, 5);        // ai is the max (10)
  expect(topicAffinity(["cli"], richHist)).toBeCloseTo(0.4, 5);     // 4/10
  expect(topicAffinity(["unknown"], richHist)).toBe(0);
  expect(topicAffinity(["unknown", "cli"], richHist)).toBeCloseTo(0.4, 5); // best of the two
  expect(topicAffinity([], richHist)).toBe(0);
});

test("langAffinity is your language pull, normalized", () => {
  expect(langAffinity("TypeScript", richHist)).toBeCloseTo(1, 5);   // 10 is max
  expect(langAffinity("Go", richHist)).toBeCloseTo(0.4, 5);
  expect(langAffinity(null, richHist)).toBe(0);
  expect(langAffinity("Cobol", richHist)).toBe(0);
});

test("alignmentScore blends topic and language affinity by config weight", () => {
  const s = alignmentScore({ topics: ["ai"], language: "Go" }, richHist, cfg);
  expect(s).toBeCloseTo(cfg.topicAffinityWeight * 1 + (1 - cfg.topicAffinityWeight) * 0.4, 5);
});

// ---- gravity -----------------------------------------------------------------
test("topicGravity blends ceiling (top-repo stars) and breadth (repo count); null → 0", () => {
  expect(topicGravity(null, cfg)).toBe(0);
  const big = topicGravity({ topStars: 200000, repos: 139000 }, cfg);
  const tiny = topicGravity({ topStars: 30, repos: 12 }, cfg);
  expect(big).toBeGreaterThan(0.9);
  expect(tiny).toBeLessThan(0.4);
  expect(big).toBeGreaterThan(tiny);
});

test("repoGravity is the best market any of the repo's topics reaches", () => {
  const market = new Map([["agent-infra", { topStars: 30, repos: 12 }], ["ai", { topStars: 200000, repos: 139000 }]]);
  expect(repoGravity(["agent-infra", "ai"], market, cfg)).toBe(topicGravity(market.get("ai"), cfg));
  expect(repoGravity(["nope"], market, cfg)).toBe(0);
  expect(repoGravity([], market, cfg)).toBe(0);
});

// ---- combine -----------------------------------------------------------------
test("combine renormalizes weights over present signals", () => {
  expect(combine({ a: 1, b: 0 }, { a: 0.5, b: 0.5 })).toBeCloseTo(0.5, 5);
  expect(combine({ a: 1, b: null }, { a: 0.5, b: 0.5 })).toBeCloseTo(1, 5);
  expect(combine({ a: null }, { a: 1 })).toBe(0);
});

// ---- scoreRepos --------------------------------------------------------------
const topicMarket = new Map([
  ["ai", { topStars: 200000, repos: 139000 }],
  ["cli", { topStars: 150000, repos: 97000 }],
  ["agent-infra", { topStars: 30, repos: 12 }],
]);
const ctx = { topicMarket, hist: richHist };

test("scoreRepos ranks a high-gravity, high-alignment, starred repo first", () => {
  const repos = [
    { name: "niche", topics: ["agent-infra"], language: "Nix", stars: 0 },
    { name: "flagship", topics: ["ai"], language: "TypeScript", stars: 100 },
    { name: "solid", topics: ["cli"], language: "Go", stars: 3 },
  ];
  const scored = scoreRepos(repos, ctx, cfg);
  expect(scored[0].name).toBe("flagship");
  expect(scored.at(-1).name).toBe("niche");
  expect(scored[0].score).toBeGreaterThan(scored.at(-1).score);
  expect(scored[0].primaryTopic).toBe("ai");
});

test("scoreRepos sorts ties by name and is deterministic", () => {
  const repos = [
    { name: "b", topics: ["ai"], language: "TypeScript", stars: 5 },
    { name: "a", topics: ["ai"], language: "TypeScript", stars: 5 },
  ];
  const scored = scoreRepos(repos, ctx, cfg);
  expect(scored.map((s) => s.name)).toEqual(["a", "b"]);
  expect(scoreRepos(repos, ctx, cfg)).toEqual(scored);
});

test("scoreRepos sinks an untagged repo (gravity 0) below tagged ones", () => {
  const repos = [
    { name: "tagged", topics: ["cli"], language: "Go", stars: 0 },
    { name: "untagged", topics: [], language: "Go", stars: 0 },
  ];
  const scored = scoreRepos(repos, ctx, cfg);
  expect(scored[0].name).toBe("tagged");
  expect(scored.find((s) => s.name === "untagged").signals.gravity).toBe(0);
});

// ---- suggestFeatured / marketMap / retagCandidates ---------------------------
test("suggestFeatured emits the top-N names", () => {
  expect(suggestFeatured([{ name: "a" }, { name: "b" }, { name: "c" }], 2)).toBe("a,b");
});

test("marketMap ranks your starred topics by how often you star them, priced by gravity", () => {
  const mm = marketMap(richHist, topicMarket, cfg);
  expect(mm[0].topic).toBe("ai");            // most-starred
  expect(mm[0].youStar).toBe(10);
  expect(mm[0].gravity).toBeGreaterThan(0);
  expect(mm.find((m) => m.topic === "nix").gravity).toBe(0); // nix not priced → gravity 0
});

test("retagCandidates surfaces high-gravity topics you follow but don't tag your repos with", () => {
  const used = new Set(["agent-infra"]);             // your repos only use the niche topic
  const cands = retagCandidates(richHist, topicMarket, used, cfg);
  expect(cands.map((c) => c.topic)).toContain("ai"); // you star ai heavily + it's high gravity
  expect(cands.every((c) => !used.has(c.topic))).toBe(true);
  expect(cands.every((c) => c.gravity > 0)).toBe(true); // unpriced topics (nix) excluded
});
