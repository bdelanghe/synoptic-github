// Tests for the pure component-counting layer of components-probe.mjs. No git/IO.
import { test, expect } from "bun:test";
import { components } from "./components-probe.mjs";

// ---- file mode (a component = a distinct tracked file) ------------------------

test("file mode: de-duplicates and sorts", () => {
  expect(components(["b.ts", "a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"]);
});

test("file mode: count is the set size", () => {
  const files = ["c/1.ts", "c/2.ts", "c/3.ts"];
  expect(components(files).length).toBe(3);
});

test("file mode: empty input → empty set", () => {
  expect(components([])).toEqual([]);
});

// ---- by-dir mode (a component = a unique immediate subdir of the root) --------

test("by-dir: counts unique immediate subdirectories, not files", () => {
  const files = [
    "plans/L00/a.ts", "plans/L00/b.ts",   // one component: L00
    "plans/L01/a.ts",                       // one component: L01
    "plans/L15/deep/nested/x.ts",           // one component: L15
  ];
  expect(components(files, "plans")).toEqual(["L00", "L01", "L15"]);
});

test("by-dir: trailing slash on root is tolerated", () => {
  const files = ["plans/L00/a.ts", "plans/L01/a.ts"];
  expect(components(files, "plans/")).toEqual(["L00", "L01"]);
});

test("by-dir: ignores paths outside the root", () => {
  const files = ["plans/L00/a.ts", "lib/util.ts", "README.md"];
  expect(components(files, "plans")).toEqual(["L00"]);
});

test("by-dir: a file directly under the root counts by its filename (edge case)", () => {
  // "plans/top.ts" → slice past "plans/" → "top.ts" → split("/")[0] = "top.ts".
  // Documents current behavior: point --by-dir at a root whose children are all
  // directories, or the leaf files there will be counted as components too.
  const files = ["plans/L00/a.ts", "plans/top.ts"];
  expect(components(files, "plans")).toEqual(["L00", "top.ts"]);
});
