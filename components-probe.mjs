#!/usr/bin/env node
// components-probe — make a "drift-gated across N components" claim MEASURED, not
// asserted. Counts the contract/component surface straight from git (tracked
// files only — deterministic, ignores build output and untracked junk), and can
// fail CI if the count regresses below a floor. The number on a résumé or in a
// README then has a reproducible source of truth, and "how did you count?" has a
// one-line answer: this probe, these globs, run in CI.
//
// Usage:
//   node components-probe.mjs --glob 'app/contracts/**/*.rb'             # count + list
//   node components-probe.mjs --glob 'plans/L*/**' --by-dir plans        # count L00..L15 layers
//   node components-probe.mjs --glob '...' --assert 130                  # CI gate: exit 1 if < 130
//   node components-probe.mjs --glob '...' --json > components.json      # committed proof artifact
//
//   --glob <pathspec>  git pathspec defining a component (repeatable).
//   --by-dir <root>    count UNIQUE immediate subdirectories under <root>
//                      instead of files (a component is a folder, not a file).
//   --assert <N>       exit 1 when the count is below N (the drift gate).
//   --json             emit { count, by, globs, components } for an artifact/badge.
//
// The classifier (`components`) is a pure function of a file list — unit-tested
// in components-probe.test.ts. `git ls-files` and printing run only on direct
// invocation.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Pure: reduce a list of tracked paths to the sorted, de-duplicated component
// set. With `byDir`, a component is each unique immediate subdirectory under
// that root; otherwise it is each distinct file path.
export const components = (files, byDir = null) => {
  if (byDir) {
    const root = byDir.replace(/\/+$/, "") + "/";
    return [...new Set(
      files.filter((f) => f.startsWith(root)).map((f) => f.slice(root.length).split("/")[0]).filter(Boolean),
    )].sort();
  }
  return [...new Set(files)].sort();
};

// ---- IO (runs only when invoked directly) -------------------------------------
const main = () => {
  const argsAll = (flag) => process.argv.reduce((a, v, i) => (process.argv[i - 1] === flag ? [...a, v] : a), []);
  const arg = (flag, def) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; };

  const globs = argsAll("--glob");
  const byDir = arg("--by-dir", null);
  const assert = Number(arg("--assert", 0)) || 0;
  const json = process.argv.includes("--json");

  if (!globs.length) { console.error("components-probe: pass at least one --glob <pathspec>"); process.exit(2); }

  const files = execFileSync("git", ["ls-files", "-z", "--", ...globs], { encoding: "utf8" }).split("\0").filter(Boolean);
  const comps = components(files, byDir);
  const count = comps.length;

  if (json) {
    console.log(JSON.stringify({ count, by: byDir ? `dir:${byDir}` : "file", globs, components: comps }, null, 2));
  } else {
    console.log(`\n  COMPONENTS — ${count} (${byDir ? `unique dirs under ${byDir}` : "tracked files"})`);
    console.log(`  globs: ${globs.join(", ")}\n`);
    for (const c of comps.slice(0, 20)) console.log(`  · ${c}`);
    if (count > 20) console.log(`  … and ${count - 20} more`);
    console.log("");
  }

  if (assert && count < assert) {
    console.error(`✗ components-probe: ${count} < required ${assert} — the "${assert}+ components" claim no longer holds.`);
    process.exit(1);
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
