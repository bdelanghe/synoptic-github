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
| `out` | `README.md` | file to write |

## How it works

`synoptic.ts` (Bun) fetches your public, non-fork, non-archived repos, tallies
languages, groups by the first topic on each repo, and writes Markdown. See
[`EXAMPLE.md`](./EXAMPLE.md) for live output from this account.

Engine is plain TypeScript on Bun — no build step, no dependencies.

## License

See `LICENSE`.
