// status.ts — the MONITORING layer (Layer 2). A freshness-stamped, NON-deterministic
// view that right-joins live fleet signals (CI, open PRs/issues) onto the synoptic
// corpus (Layer 1). Kept deliberately separate from render.ts: render is byte-
// reproducible (SOURCE_DATE_EPOCH, no wall-clock), so the committed README never goes
// red just because a workflow is mid-run. Status is wall-clock by nature — it writes
// its own artifact (STATUS.md / status.json) and is regenerated on a schedule, never
// diff-gated. The corpus (the repo inventory + topics) is the single source of truth;
// monitoring is a right-join onto it.
//
// Pure layer: schema + render only. synoptic.ts owns the IO (fetch/env/write).
import { z } from "zod";
import type { Corpus, Repo } from "./schema.ts";

/** Latest CI conclusion, collapsed to four states the eye can scan. */
export const CI = z.enum(["success", "failure", "pending", "none"]);
export type CI = z.infer<typeof CI>;

/** Live signal for one repo — the right-join onto a corpus Repo, keyed by fullName. */
export const RepoStatus = z.object({
  fullName: z.string().describe("owner/name — the join key onto Corpus.repos."),
  ci: CI.describe("Latest default-branch workflow conclusion, collapsed to 4 states."),
  ciUrl: z.string().url().nullable().describe("html_url of the latest run, or null."),
  ciRunAt: z.string().nullable().describe("ISO-8601 of the latest run, or null."),
  openPRs: z.number().int().nonnegative().describe("Open pull requests (capped at 100)."),
  openIssues: z.number().int().nonnegative().describe("Open issues, PRs excluded."),
});
export type RepoStatus = z.infer<typeof RepoStatus>;

const ICON: Record<CI, string> = { success: "🟢", failure: "🔴", pending: "🟡", none: "⚪" };

/** GitHub Actions run → our 4-state CI. success only if it actually succeeded. */
export const ciOf = (run: { status?: string; conclusion?: string | null } | undefined): CI =>
  !run ? "none" : run.status !== "completed" ? "pending" : run.conclusion === "success" ? "success" : "failure";

/** One repo → one status row, linking the CI cell to the run when we have a url. */
export const statusRow = (r: Repo, s: RepoStatus): string => {
  const ci = s.ciUrl ? `[${ICON[s.ci]}](${s.ciUrl})` : ICON[s.ci];
  return `| [${r.name}](${r.url}) | ${ci} | ${s.openPRs} | ${s.openIssues} | ${r.pushedAt.slice(0, 10)} |`;
};

// Pure render of the whole board. stampISO is the ONLY wall-clock input, injected by
// the caller — so this function itself stays pure and unit-testable. Repos missing a
// status (fetch failed) sink to the bottom as ⚪ rather than vanishing silently.
export const renderStatus = (corpus: Corpus, statuses: Map<string, RepoStatus>, stampISO: string): string => {
  const vals = [...statuses.values()];
  const red = vals.filter((s) => s.ci === "failure").length;
  const pending = vals.filter((s) => s.ci === "pending").length;
  const prs = vals.reduce((n, s) => n + s.openPRs, 0);

  // Sort red → pending → the rest, so what needs attention floats to the top.
  const rank = (c: CI) => (c === "failure" ? 0 : c === "pending" ? 1 : c === "none" ? 3 : 2);
  const rows = corpus.repos
    .map((r) => ({ r, s: statuses.get(r.fullName) }))
    .sort((a, b) => rank(a.s?.ci ?? "none") - rank(b.s?.ci ?? "none") || a.r.name.localeCompare(b.r.name))
    .map(({ r, s }) => statusRow(r, s ?? { fullName: r.fullName, ci: "none", ciUrl: null, ciRunAt: null, openPRs: 0, openIssues: 0 }));

  const table = [`| repo | CI | PRs | issues | last push |`, `| --- | :-: | --: | --: | --- |`, ...rows].join("\n");
  return [
    `# ${corpus.owner} — fleet status`,
    `\`${corpus.repos.length} repos\` · ${red} 🔴 · ${pending} 🟡 · ${prs} open PRs`,
    table,
    `<sub>monitoring snapshot — ${stampISO} · live signal, not a reproducible artifact</sub>`,
  ].join("\n\n") + "\n";
};
