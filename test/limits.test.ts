import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_TEXT, REQUEST_ID } from "../src/limits.js";

test("browser text limits match the server limit", () => {
  const html = readFileSync(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  for (const id of ["message", "task-prompt"]) {
    const element = new RegExp(`<textarea\\s+id="${id}"[^>]*>`).exec(html);
    assert.ok(element, id);
    assert.match(element[0], new RegExp(`maxlength="${MAX_TEXT}"`), id);
  }
});

test("request ids accept bounded client keys only", () => {
  assert.ok(REQUEST_ID.test("web:1a2b-3c.4"));
  assert.ok(REQUEST_ID.test("x".repeat(160)));
  for (const value of ["", "x".repeat(161), "has space", "a/b", "line\nbreak"])
    assert.equal(REQUEST_ID.test(value), false, JSON.stringify(value));
});
