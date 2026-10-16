import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("isolated controls page loads its own entry point without the conversation workspace", () => {
  const file = new URL("../public/human-controls.html", import.meta.url);
  assert.ok(existsSync(file), "Dedicated controls document is required");
  const html = readFileSync(file, "utf8");
  assert.match(html, /human-controls-page.js/);
  assert.doesNotMatch(
    html,
    /app\.js|id="conversations"|id="message-form"|id="messages"|id="suggestions"/,
  );
});

class Element {
  textContent = "";
  type = "";
  value = "";
  checked = false;
  disabled = false;
  required = false;
  step = "";
  id = "";
  children: Element[] = [];
  dataset: Record<string, string> = {};
  onclick?: () => Promise<void>;
  onsubmit?: (event: { preventDefault(): void }) => Promise<void>;
  constructor(readonly tag: string) {}
  append(...items: Element[]) {
    this.children.push(...items);
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}
function fixture(snapshot: unknown) {
  const calls: { path: string; body: unknown }[] = [];
  let refreshes = 0;
  const source = readFileSync(
    new URL("../public/human-controls.js", import.meta.url),
    "utf8",
  )
    .replace(/^import .*;\n/m, "")
    .replace(
      "export function renderHumanControls",
      "function renderHumanControls",
    );
  const render = runInNewContext(source + "\nrenderHumanControls", {
    URL,
    renderCuaHandoffs: () => [],
  });
  const cards: Element[] = render(snapshot, "12", {
    node: (tag: string, value?: string) => {
      const e = new Element(tag);
      if (tag === "textarea")
        Object.defineProperty(e, "type", {
          get: () => "textarea",
          set: () => {
            throw new TypeError("HTMLTextAreaElement.type is readonly");
          },
        });
      e.textContent = value ?? "";
      return e;
    },
    t: (v: string) => v,
    api: async (path: string, _method: string, body: unknown) => {
      calls.push({ path, body });
    },
    refresh: async () => {
      refreshes++;
    },
  });
  const all = cards.flatMap((c) => c.all());
  return {
    calls,
    all,
    get refreshes() {
      return refreshes;
    },
  };
}

test("isolated action decisions and reconciliation use only their scoped API and refresh projection", async () => {
  const f = fixture({
    actions: [
      {
        id: "pending",
        server: "mock",
        tool: "write",
        state: "pending",
        args: '{"target":"review me"}',
      },
      { id: "uncertain", server: "mock", tool: "write", state: "uncertain" },
    ],
    mcpInteractions: [],
    mcpCalls: [{ id: "call", server: "mock", tool: "send" }],
    cuaHandoffs: [],
  });
  assert.ok(f.all.some((e) => e.textContent.includes("review me")));
  await f.all.find((e) => e.textContent === "Confirmar ação")!.onclick!();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), {
    path: "/api/human-controls/12/actions/pending",
    body: { decision: "approve" },
  });
  assert.equal(f.refreshes, 1);
  for (const form of f.all.filter((e) => e.tag === "form")) {
    const input = form
      .all()
      .find((e) => e.tag === "textarea" || e.tag === "input")!;
    input.value = "Verified externally";
    await form.onsubmit!({ preventDefault() {} });
  }
  assert.ok(f.calls.every((c) => c.path.startsWith("/api/human-controls/12/")));
  assert.equal(f.refreshes, 3);
});

test("isolated MCP forms preserve typed values and support decline and resume JSON without transcript reads", async () => {
  const f = fixture({
    actions: [],
    mcpCalls: [],
    cuaHandoffs: [],
    mcpInteractions: [
      {
        id: "form",
        server: "mock",
        kind: "form",
        payload: JSON.stringify({
          message: "Review",
          requestedSchema: {
            type: "object",
            properties: {
              confirmed: { type: "boolean" },
              count: { type: "integer" },
              ratio: { type: "number" },
              choice: { enum: ["one", "two"] },
            },
            required: ["count"],
          },
        }),
      },
      {
        id: "resume",
        server: "mock",
        kind: "resume",
        payload: '{"message":"Resume permission"}',
      },
    ],
  });
  const forms = f.all.filter((e) => e.tag === "form");
  assert.equal(f.all.find((e) => e.id.endsWith("-ratio"))?.step, "any");
  for (const input of forms[0]
    .all()
    .filter((e) => ["input", "select"].includes(e.tag))) {
    if (input.type === "checkbox") input.checked = true;
    else
      input.value = input.id.endsWith("-ratio")
        ? "0.5"
        : input.tag === "select"
          ? '"two"'
          : "3";
  }
  await forms[0].onsubmit!({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), {
    path: "/api/human-controls/12/mcp-interactions/form",
    body: {
      action: "accept",
      content: { confirmed: true, count: 3, ratio: 0.5, choice: "two" },
    },
  });
  forms[1].all().find((e) => e.tag === "textarea")!.value = '{"answer":"yes"}';
  await forms[1].onsubmit!({ preventDefault() {} });
  assert.equal(
    (f.calls[1].body as { content: { answer: string } }).content.answer,
    "yes",
  );
  await forms[0].all().find((e) => e.textContent === "Recusar")!.onclick!();
  assert.equal((f.calls[2].body as { action: string }).action, "decline");
  assert.ok(f.calls.every((c) => c.path.startsWith("/api/human-controls/12/")));
});

