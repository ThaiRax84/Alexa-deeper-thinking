import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry, listProviders, resolveModels, ModelResolutionError } from "../src/index.js";

const registry = loadRegistry();

test("lists the supported AI companies for onboarding", () => {
  assert.deepEqual(
    listProviders(registry).map((p) => p.id),
    ["anthropic", "openai", "google"]
  );
});

test("picks the newest model of each family using creation dates", () => {
  const models = [
    { id: "x-haiku-4-5", created: 100 },
    { id: "x-haiku-5-5", created: 300 },
    { id: "x-opus-5-1", created: 200 },
    { id: "x-opus-5-5", created: 400 },
    { id: "x-sonnet-5-5", created: 400 },
  ];
  assert.deepEqual(resolveModels(registry, "anthropic", models), { fast: "x-haiku-5-5", deep: "x-opus-5-5" });
});

test("falls back to version numbers and skips excluded variants", () => {
  const models = [
    { id: "gemini-3.5-flash" },
    { id: "gemini-3.8-flash" },
    { id: "gemini-3.8-flash-lite" },
    { id: "gemini-3.8-flash-image" },
    { id: "gemini-3.1-pro-preview" },
    { id: "gemini-2.5-pro" },
    { id: "text-embedding-004" },
  ];
  assert.deepEqual(resolveModels(registry, "google", models), {
    fast: "gemini-3.8-flash",
    deep: "gemini-3.1-pro-preview",
  });
});

test("prefers a stable model over a preview of the same version", () => {
  const models = [{ id: "gemini-3.1-pro-preview" }, { id: "gemini-3.1-pro" }, { id: "gemini-3.8-flash" }];
  assert.equal(resolveModels(registry, "google", models).deep, "gemini-3.1-pro");
});

test("pinned IDs win when the key has access to them", () => {
  const pinnedRegistry = loadRegistry({ providers: { openai: { pinned: { deep: "special-model" } } } });
  const models = [{ id: "gpt-x-mini", created: 1 }, { id: "gpt-x-sol", created: 2 }, { id: "special-model", created: 0 }];
  assert.deepEqual(resolveModels(pinnedRegistry, "openai", models), { fast: "gpt-x-mini", deep: "special-model" });
});

test("operator overrides can remove a provider", () => {
  const r = loadRegistry({ providers: { google: null } });
  assert.deepEqual(listProviders(r).map((p) => p.id), ["anthropic", "openai"]);
});

test("throws a typed error when no model of a family is available", () => {
  assert.throws(
    () => resolveModels(registry, "openai", [{ id: "gpt-x-mini" }]),
    (e) => e instanceof ModelResolutionError && e.role === "deep"
  );
});
