// Tests for the pure triage layer of lists.mjs. No network/gh.
import { test, expect } from "bun:test";
import { DEFAULT_CONFIG, ageYears, lowSignal, listFor, proposeLists, exportMarkdown } from "./lists.mjs";

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

// ---- exportMarkdown ----------------------------------------------------------
test("exportMarkdown writes every star into sections (pinned + lists + dropped), with links/stars", () => {
  const stars = [
    ...many("ai", 8, { description: "an ai thing", language: "Python" }),
    star({ nameWithOwner: "big/landmark", topics: ["ai"], stars: 9000, description: "huge", language: "Go" }),
    star({ nameWithOwner: "o/dead", isArchived: true }),
  ];
  const plan = proposeLists(stars, cfg, NOW);
  const md = exportMarkdown(plan, "2026-06-23");
  expect(md).toContain("# Starred archive — 10 repos");
  expect(md).toContain("## pinned-stars");
  expect(md).toContain("## ai (");
  expect(md).toContain("## dropped (1)");
  expect(md).toContain("[big/landmark](https://github.com/big/landmark) — huge `Go` ★9000");
  // every kept + dropped repo is represented (count link bullets)
  expect((md.match(/^- \[/gm) || []).length).toBe(plan.kept.length + plan.unstar.length + plan.pinned.length);
});
