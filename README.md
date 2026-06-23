# synoptic-github

Regenerate your GitHub profile README from your repositories — clean, and
**grouped by self-labeled topic** (your repo topics are the contract). Bun engine.

One ingest, two surfaces: this drives a profile README *and* feeds a site
(e.g. [robertdelanghe.dev](https://robertdelanghe.dev)) from the same corpus —
related, not the same build.

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

## License

See `LICENSE`.
