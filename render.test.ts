// Tests for the pure render layer. Everything here is a deterministic function of
// its inputs, so no network/fs/env is touched — see render.ts.
import { test, expect } from "bun:test";
import type { Corpus, Repo } from "./schema.ts";
import {
  repoLine, languageTally, statsLine, linksLine, stampDate, filterRepos,
  renderProfile, injectionBlock, replaceMarkedRegion,
} from "./render.ts";

const EPOCH = Math.floor(Date.parse("2026-06-22T00:00:00Z") / 1000); // deterministic "now"

const repo = (p: Partial<Repo> & { name: string }): Repo => ({
  name: p.name,
  fullName: p.fullName ?? `owner/${p.name}`,
  url: p.url ?? `https://github.com/owner/${p.name}`,
  description: p.description ?? null,
  language: p.language ?? null,
  topics: p.topics ?? [],
  stars: p.stars ?? 0,
  pushedAt: p.pushedAt ?? "2020-01-01T00:00:00Z",
});

const corpus = (repos: Repo[], over: Partial<Corpus> = {}): Corpus => ({
  provenance: { tool: "synoptic-github", version: "test", owner: "owner", sourceEpoch: EPOCH, ...(over.provenance ?? {}) },
  owner: "owner",
  name: "Owner Name",
  bio: null, blog: null, location: null, company: null, twitter: null,
  repos,
  ...over,
});

// ---- repoLine ----------------------------------------------------------------
test("repoLine renders name, optional description and language", () => {
  expect(repoLine(repo({ name: "a", url: "https://x/a", description: "does a", language: "Rust" })))
    .toBe("- [a](https://x/a) — does a `Rust`");
  expect(repoLine(repo({ name: "b", url: "https://x/b" }))).toBe("- [b](https://x/b)");
});

// ---- languageTally -----------------------------------------------------------
test("languageTally counts, sorts by count desc then name, ignores null", () => {
  expect(languageTally([
    repo({ name: "1", language: "TypeScript" }),
    repo({ name: "2", language: "Rust" }),
    repo({ name: "3", language: "TypeScript" }),
    repo({ name: "4", language: null }),
  ])).toEqual([["TypeScript", 2], ["Rust", 1]]);
});

// ---- statsLine ---------------------------------------------------------------
test("statsLine: org split + stars + recency + languages", () => {
  const repos = [
    repo({ name: "p", fullName: "owner/p", stars: 100, pushedAt: "2026-06-20T00:00:00Z", language: "TypeScript" }),
    repo({ name: "o1", fullName: "bounded-systems/o1", stars: 25, pushedAt: "2026-05-01T00:00:00Z", language: "TypeScript" }),
    repo({ name: "o2", fullName: "bounded-systems/o2", stars: 3, pushedAt: "2025-01-01T00:00:00Z", language: "HTML" }),
  ];
  expect(statsLine("owner", repos, EPOCH))
    .toBe("`owner` · 3 public repositories · 2 @bounded-systems · 128 stars · 2 active in 90d · TypeScript 2 · HTML 1");
});

test("statsLine gates empty segments (no stars, no org, no recency)", () => {
  expect(statsLine("owner", [repo({ name: "a", language: "Go", pushedAt: "2020-01-01T00:00:00Z" })], EPOCH))
    .toBe("`owner` · 1 public repositories · Go 1");
});

test("statsLine with sourceEpoch=0 omits recency (never falls back to wall-clock)", () => {
  const repos = [repo({ name: "a", stars: 5, pushedAt: "2026-06-20T00:00:00Z", language: "Go" })];
  expect(statsLine("owner", repos, 0)).toBe("`owner` · 1 public repositories · 5 stars · Go 1");
});

test("statsLine org match is case-insensitive (owner casing varies)", () => {
  const repos = [repo({ name: "a", fullName: "OWNER/a" }), repo({ name: "b", fullName: "acme/b" })];
  expect(statsLine("owner", repos, 0)).toBe("`owner` · 2 public repositories · 1 @acme");
});

// ---- linksLine ---------------------------------------------------------------
test("linksLine normalizes blog, links @company, twitter; drops nulls", () => {
  expect(linksLine({ location: "Brooklyn", blog: "robertdelanghe.dev", company: "@bounded-systems", twitter: "rdl" }))
    .toBe("Brooklyn · [robertdelanghe.dev](https://robertdelanghe.dev) · [@bounded-systems](https://github.com/bounded-systems) · [@rdl](https://x.com/rdl)");
  expect(linksLine({ location: null, blog: null, company: "Aura", twitter: null })).toBe("Aura");
  expect(linksLine({ location: null, blog: "https://x.io", company: null, twitter: null })).toBe("[x.io](https://x.io)");
});

