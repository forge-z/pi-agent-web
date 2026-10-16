import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const source = readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function select(id, title)");
  const code = source.slice(
    start,
    source.indexOf("let rendered = null;", start),
  );
  const lists: Array<ReturnType<typeof deferred<void>>> = [];
  const reads: Array<{
    path: string;
    gate: ReturnType<typeof deferred<unknown>>;
  }> = [];
  const renders: unknown[] = [];
  const streams: FakeEvents[] = [];
  const timers: Array<() => void> = [];
  class FakeEvents {
    static CLOSED = 2;
    readyState = 1;
    closed = false;
    listeners = new Map<string, (event: { data: string }) => void>();
    constructor(readonly path: string) {
      streams.push(this);
    }
    close() {
      this.closed = true;
    }
    addEventListener(
      name: string,
      callback: (event: { data: string }) => void,
    ) {
      this.listeners.set(name, callback);
    }
    onopen?: () => void;
    onerror?: () => void;
  }
  const select = runInNewContext(
    `
    let conversationId=null, conversationSelectionVersion=0, sendRefreshVersion=0, events=null,sendingMessage=null,
      pendingMessage=null, rendered=null, renderedActions="", historyNavigation=null, historyPage=0, lastSnapshot=null;
    function render(snapshot) { lastSnapshot=snapshot; recordRender(snapshot); }
    ${code}
    select;
  `,
    {
      $: () => ({ value: "", dataset: {} }),
      sessionStorage: { getItem: () => null },
      settingsUI: { updateConversation() {} },
      conversationEvents: { start() {}, stop() {} },
      historyNodes: { clear() {} },
      updateRunStatus() {},
      text() {},
      plain() {},
      t: (value: string) => value,
      history: { replaceState() {} },
      loadConversations: () => {
        const gate = deferred<void>();
        lists.push(gate);
        return gate.promise;
      },
      api: (path: string) => {
        const gate = deferred<unknown>();
        reads.push({ path, gate });
        return gate.promise;
      },
      recordRender: (snapshot: unknown) => renders.push(snapshot),
      EventSource: FakeEvents,
      setTimeout: (callback: () => void) => timers.push(callback),
      clearTimeout() {},
    },
  ) as (id: string, title: string) => Promise<void>;
  return { select, lists, reads, renders, streams, timers };
}

test("overlapping A to B to A selection cannot apply an old A snapshot or open a second history stream", async () => {
  const f = fixture();
  const first = f.select("1", "A");
  f.lists[0]!.resolve();
  await flush();
  const middle = f.select("2", "B");
  const latest = f.select("1", "A again");
  f.lists[2]!.resolve();
  await flush();
  assert.equal(f.reads.length, 2);
  f.reads[1]!.gate.resolve({ latest: true });
  await latest;
  f.reads[0]!.gate.resolve({ stale: true });
  await first;
  f.lists[1]!.resolve();
  await middle;
  assert.equal(f.streams.length, 1);
  assert.equal(
    f.reads.length,
    2,
    "an already superseded selection does not fetch another history",
  );
  assert.equal(JSON.stringify(f.renders), JSON.stringify([{ latest: true }]));
});

test("compact state reuses the current history and refuses mismatched or closed-stream revisions", async () => {
  const f = fixture();
  const selected = f.select("1", "A");
  f.lists[0]!.resolve();
  await flush();
  const history = {
    version: "page-v1",
    messages: [{ role: "user", content: "original" }],
  };
  f.reads[0]!.gate.resolve({ history, view: { docs: {} } });
  await selected;
  const stream = f.streams[0]!;
  stream.listeners.get("state")!({
    data: JSON.stringify({
      historyVersion: "page-v1",
      view: { docs: { live: true } },
    }),
  });
  assert.equal(f.renders.length, 2);
  assert.deepEqual((f.renders[1] as { history: unknown }).history, history);
  stream.listeners.get("state")!({
    data: JSON.stringify({ historyVersion: "stale-v0", view: { docs: {} } }),
  });
  assert.equal(f.renders.length, 2);
  const next = f.select("2", "B");
  stream.listeners.get("state")!({
    data: JSON.stringify({ historyVersion: "page-v1", view: { docs: {} } }),
  });
  assert.equal(f.renders.length, 2);
  f.lists[1]!.resolve();
  await flush();
  f.reads[1]!.gate.resolve({ history: { version: "b" }, view: { docs: {} } });
  await next;
});

test("queued snapshot callbacks from a closed A stream are ignored after selecting A again", async () => {
  const f = fixture();
  const first = f.select("1", "A");
  f.lists[0]!.resolve();
  await flush();
  f.reads[0]!.gate.resolve({ first: true });
  await first;
  const old = f.streams[0]!;
  const next = f.select("1", "A again");
  f.lists[1]!.resolve();
  await flush();
  f.reads[1]!.gate.resolve({ next: true });
  await next;
  assert.equal(old.closed, true);
  old.listeners.get("snapshot")!({ data: JSON.stringify({ stale: true }) });
  assert.equal(
    JSON.stringify(f.renders),
    JSON.stringify([{ first: true }, { next: true }]),
  );
});

test("a history stream closed by the browser checks the session, then resubscribes or yields to login", async () => {
  const f = fixture();
  const selected = f.select("1", "A");
  f.lists[0]!.resolve();
  await flush();
  f.reads[0]!.gate.resolve({ history: { version: "v1" } });
  await selected;
  const stream = f.streams[0]!;
  stream.readyState = 0;
  stream.onerror!();
  assert.equal(f.timers.length, 0, "the browser still retries by itself");
  stream.readyState = 2;
  stream.onerror!();
  f.timers.shift()!();
  await flush();
  assert.equal(f.reads.at(-1)!.path, "/api/status");
  f.reads.at(-1)!.gate.resolve({});
  await flush();
  assert.equal(f.streams.length, 2);
  assert.match(f.streams[1]!.path, /^\/api\/conversations\/1\/events/);
  const reopened = f.streams[1]!;
  reopened.readyState = 2;
  reopened.onerror!();
  f.timers.shift()!();
  await flush();
  f.reads.at(-1)!.gate.reject(new Error("offline"));
  await flush();
  assert.equal(f.timers.length, 1, "an unreachable server is retried");
  f.timers.shift()!();
  await flush();
  f.reads
    .at(-1)!
    .gate.reject(Object.assign(new Error("Faça login"), { status: 401 }));
  await flush();
  assert.equal(f.timers.length, 0, "an expired session goes to login");
  assert.equal(f.streams.length, 2);
});
