// Tests for the pinned language ontology (languages.ts). Pure data + helpers.
import { test, expect } from "bun:test";
import { LANGUAGES, LANGUAGE_NAMES, languageInfo, languageSlug, languageColor } from "./languages.ts";

test("ontology is non-empty and well-formed", () => {
  expect(LANGUAGES.length).toBeGreaterThan(500);
  for (const l of LANGUAGES.slice(0, 50)) {
    expect(l.name.length).toBeGreaterThan(0);
    expect(l.slug).toMatch(/^[a-z0-9-]+$/);
    expect(l.type.length).toBeGreaterThan(0);
  }
});

test("names match GitHub repo.language values", () => {
  for (const n of ["TypeScript", "Rust", "Go", "Nix", "Jupyter Notebook", "Go Template", "Rich Text Format"]) {
    expect(LANGUAGE_NAMES.has(n)).toBe(true);
  }
});

test("languageSlug uses the ontology slug, with GitHub-style fallback", () => {
  expect(languageSlug("TypeScript")).toBe("typescript");
  expect(languageSlug("Go Template")).toBe("go-template");
  expect(languageSlug("C++")).toBe("cpp");
  expect(languageSlug("C#")).toBe("csharp");
  // unknown → derived, never throws
  expect(languageSlug("Totally Made Up Lang")).toBe("totally-made-up-lang");
});

test("info + color lookups", () => {
  expect(languageInfo("TypeScript")?.type).toBe("programming");
  expect(languageColor("TypeScript")).toMatch(/^#[0-9a-fA-F]{3,6}$/);
  expect(languageColor("Totally Made Up Lang")).toBeUndefined();
});
