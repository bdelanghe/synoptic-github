// Tests for the pure triage layer of lists.mjs. No network/gh.
import { test, expect } from "bun:test";
import { DEFAULT_CONFIG, ageYears, lowSignal, listFor, proposeLists, thesisScore, classify, exportJsonl } from "./lists.mjs";
import { starHistogram } from "./value.mjs";

const cfg = DEFAULT_CONFIG;
const NOW = Date.parse("2026-06-22T00:00:00Z");
const star = (over) => ({
  id: over.nameWithOwner, nameWithOwner: over.nameWithOwner ?? "o/r", isArchived: false,
  stars: 0, pushedAt: "2026-01-01T00:00:00Z", description: "a thing", language: null, topics: [], ...over,
});

// ---- ageYears ----------------------------------------------------------------
test("ageYears measures years from pushedAt against the injected now", () => {
  expect(ageYears("2025-06-22T00:00:00Z", NOW)).toBeCloseTo(1, 1);
  expect(ageYears("2020-06-22T00:00:00Z", NOW)).toBeCloseTo(6, 0);
  expect(ageYears(null, NOW)).toBe(0);
});

// ---- lowSignal ---------------------------------------------------------------
test("lowSignal flags archived, or untagged+undescribed+stale; spares the rest", () => {
  expect(lowSignal(star({ isArchived: true }), cfg, NOW)).toBe(true);
  expect(lowSignal(star({ topics: [], description: null, pushedAt: "2018-01-01T00:00:00Z" }), cfg, NOW)).toBe(true);
  // a topic OR a description OR recency rescues it
  expect(lowSignal(star({ topics: ["ai"], description: null, pushedAt: "2010-01-01T00:00:00Z" }), cfg, NOW)).toBe(false);
  expect(lowSignal(star({ topics: [], description: "useful", pushedAt: "2010-01-01T00:00:00Z" }), cfg, NOW)).toBe(false);
  expect(lowSignal(star({ topics: [], description: null, pushedAt: "2026-01-01T00:00:00Z" }), cfg, NOW)).toBe(false);
});

// ---- listFor -----------------------------------------------------------------
test("listFor picks the most-frequent topic, else lowercased language, else untagged", () => {
  const tf = new Map([["ai", 50], ["cli", 20], ["rust", 5]]);
  expect(listFor(star({ topics: ["rust", "ai"] }), tf)).toBe("ai");       // ai is more frequent
  expect(listFor(star({ topics: ["cli", "rust"] }), tf)).toBe("cli");
  expect(listFor(star({ topics: [], language: "Go" }), tf)).toBe("go");   // no topics → lowercased lang
  expect(listFor(star({ topics: [], language: null }), tf)).toBe("untagged");
});

// ---- proposeLists ------------------------------------------------------------
const many = (topic, n, over = {}) =>
  Array.from({ length: n }, (_, i) => star({ nameWithOwner: `o/${topic}-${i}`, topics: [topic], stars: i, ...over }));

test("proposeLists buckets by topic, folds small buckets into misc, separates unstar", () => {
  const stars = [
    ...many("ai", 15),
    ...many("cli", 12),
    ...many("obscure", 3),                                  // < minBucket → misc
    star({ nameWithOwner: "o/rare-lang", topics: [], language: "Cobol" }), // tiny → misc
    star({ nameWithOwner: "o/dead", isArchived: true }),                   // unstar
  ];
  const plan = proposeLists(stars, cfg, NOW);
  const labels = plan.lists.map((l) => l.label);
  expect(labels).toContain("ai");
  expect(labels).toContain("cli");
  expect(labels).toContain("misc");
  expect(labels).not.toContain("obscure");
  expect(plan.unstar.map((r) => r.nameWithOwner)).toEqual(["o/dead"]);
  // every kept star is filed into exactly one list (inbox → 0)
  expect(plan.lists.reduce((n, l) => n + l.items.length, 0)).toBe(plan.kept.length);
});

test("language buckets merge into the same-named topic list (no case duplicates)", () => {
  const stars = [
    ...many("python", 8),
    ...Array.from({ length: 8 }, (_, i) => star({ nameWithOwner: `o/pylang-${i}`, topics: [], language: "Python" })),
  ];
  const plan = proposeLists(stars, cfg, NOW);
  expect(plan.lists.map((l) => l.label).filter((l) => l.toLowerCase() === "python")).toEqual(["python"]);
  expect(plan.lists.find((l) => l.label === "python").items.length).toBe(16);
});