// ---- stampDate ---------------------------------------------------------------
test("stampDate formats epoch, empty when unset", () => {
  expect(stampDate(EPOCH)).toBe("2026-06-22");
  expect(stampDate(0)).toBe("");
});

// ---- filterRepos -------------------------------------------------------------
test("filterRepos keeps repos carrying a listed topic; empty filter = all", () => {
  const repos = [repo({ name: "a", topics: ["ai"] }), repo({ name: "b", topics: ["cli"] })];
  expect(filterRepos(repos, ["ai"]).map((r) => r.name)).toEqual(["a"]);
  expect(filterRepos(repos, []).map((r) => r.name)).toEqual(["a", "b"]);
  expect(filterRepos(repos, undefined).map((r) => r.name)).toEqual(["a", "b"]);
});

// ---- renderProfile -----------------------------------------------------------
test("renderProfile: topic groups ordered by priority, Featured pulled out, stamp present", () => {
  const c = corpus([
    repo({ name: "exp", topics: ["experiment"], language: "Go" }),
    repo({ name: "core", topics: ["capability-security"], language: "Rust", stars: 10, pushedAt: "2026-06-10T00:00:00Z" }),
    repo({ name: "tool", topics: ["cli"], language: "Go" }),
  ], { bio: "the bio" });
  const md = renderProfile(c, { groupBy: "topic", featured: ["core"] });
  // header
  expect(md.startsWith("# Owner Name\n\n**the bio**\n\n`owner` · 3 public repositories")).toBe(true);
  // Featured section appears and precedes the groups; capability-security outranks cli outranks experiment
  expect(md.indexOf("## Featured")).toBeGreaterThan(-1);
  expect(md.indexOf("## cli")).toBeLessThan(md.indexOf("## experiment"));
  // featured repo is NOT duplicated in the topic groups
  expect(md.match(/\[core\]/g)?.length).toBe(1);
  expect(md.trimEnd().endsWith("<sub>auto-updated 2026-06-22</sub>")).toBe(true);
});

test("renderProfile: untagged repos sink to an 'other' group; group-by none flattens", () => {
  const c = corpus([repo({ name: "tagged", topics: ["ai"] }), repo({ name: "loose", topics: [] })]);
  expect(renderProfile(c, { groupBy: "topic" })).toContain("## other");
  const flat = renderProfile(c, { groupBy: "none" });
  expect(flat).not.toContain("## ai");
  expect(flat).toContain("- [tagged]");
});

test("renderProfile: banner emits a theme-aware <picture>", () => {
  const md = renderProfile(corpus([repo({ name: "a", topics: ["ai"] })]), { groupBy: "topic", banner: "assets/banner" });
  expect(md).toContain('srcset="assets/banner-dark.svg"');
  expect(md).toContain('src="assets/banner-light.svg"');
});

test("renderProfile is deterministic (byte-identical across runs)", () => {
  const c = corpus([
    repo({ name: "a", topics: ["ai"], stars: 3, pushedAt: "2026-06-01T00:00:00Z", language: "TypeScript" }),
    repo({ name: "b", topics: ["cli"], language: "Go" }),
  ], { location: "NYC", blog: "ex.dev" });
  expect(renderProfile(c, { groupBy: "topic" })).toBe(renderProfile(c, { groupBy: "topic" }));
});

// ---- region injection --------------------------------------------------------
test("injectionBlock + replaceMarkedRegion swap only the marked region", () => {
  const c = corpus([repo({ name: "a", topics: ["ai"] })]);
  const block = injectionBlock(c, { groupBy: "topic" }, "synoptic");
  expect(block.startsWith("<!-- synoptic:start -->")).toBe(true);
  expect(block.trimEnd().endsWith("<!-- synoptic:end -->")).toBe(true);

  const file = "# Hand-written\n\nkeep me\n\n<!-- synoptic:start -->\nOLD\n<!-- synoptic:end -->\n\nfooter\n";
  const out = replaceMarkedRegion(file, "synoptic", block);
  expect(out).not.toBeNull();
  expect(out!).toContain("# Hand-written");
  expect(out!).toContain("keep me");
  expect(out!).toContain("footer");
  expect(out!).toContain("- [a]");
  expect(out!).not.toContain("OLD");
});

test("replaceMarkedRegion returns null when markers are absent", () => {
  expect(replaceMarkedRegion("no markers here", "synoptic", "X")).toBeNull();
});
