import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function accessFixture() {
  const source = readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function applyConversationAccess(");
  assert.ok(start >= 0);
  const code = source.slice(
    start,
    source.indexOf("function render(snapshot)", start),
  );
  const controls = new Map<string, { hidden: boolean; disabled: boolean }>();
  const get = (id: string) => {
    if (!controls.has(id)) controls.set(id, { hidden: false, disabled: false });
    return controls.get(id)!;
  };
  const apply = runInNewContext(
    `let conversationReadOnly=false,sendingMessage=null; ${code}; applyConversationAccess`,
    { $: get },
  ) as (snapshot: unknown) => void;
  return { apply, get };
}

test("Telegram snapshots hide and disable the composer and model picker, restoring them for web", () => {
  const { apply, get } = accessFixture();
  apply({ readOnly: true, channel: "telegram" });
  assert.equal(get("message-form").hidden, true);
  assert.equal(get("suggestions").hidden, true);
  assert.equal(get("message").disabled, true);
  assert.equal(get("send").disabled, true);
  assert.equal(get("conversation-readonly").hidden, false);
  apply({ channel: "web", readOnly: false });
  assert.equal(get("message-form").hidden, false);
  assert.equal(get("message").disabled, false);
  assert.equal(get("send").disabled, false);
  assert.equal(get("conversation-readonly").hidden, true);
  assert.doesNotMatch(
    readFileSync(new URL("../public/app.js", import.meta.url), "utf8"),
    /\/telegram\/topic/,
  );
});

test("render keeps message suggestions hidden for an empty Telegram topic", () => {
  const source = readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "  const empty =",
    source.indexOf("function render(snapshot)"),
  );
  const code = source.slice(
    start,
    source.indexOf('  $("main-content")', start),
  );
  const suggestions = { hidden: false };
  const welcome = { hidden: false };
  const renderEmpty = runInNewContext(
    `(conversationReadOnly) => { const page={total:0},snapshot={actions:[]},partial=null; ${code} }`,
    {
      $: (id: string) => (id === "suggestions" ? suggestions : welcome),
    },
  ) as (readonly: boolean) => void;
  renderEmpty(true);
  assert.equal(suggestions.hidden, true);
  renderEmpty(false);
  assert.equal(suggestions.hidden, false);
});

test("only tool approvals and CUA state expose the separate required human controls area", () => {
  const { apply, get } = accessFixture();
  for (const pending of [
    { actions: [{ state: "pending" }] },
    { actions: [{ state: "uncertain" }] },
    { cuaHandoffs: [{ state: "active" }] },
    { mcpInteractions: [{ state: "pending" }] },
    { mcpCalls: [{ state: "uncertain" }] },
  ]) {
    apply({ readOnly: true, ...pending });
    assert.equal(get("human-controls-notice").hidden, false);
    assert.equal(get("message-form").hidden, true);
    assert.equal(get("send").disabled, true);
  }
  apply({ readOnly: true, deliveries: [{ canReconcile: true }] });
  assert.equal(get("human-controls-notice").hidden, true);
});
