// Tests for the pure monitoring layer (status.ts). Like render, every function here
// is a deterministic function of its inputs — the one wall-clock value (the stamp)
// is injected by the caller, so the render stays testable. No network/fs/env.
import { test, expect } from "bun:test";
import type { Corpus, Repo } from "./schema.ts";
import { ciOf, statusRow, renderStatus, type RepoStatus } from "./status.ts";

const repo = (p: Partial<Repo> & { name: string }): Repo => ({
  name: p.name,
  fullName: p.fullName ?? `bounded-systems/${p.name}`,
  url: p.url ?? `https://github.com/bounded-systems/${p.name}`,
  description: p.description ?? null,
  language: p.language ?? null,
  topics: p.topics ?? [],
  stars: p.stars ?? 0,
  pushedAt: p.pushedAt ?? "2026-06-27T00:00:00Z",
});

const corpus = (repos: Repo[]): Corpus => ({
  provenance: { tool: "synoptic-github", version: "test", owner: "bounded-systems", sourceEpoch: 0 },
  owner: "bounded-systems", name: "bounded-systems",
  bio: null, blog: null, location: null, company: null, twitter: null, repos,
});

const status = (p: Partial<RepoStatus> & { fullName: string }): RepoStatus => ({
  fullName: p.fullName, ci: p.ci ?? "none", ciUrl: p.ciUrl ?? null,
  ciRunAt: p.ciRunAt ?? null, openPRs: p.openPRs ?? 0, openIssues: p.openIssues ?? 0,
});

// ---- ciOf --------------------------------------------------------------------
test("ciOf collapses a GitHub run to four states", () => {
  expect(ciOf(undefined)).toBe("none");
  expect(ciOf({ status: "in_progress" })).toBe("pending");
  expect(ciOf({ status: "queued" })).toBe("pending");
  expect(ciOf({ status: "completed", conclusion: "success" })).toBe("success");
  expect(ciOf({ status: "completed", conclusion: "failure" })).toBe("failure");
  expect(ciOf({ status: "completed", conclusion: "cancelled" })).toBe("failure");
  expect(ciOf({ status: "completed", conclusion: null })).toBe("failure");
});

// ---- statusRow ---------------------------------------------------------------
test("statusRow links the CI icon to the run when a url is present", () => {
  const r = repo({ name: "prx", pushedAt: "2026-06-29T10:00:00Z" });
  const s = status({ fullName: r.fullName, ci: "failure", ciUrl: "https://x/run/1", openPRs: 6, openIssues: 58 });
  expect(statusRow(r, s)).toBe("| [prx](https://github.com/bounded-systems/prx) | [🔴](https://x/run/1) | 6 | 58 | 2026-06-29 |");
});

test("statusRow shows a bare icon when there is no run url", () => {
  const r = repo({ name: "trust" });
  expect(statusRow(r, status({ fullName: r.fullName }))).toBe("| [trust](https://github.com/bounded-systems/trust) | ⚪ | 0 | 0 | 2026-06-27 |");
});

// ---- renderStatus ------------------------------------------------------------
test("renderStatus floats failures to the top, then pending, then the rest", () => {
  const repos = [repo({ name: "green" }), repo({ name: "red" }), repo({ name: "yellow" })];
  const statuses = new Map([
    ["bounded-systems/green", status({ fullName: "bounded-systems/green", ci: "success" })],
    ["bounded-systems/red", status({ fullName: "bounded-systems/red", ci: "failure" })],
    ["bounded-systems/yellow", status({ fullName: "bounded-systems/yellow", ci: "pending" })],
  ]);
  const out = renderStatus(corpus(repos), statuses, "2026-06-29T01:00:00Z");
  const order = ["red", "yellow", "green"].map((n) => out.indexOf(`[${n}]`));
  expect(order).toEqual([...order].sort((a, b) => a - b)); // strictly increasing = correct order
  expect(out).toContain("`3 repos` · 1 🔴 · 1 🟡 · 0 open PRs");
  expect(out).toContain("not a reproducible artifact");
});

test("renderStatus tallies open PRs across the fleet and includes the stamp", () => {
  const repos = [repo({ name: "a" }), repo({ name: "b" })];
  const statuses = new Map([
    ["bounded-systems/a", status({ fullName: "bounded-systems/a", ci: "success", openPRs: 6 })],
    ["bounded-systems/b", status({ fullName: "bounded-systems/b", ci: "success", openPRs: 2 })],
  ]);
  const out = renderStatus(corpus(repos), statuses, "2026-06-29T01:00:00Z");
  expect(out).toContain("8 open PRs");
  expect(out).toContain("2026-06-29T01:00:00Z");
});

// A repo with no fetched status must still appear (as ⚪), never silently vanish.
test("renderStatus renders repos missing a status as an empty/none row", () => {
  const out = renderStatus(corpus([repo({ name: "ghost" })]), new Map(), "2026-06-29T01:00:00Z");
  expect(out).toContain("| [ghost](https://github.com/bounded-systems/ghost) | ⚪ | 0 | 0 |");
});
