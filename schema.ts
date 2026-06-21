// synoptic-github — the contract, as Zod schema blocks.
// Single source of truth: types are inferred (z.infer), docs live on the schema
// (.describe), validation happens at the boundary. Read top-to-bottom.
import { z } from "zod";

/** One repository, normalized from the GitHub API into just what a render needs. */
export const Repo = z.object({
  name: z.string().describe("Short repo name, e.g. 'prx'."),
  fullName: z.string().describe("owner/name, e.g. 'bounded-systems/prx'."),
  url: z.string().url().describe("Canonical html_url."),
  description: z.string().nullable().describe("One-line description, or null."),
  language: z.string().nullable().describe("Primary language, or null."),
  topics: z.array(z.string()).describe("Self-labeled topics — the per-repo contract that drives grouping."),
  stars: z.number().int().nonnegative().describe("Stargazer count."),
  pushedAt: z.string().describe("ISO-8601 last push; the only ordering key, so output stays deterministic."),
});
export type Repo = z.infer<typeof Repo>;

/** Where this artifact came from — reproducibly (no wall-clock; see SOURCE_DATE_EPOCH). */
export const Provenance = z.object({
  tool: z.literal("synoptic-github").describe("Generating tool."),
  version: z.string().describe("Tool git ref / commit, e.g. a short SHA."),
  owner: z.string().describe("GitHub account the corpus was read from."),
  sourceEpoch: z.number().int().nonnegative().describe("SOURCE_DATE_EPOCH: source commit time in seconds. Deterministic stamp, never Date.now()."),
});
export type Provenance = z.infer<typeof Provenance>;

/** The synoptic contract: a render is a pure, deterministic function of this. */
export const Corpus = z.object({
  provenance: Provenance,
  owner: z.string().describe("Display owner (login)."),
  name: z.string().describe("Display name (or login)."),
  repos: z.array(Repo).describe("Public, non-fork, non-archived repos, stable-sorted."),
});
export type Corpus = z.infer<typeof Corpus>;