function pageFixture() {
  const elements = new Map<
    string,
    Element & {
      hidden: boolean;
      replaceChildren(...items: Element[]): void;
      querySelectorAll(): Element[];
    }
  >();
  const get = (id: string) => {
    if (!elements.has(id)) {
      const e = new Element("div");
      elements.set(
        id,
        Object.assign(e, {
          hidden: false,
          replaceChildren(...items: Element[]) {
            e.children = items;
          },
          querySelectorAll() {
            return [];
          },
        }),
      );
    }
    return elements.get(id)!;
  };
  const reads: ((value: {
    status: number;
    json(): Promise<unknown>;
  }) => void)[] = [];
  const rendered: unknown[] = [];
  const controls: { refresh(): Promise<void> }[] = [];
  const source = readFileSync(
    new URL("../public/human-controls-page.js", import.meta.url),
    "utf8",
  ).replace(/^import .*;\n/m, "");
  const page = runInNewContext(source + "\n({refresh,clearSession})", {
    document: {
      getElementById: get,
      createElement: () => new Element("div"),
      hidden: false,
    },
    location: { search: "?c=12" },
    URLSearchParams,
    PiI18n: {
      language: () => "pt-BR",
      t: (s: string) => s,
      errorText: (s: string) => s,
      locale: () => "en",
      text: (e: Element, s: string | (() => string)) => {
        e.textContent = typeof s === "function" ? s() : s;
      },
    },
    fetch: () => new Promise((resolve) => reads.push(resolve)),
    setInterval: () => 0,
    renderHumanControls: (
      s: unknown,
      _id: string,
      ui: { refresh(): Promise<void> },
    ) => {
      controls.push(ui);
      rendered.push(s);
      return [new Element("card")];
    },
  }) as { refresh(force?: boolean): Promise<void>; clearSession(): void };
  const respond = async (index: number, value: unknown, status = 200) => {
    reads[index]({ status, ok: status < 400, json: async () => value } as {
      status: number;
      json(): Promise<unknown>;
    });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { page, respond, rendered, get, reads, controls };
}

test("a delayed polling read cannot restore controls after a newer decision refresh", async () => {
  const f = pageFixture();
  const current = f.page.refresh(true);
  await f.respond(1, { state: "ended" });
  await current;
  await f.respond(0, { state: "active", url: "old-viewer-link" });
  assert.deepEqual(JSON.parse(JSON.stringify(f.rendered)), [
    { state: "ended" },
  ]);
});

test("session loss clears operational data and invalidates an earlier pending read", async () => {
  const f = pageFixture();
  await f.respond(0, { state: "pending" });
  const old = f.page.refresh(true);
  const expired = f.page.refresh(true);
  const rejected = assert.rejects(expired);
  await f.respond(2, { error: "Faça login" }, 401);
  await rejected;
  await f.respond(1, { state: "active" });
  await old;
  assert.equal(f.get("human-cards").children.length, 0);
  assert.equal(f.get("human-session").hidden, true);
  assert.equal(f.get("human-login").hidden, false);
});

test("a decision callback from a logged-out session cannot start a new controls refresh", async () => {
  const f = pageFixture();
  await f.respond(0, { state: "pending" });
  const previous = f.controls[0];
  const logout = f.get("human-logout").onclick!();
  const late = previous.refresh();
  if (f.reads.length > 2)
    await f.respond(2, { state: "active", url: "stale-ticket" });
  await late;
  const leakedBeforeLogout = !f.get("human-session").hidden;
  await f.respond(1, { ok: true });
  await logout;
  assert.equal(leakedBeforeLogout, false);
  assert.equal(f.get("human-cards").children.length, 0);
  assert.equal(f.get("human-session").hidden, true);
});

test("structured MCP fields preserve object/list defaults and parse edited JSON using native textarea semantics", async () => {
  const f = fixture({
    actions: [],
    mcpCalls: [],
    cuaHandoffs: [],
    mcpInteractions: [
      {
        id: "structured",
        server: "mock",
        kind: "form",
        payload: JSON.stringify({
          requestedSchema: {
            type: "object",
            properties: {
              data: { type: "object", default: { label: "old" } },
              items: { type: "array", default: ["old"] },
            },
            required: ["data", "items"],
          },
        }),
      },
    ],
  });
  const data = f.all.find((e) => e.id.endsWith("-data"))!;
  const items = f.all.find((e) => e.id.endsWith("-items"))!;
  assert.equal(data.value, '{"label":"old"}');
  assert.equal(items.value, '["old"]');
  data.value = '{"label":"new"}';
  items.value = '["one","two"]';
  await f.all.find((e) => e.tag === "form")!.onsubmit!({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].body)), {
    action: "accept",
    content: { data: { label: "new" }, items: ["one", "two"] },
  });
});