test("proposeLists: lists sorted by size desc, pinned are the top-starred kept repos", () => {
  const plan = proposeLists([...many("ai", 15), ...many("cli", 20)], cfg, NOW);
  expect(plan.lists[0].label).toBe("cli");            // 20 > 15
  expect(plan.pinned[0].stars).toBeGreaterThanOrEqual(plan.pinned.at(-1).stars);
  expect(plan.pinned.length).toBe(cfg.pinnedCount);
});

test("proposeLists caps the number of lists at maxLists (+ misc), folding the rest", () => {
  // 25 distinct topics each big enough to be a list; maxLists=20 keeps 20 + misc.
  const stars = Array.from({ length: 25 }, (_, k) => many(`t${String(k).padStart(2, "0")}`, cfg.minBucket)).flat();
  const plan = proposeLists(stars, cfg, NOW);
  expect(plan.lists.filter((l) => l.label !== "misc").length).toBeLessThanOrEqual(cfg.maxLists);
  expect(plan.lists.some((l) => l.label === "misc")).toBe(true);
  expect(plan.lists.reduce((n, l) => n + l.items.length, 0)).toBe(plan.kept.length);
});

test("proposeLists is deterministic", () => {
  const stars = [...many("ai", 15), ...many("cli", 12)];
  expect(proposeLists(stars, cfg, NOW)).toEqual(proposeLists(stars, cfg, NOW));
});

// ---- thesisScore / classify / exportJsonl ------------------------------------
const betHist = starHistogram([
  ...Array(6).fill({ topics: ["capability-security"], language: "TypeScript" }),
  ...Array(4).fill({ topics: ["developer-tools"], language: "TypeScript" }),
]);

test("thesisScore: keyword hits and topic-alignment to the bet both raise the score", () => {
  const onTopic = thesisScore(star({ nameWithOwner: "o/x", topics: ["capability-security"] }), betHist, cfg.betKeywords);
  const onKeyword = thesisScore(star({ nameWithOwner: "o/agent-thing", description: "an mcp agent harness" }), betHist, cfg.betKeywords);
  const off = thesisScore(star({ nameWithOwner: "o/plain", topics: ["cooking"], description: "recipes" }), betHist, cfg.betKeywords);
  expect(onTopic.align).toBeGreaterThan(0);
  expect(onKeyword.kw).toBeGreaterThanOrEqual(2);
  expect(off.score).toBe(0);
});

test("classify keeps on-thesis stars and drops the rest; sorted keep-first by score", () => {
  const stars = [
    star({ nameWithOwner: "ok/agent", description: "claude agent skill", topics: ["ai"], stars: 5 }),
    star({ nameWithOwner: "ok/cap", topics: ["capability-security"], description: "ocap", stars: 3 }),
    star({ nameWithOwner: "no/recipes", topics: ["cooking"], description: "food", stars: 99 }),
  ];
  const out = classify(stars, betHist, cfg, NOW);
  const keep = out.filter((r) => r.disposition === "keep").map((r) => r.repo);
  const drop = out.filter((r) => r.disposition === "drop").map((r) => r.repo);
  expect(keep).toContain("ok/agent");
  expect(keep).toContain("ok/cap");
  expect(drop).toEqual(["no/recipes"]);          // popular but off-thesis → dropped
  expect(out[0].disposition).toBe("keep");        // keep sorted first
  expect(out.every((r) => r.url.startsWith("https://github.com/"))).toBe(true);
});

test("exportJsonl emits one parseable JSON record per line, every field present", () => {
  const records = classify([star({ nameWithOwner: "o/agent", description: "mcp agent", topics: ["ai"] })], betHist, cfg, NOW);
  const lines = exportJsonl(records).trim().split("\n");
  expect(lines.length).toBe(records.length);
  const obj = JSON.parse(lines[0]);
  expect(obj).toHaveProperty("repo");
  expect(obj).toHaveProperty("disposition");
  expect(obj).toHaveProperty("cluster");
  expect(obj).toHaveProperty("thesis");
});
