# synoptic-github

Regenerate your GitHub profile README from your repositories — clean, and
**grouped by self-labeled topic** (your repo topics are the contract). Bun engine.

One ingest, two surfaces: this drives a profile README *and* feeds a site
(e.g. [robertdelanghe.dev](https://robertdelanghe.dev)) from the same corpus —
related, not the same build.

## Install

**GitHub Action** (profile repo workflow — see below)

**JSR module** (import the schema/render layer):
```ts
import { Corpus, Repo } from "jsr:@bdelanghe/synoptic-github";
import { renderProfile } from "jsr:@bdelanghe/synoptic-github/render";
```

**Nix** (devShell, compiled binary, or OCI container):
```bash
nix develop github:bdelanghe/synoptic-github   # devShell with bun + git
nix build   github:bdelanghe/synoptic-github#synoptic    # compiled binary
nix build   github:bdelanghe/synoptic-github#container   # OCI image
```

**Container** (pre-built, same image the action uses):
```
ghcr.io/bdelanghe/synoptic-github:latest
```

## Use it

Add a workflow to your profile repo (`<you>/<you>`):

```yaml
name: readme
on:
  schedule: [{ cron: "0 12 * * *" }]
  workflow_dispatch:
permissions:
  contents: write
jobs:
  readme:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: bdelanghe/synoptic-github@v2
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          group-by: topic        # topic | language | none
```

Topics drive the grouping, so label your repos
(`gh api --method PUT repos/<owner>/<repo>/topics -f 'names[]=…'`). Forks and
archived repos are excluded.

## Inputs

| Input | Default | Notes |
|---|---|---|
| `GITHUB_TOKEN` | — | required; reads your repos |
| `group-by` | `topic` | `topic` · `language` · `none` |
| `thesis` | — | one-paragraph bet (plain language) → lead blockquote under the bio |
| `read-first` | — | `Label \| https://url` (or just a URL) → a prominent **Start here** funnel line |
| `out` | `README.md` | file to write |

## Modes

One corpus, three modes (`bun synoptic.ts <mode>`):

| Mode | Does |
|---|---|
| `render` (default) | corpus → clean, topic-grouped Markdown (`OUT`) |
| `validate` | lint repos against the contract — topics must be in the vocabulary; flags missing topics/description. Exits non-zero on errors (`STRICT=1` also fails on warnings) so CI can gate it |
| `suggest` | **deterministic** topic suggestions (keyword rules, no LLM) for untagged repos, emitted as ready `gh` commands |

The contract lives in `schema.ts` (Zod blocks — `.describe` docs, `z.infer` types) and
`vocabulary.ts` (the controlled topic list + suggestion rules). Output is reproducible:
the provenance stamp uses `SOURCE_DATE_EPOCH`, never wall-clock, so re-runs are byte-identical.

## How it works

`synoptic.ts` (Bun) fetches your public, non-fork, non-archived repos (excluding the
profile and `.github` meta repos), validates them against the Zod contract, tallies
languages, totals stars, counts recently-active repos (measured against `SOURCE_DATE_EPOCH`,
never wall-clock, so the count stays reproducible) and org-vs-personal repos, groups by the
first topic, and writes Markdown. See [`EXAMPLE.md`](./EXAMPLE.md) for live output. Sole
dependency: `zod`.

`synoptic.ts` owns the IO (fetch, env, read/write); all the Markdown assembly lives in
`render.ts` as pure, side-effect-free functions of the corpus, covered by `render.test.ts`
(`bun test`).

## Curation & value (advisory)

The render is deterministic. Two sibling tools (Node + `gh`) are deliberately *not* — they
read live data to help you decide what to feature; they propose, you decide. Their only
output that crosses back into the reproducible render is a suggested `FEATURED=` list.

| Tool | Does |
|---|---|
| `curate.mjs` | Per-repo **disposition** (move / keep / archive / review) from name/topic/age heuristics |
| `value.mjs` | Per-repo **market-fit score**, driven entirely by **stars** — your repo's stars (*traction*), the star-mass of its topic-market via `search` (*gravity*), and the topics/languages of repos *you* star (*alignment*). 100% public data, never reads a private repo. Surfaces a "your market" map, re-shelf suggestions, and mis-shelved repos. |

```
GH_USER=you ORGS=your-org node value.mjs        # ranked table + market map + FEATURED=
```

Topic-market sizes are cached to `.value-cache.json` (gitignored) to stay under the
Search API's rate limit. Pure scoring lives in exported functions, covered by `value.test.ts`
(`bun test`).

## API usage & rate limits

This tool uses the [GitHub REST API](https://docs.github.com/en/rest) via a personal access token
or the Actions `GITHUB_TOKEN`. All usage is subject to
[GitHub's Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
and the [GitHub Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies).

**Primary rate limit**: 5,000 requests/hour per authenticated user
([REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limiting-for-the-rest-api)).
A typical synoptic run costs ~3–5 requests (user + repos + org repos). `value.mjs` caches
topic-market lookups in `.value-cache.json` to avoid re-hitting the Search API (which has a
separate, lower limit of 30 requests/minute).

**Secondary rate limits** apply to rapid-fire polling
([secondary rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limiting-for-the-rest-api#about-secondary-rate-limits)).
Don't poll the API in a tight loop — wait and call once rather than watching continuously.

## License

See `LICENSE`.
