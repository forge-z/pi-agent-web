import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";
import type { ToolGateway } from "../src/mcp.js";

test("legacy databases gain empty visibility metadata without changing existing histories or grants", async () => {
  const f = await fixture();
  try {
    const before = f.app.listConversations();
    const grants = f.app.store.all("SELECT * FROM telegram_grants");
    f.app.store.db.exec("DROP TABLE conversation_web_hidden");
    await f.restart();
    assert.deepEqual(f.app.listConversations(), before);
    assert.deepEqual(f.app.store.all("SELECT * FROM telegram_grants"), grants);
    assert.deepEqual(
      f.app.store.all("SELECT * FROM conversation_web_hidden"),
      [],
    );
  } finally {
    await f.close();
  }
});

test("retired visibility API preserves existing metadata, histories, grants and frozen tasks", async () => {
  const f = await fixture();
  try {
    f.app.setConversationWebHidden(f.id, true);
    const rows = f.app.listConversations();
    const before = routing(f.app);
    assert.equal(
      (
        await f.request(`/api/conversations/${f.id}/web-visibility`, "PUT", {
          hidden: false,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          `/api/conversations/${f.anchor}/web-visibility`,
          "PUT",
          { hidden: true },
        )
      ).status,
      404,
    );
    await f.restart();
    assert.deepEqual(f.app.listConversations(), rows);
    assert.deepEqual(routing(f.app), before);
  } finally {
    await f.close();
  }
});

async function fixture(
  gateway: ToolGateway = {
    call: async () => {
      throw new Error("External tools forbidden");
    },
  },
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-web-"));
  const faux = fauxProvider({
    models: [
      { id: "one", reasoning: true },
      { id: "two", reasoning: false },
    ],
  });
  faux.setResponses(
    Array.from({ length: 20 }, () => fauxAssistantMessage("Synthetic answer")),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const options = {
    dir,
    models,
    modelId: "one",
    gateway,
  };
  let app = await Runtime.open(options);
  const anchor = await app.create("Existing web history");
  await app.admit(anchor, "web-original", "Original web input", {
    source: "web",
  });
  await (await app.conversation(anchor)).waitForIdle(context);
  app.store.consumeLink(app.store.link(anchor), "100", "42");
  const id = await app.create("Started on Telegram", {
    chat: "100",
    user: "42",
  });
  app.telegramChats.select(id, { chat: "100", user: "42" });
  const origin = "http://localhost:3000";
  const web = createAppServer(app, {
    origin,
    password: "synthetic-password-only",
    secureCookie: false,
  });
  await new Promise<void>((resolve) =>
    web.server.listen(0, "127.0.0.1", resolve),
  );
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password: "synthetic-password-only" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  let serverClosed = false;
  return {
    get app() {
      return app;
    },
    id,
    anchor,
    async request(
      path: string,
      method = "GET",
      data?: unknown,
      authenticated = true,
      requestOrigin = origin,
    ) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(authenticated ? { cookie } : {}),
          origin: requestOrigin,
          "content-type": "application/json",
        },
        body: data ? JSON.stringify(data) : undefined,
      });
      return { status: response.status, body: await response.json() };
    },
    async restart() {
      if (!serverClosed) await web.close();
      serverClosed = true;
      await app.close();
      app = await Runtime.open(options);
    },
    async close() {
      if (!serverClosed) await web.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const webAccess = { source: "web" as const };
const telegramAccess = { source: "telegram" as const, chat: "100", user: "42" };
async function settled(app: Runtime, id: string) {
  await (await app.conversation(id)).waitForIdle(context);
  const deadline = Date.now() + 5000;
  while (
    app.store.get(
      "SELECT 1 FROM requests WHERE conversationId=? AND status='pending'",
      id,
    )
  ) {
    assert.ok(
      Date.now() < deadline,
      "Request completion must settle before checking delivery",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const routing = (app: Runtime) => ({
  origins: app.store.all(
    "SELECT * FROM telegram_conversations ORDER BY conversationId",
  ),
  bindings: app.store.all("SELECT * FROM telegram ORDER BY chat"),
  grants: app.store.all(
    "SELECT * FROM telegram_grants ORDER BY chat,user,conversationId",
  ),
  selection: app.store.all(
    "SELECT * FROM telegram_chat_selection ORDER BY chat,user",
  ),
});

test("Telegram history is read-only through every web mutation route while Telegram still replies", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.request(`/api/conversations/${f.id}/web-visibility`, "PUT", {
          hidden: true,
        })
      ).status,
      403,
    );
    f.app.setConversationWebHidden(f.id, true);
    await f.app.admit(
      f.id,
      "telegram-first",
      "Telegram original",
      telegramAccess,
    );
    await settled(f.app, f.id);
    assert.equal(
      f.app.listConversations().find((row) => row.id === f.id)?.webHidden,
      true,
    );
    const history = (await f.app.snapshot(f.id)).view.entries;
    const before = routing(f.app);
    const settings = await f.app.settings.conversation(f.id);
    const paths: Array<[string, string, unknown]> = [
      ["", "PUT", { title: "Blocked" }],
      ["", "DELETE", { confirm: true }],
      ["/settings", "PUT", { provider: "faux", modelId: "two", effort: "off" }],
      ["/messages", "POST", { requestId: "web-turn", text: "Blocked" }],
      ["/messages", "POST", { requestId: "web-command", text: "/model two" }],
      ["/link", "POST", {}],
      ["/telegram/topic", "POST", { confirm: true }],
      ["/restore", "POST", {}],
      ["/purge", "POST", { confirm: true, expectedDeletedAt: 1 }],
    ];
    for (const [path, method, input] of paths) {
      const result = await f.request(
        `/api/conversations/${f.id}${path}`,
        method,
        input,
      );
      assert.equal(
        result.status,
        403,
        `${method} ${path}: ${JSON.stringify(result.body)}`,
      );
      assert.match(result.body.error, /Somente leitura/);
    }
    assert.equal((await f.request(`/api/conversations/${f.id}`)).status, 403);
    assert.deepEqual((await f.app.snapshot(f.id)).view.entries, history);
    assert.deepEqual(await f.app.settings.conversation(f.id), settings);
    assert.deepEqual(routing(f.app), before);
    await assert.rejects(
      f.app.submit(f.id, "direct-web", "Blocked", "web"),
      /Somente leitura/,
    );
    await assert.rejects(
      f.app.admit(f.id, "direct-command", "/stop", webAccess),
      /Somente leitura/,
    );
    await f.app.admit(
      f.id,
      "telegram-next",
      "Telegram continues",
      telegramAccess,
    );
    await settled(f.app, f.id);
    assert.ok(
      f.app.store.get(
        "SELECT 1 FROM deliveries WHERE id LIKE ?",
        `${f.id}:telegram-next:%`,
      ),
    );
  } finally {
    await f.close();
  }
});

test("revocation and restart never make Telegram history writable from the web", async () => {
  const f = await fixture();
  try {
    f.app.store.run("DELETE FROM telegram_grants WHERE conversationId=?", f.id);
    const before = routing(f.app);
    await f.restart();
    await assert.rejects(
      f.app.submit(f.id, "after-restart", "Blocked", "web"),
      /Somente leitura/,
    );
    await assert.rejects(
      f.app.admit(f.id, "revoked-telegram", "Blocked", telegramAccess),
      /não autorizada/,
    );
    assert.deepEqual(routing(f.app), before);
    assert.equal(
      f.app.listConversations().find((c) => c.id === f.id)?.channel,
      "telegram",
    );
  } finally {
    await f.close();
  }
});

test("new web conversations neither create nor complete Telegram topics and only web conversations accept web commands", async () => {
  const f = await fixture();
  try {
    const before = routing(f.app);
    const response = await f.request("/api/conversations", "POST", {
      title: "Web only",
      requestId: "web-only-create",
    });
    assert.equal(response.status, 201);
    const id = response.body.id;
    await f.app.admit(id, "web-only-turn", "Web only", webAccess);
    await settled(f.app, id);
    assert.deepEqual(routing(f.app), before);
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM meta WHERE key GLOB 'telegram:topic-create:*'",
      ),
      undefined,
    );
    assert.equal(
      f.app.store.get("SELECT 1 FROM deliveries WHERE id LIKE ?", `${id}:%`),
      undefined,
    );
    assert.equal(
      (
        await f.request(`/api/conversations/${id}/telegram/topic`, "POST", {
          confirm: true,
        })
      ).status,
      403,
    );
    const agents = await f.app.admit(id, "web-agents", "/agents", webAccess);
    assert.ok(agents.kind === "command" && Array.isArray(agents.data));
    assert.ok(!agents.data.some((c) => c.id === f.id));
  } finally {
    await f.close();
  }
});

test("legacy linked histories are classified once without changing data, grants or frozen cron destinations", async () => {
  const f = await fixture();
  try {
    const task = await f.app.tasks.create({
      title: "Legacy cron",
      prompt: "Do not execute",
      conversationId: f.anchor,
      kind: "once",
      schedule: "2099-01-01T00:00:00Z",
      timezone: "Etc/UTC",
      delivery: "web",
      enabled: false,
    });
    const history = (await f.app.snapshot(f.anchor)).view.entries;
    const before = routing(f.app);
    const schedules = f.app.store.all("SELECT * FROM tasks");
    // Simulate pre-separation rows: the migration must inspect the old ledgers.
    f.app.store.run("DELETE FROM conversation_channels");
    await f.restart();
    assert.equal(
      f.app.listConversations().find((c) => c.id === f.anchor)?.channel,
      "telegram",
    );
    assert.deepEqual(routing(f.app), before);
    assert.deepEqual((await f.app.snapshot(f.anchor)).view.entries, history);
    assert.deepEqual(f.app.store.all("SELECT * FROM tasks"), schedules);
    assert.equal(f.app.tasks.get(task.id)?.conversationId, f.anchor);
    assert.equal(f.app.store.all("SELECT * FROM task_runs").length, 0);
    await assert.rejects(
      f.app.submit(f.anchor, "legacy-web", "Blocked", "web"),
      /Somente leitura/,
    );
    f.app.store.run("DELETE FROM telegram_grants");
    f.app.store.run("DELETE FROM telegram");
    // A classification survives revocation; it cannot turn into writable web history.
    await f.restart();
    assert.equal(
      f.app.listConversations().find((c) => c.id === f.anchor)?.channel,
      "telegram",
    );
  } finally {
    await f.close();
  }
});

test("upgrade reattaches admitted legacy web turns, retires unadmitted ones and never mirrors their answers", async () => {
  const f = await fixture();
  try {
    await f.app.admit(
      f.anchor,
      "legacy-admitted",
      "Existing admitted turn",
      webAccess,
    );
    await settled(f.app, f.anchor);
    f.app.store.run(
      "UPDATE requests SET status='pending' WHERE requestId='legacy-admitted'",
    );
    f.app.store.run(
      "INSERT INTO requests(conversationId,requestId,text,source,status) VALUES (?,'legacy-unadmitted','Do not admit','web','pending')",
      f.anchor,
    );
    f.app.store.run(
      "DELETE FROM conversation_channels WHERE conversationId=?",
      f.anchor,
    );
    const history = (await f.app.snapshot(f.anchor)).view.entries;
    await f.restart();
    await settled(f.app, f.anchor);
    assert.deepEqual((await f.app.snapshot(f.anchor)).view.entries, history);
    assert.equal(
      f.app.store.get<{ status: string }>(
        "SELECT status FROM requests WHERE requestId='legacy-unadmitted'",
      )?.status,
      "channel_separated",
    );
    assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 0);
  } finally {
    await f.close();
  }
});

test("web task endpoints cannot mutate Telegram histories or schedules", async () => {
  const f = await fixture();
  try {
    const task = await f.app.tasks.create({
      title: "Telegram task",
      prompt: "Do not execute",
      conversationId: f.id,
      kind: "once",
      schedule: "2099-01-01T00:00:00Z",
      timezone: "Etc/UTC",
      delivery: "web",
      enabled: false,
    });
    const before = f.app.store.all("SELECT * FROM tasks");
    for (const [path, method, input] of [
      ["/api/tasks", "POST", { ...task, title: "Blocked" }],
      [`/api/tasks/${task.id}`, "PUT", { enabled: true }],
      [`/api/tasks/${task.id}`, "DELETE", {}],
      [`/api/tasks/${task.id}/run`, "POST", { requestId: "blocked-run" }],
    ] as const)
      assert.equal((await f.request(path, method, input)).status, 403);
    assert.deepEqual(f.app.store.all("SELECT * FROM tasks"), before);
    assert.equal(f.app.store.all("SELECT * FROM task_runs").length, 0);
  } finally {
    await f.close();
  }
});

test("upgrade cancels only unsent web mirror parts and preserves Telegram and cron delivery queues", async () => {
  const f = await fixture();
  try {
    f.app.store.run(
      "INSERT INTO requests(conversationId,requestId,text,source,status) VALUES (?,'old-web','Old input','web','done')",
      f.id,
    );
    f.app.store.queueTelegram(
      `${f.id}:old-web:web-input`,
      "100",
      "Old web copy",
      3500,
      f.id,
    );
    f.app.store.queueTelegram(
      `${f.id}:old-web`,
      "100",
      "Old web answer",
      3500,
      f.id,
    );
    f.app.store.queueTelegram(
      `${f.id}:telegram-turn`,
      "100",
      "Telegram reply",
      3500,
      f.id,
    );
    f.app.store.queueTelegram(
      "task-notification:fixed",
      "100",
      "Cron result",
      3500,
      f.id,
    );
    const history = (await f.app.snapshot(f.id)).view.entries;
    await f.restart();
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id=?",
        `${f.id}:old-web:0`,
      )?.state,
      "cancelled",
    );
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id=?",
        `${f.id}:old-web:web-input:0`,
      )?.state,
      "cancelled",
    );
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id=?",
        `${f.id}:telegram-turn:0`,
      )?.state,
      "pending",
    );
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id='task-notification:fixed:0'",
      )?.state,
      "pending",
    );
    assert.deepEqual((await f.app.snapshot(f.id)).view.entries, history);
  } finally {
    await f.close();
  }
});

test("global Telegram connect cannot bypass readonly to relink a Telegram history", async () => {
  const f = await fixture();
  try {
    const before = routing(f.app);
    const result = await f.request("/api/telegram/connect", "POST", {
      conversationId: f.id,
      token: "invalid-synthetic-token",
      userId: "42",
    });
    assert.equal(result.status, 403);
    assert.deepEqual(routing(f.app), before);
  } finally {
    await f.close();
  }
});

test("mirror cancellation uses exact request ownership even when IDs contain colons and share prefixes", async () => {
  const f = await fixture();
  try {
    for (const [requestId, source] of [
      ["telegram", "web"],
      ["telegram:123", "telegram"],
      ["task", "web"],
      ["task:run:1", "task"],
      ["copy", "web"],
      ["copy:web-input", "telegram"],
    ]) {
      f.app.store.run(
        "INSERT INTO requests(conversationId,requestId,text,source,status) VALUES (?,?,?,?,'done')",
        f.id,
        requestId!,
        "Synthetic",
        source!,
      );
      f.app.store.queueTelegram(
        `${f.id}:${requestId}`,
        "100",
        "Preserve exact source",
        3500,
        f.id,
      );
    }
    await f.restart();
    for (const id of ["telegram:123", "task:run:1", "copy:web-input"])
      assert.equal(
        f.app.store.get<{ state: string }>(
          "SELECT state FROM deliveries WHERE id=?",
          `${f.id}:${id}:0`,
        )?.state,
        "pending",
        id,
      );
    for (const id of ["telegram", "task", "copy"])
      assert.equal(
        f.app.store.get<{ state: string }>(
          "SELECT state FROM deliveries WHERE id=?",
          `${f.id}:${id}:0`,
        )?.state,
        "cancelled",
        id,
      );
  } finally {
    await f.close();
  }
});

test("isolated Telegram controls allow only explicit tool decisions, with session and origin checks", async () => {
  let writes = 0;
  const f = await fixture({
    call: async (_server, _tool, _args, kind) => {
      if (kind === "action") writes++;
      return { content: [{ type: "text", text: "Synthetic tool result" }] };
    },
  });
  try {
    await f.app.actions.read(f.id, "mock", "read", {});
    const action = f.app.actions.propose(f.id, 500, "mock", "write", {});
    const path = `/api/human-controls/${f.id}/actions/${action.id}`;
    assert.equal(
      (await f.request(path, "POST", { decision: "approve" }, false)).status,
      401,
    );
    assert.equal(
      (
        await f.request(
          path,
          "POST",
          { decision: "approve" },
          true,
          "https://evil.example",
        )
      ).status,
      403,
    );
    assert.equal(writes, 0);
    for (let i = 0; i < 2; i++) {
      const response = await f.request(path, "POST", { decision: "approve" });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { ok: true });
      assert.equal(
        f.app.store.actions(f.id).find((row) => row.id === action.id)!.state,
        "done",
      );
    }
    assert.equal(writes, 1);
    const denied = f.app.actions.propose(f.id, 501, "mock", "write", {});
    assert.equal(
      (
        await f.request(
          `/api/human-controls/${f.id}/actions/${denied.id}`,
          "POST",
          { decision: "deny" },
        )
      ).status,
      200,
    );
    const uncertain = f.app.actions.propose(f.id, 502, "mock", "write", {});
    f.app.store.run(
      "UPDATE actions SET state='uncertain' WHERE id=?",
      uncertain.id,
    );
    assert.equal(
      (
        await f.request(
          `/api/human-controls/${f.id}/actions/${uncertain.id}`,
          "POST",
          { decision: "reconcile", note: "Verified synthetic result" },
        )
      ).status,
      200,
    );
    await settled(f.app, f.id);
    assert.equal(writes, 1);
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM requests WHERE conversationId=? AND source='web'",
        f.id,
      ),
      undefined,
    );
    assert.equal(
      (await f.request(path + "/settings", "PUT", { modelId: "two" })).status,
      404,
    );
    assert.equal(
      (
        await f.request(`/api/conversations/${f.id}`, "PUT", {
          title: "Still blocked",
        })
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("transport delivery reconciliation is outside the approved tool and CUA exception", async () => {
  const f = await fixture();
  try {
    f.app.store.queueTelegram(
      "owned-delivery",
      "100",
      "Synthetic result",
      3500,
      f.id,
    );
    f.app.store.run(
      "UPDATE deliveries SET state='uncertain' WHERE id='owned-delivery:0'",
    );
    const before = f.app.store.all("SELECT * FROM deliveries");
    const result = await f.request(
      `/api/conversations/${f.id}/deliveries/owned-delivery:0/reconcile`,
      "POST",
      { confirm: true, note: "Cannot mutate delivery from readonly history" },
    );
    assert.equal(result.status, 403);
    assert.deepEqual(f.app.store.all("SELECT * FROM deliveries"), before);
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_delivery_resolutions").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("web excludes Telegram histories and schedules and rejects every direct history surface", async () => {
  const f = await fixture();
  try {
    const task = await f.app.tasks.create({
      title: "Private TG cron",
      prompt: "Private instructions",
      conversationId: f.id,
      kind: "cron",
      schedule: "0 0 1 1 *",
      enabled: false,
    });
    const before = routing(f.app);
    const histories = await f.app.snapshot(f.id);
    for (const suffix of [
      "",
      "?view=chat",
      "/events",
      "/history/1/0",
      "/history/1/0?view=text",
      "/actions/aaaaaaaaaaaaaaaaaaaaaaaa",
    ]) {
      const result = await f.request(`/api/conversations/${f.id}${suffix}`);
      assert.equal(result.status, 403, suffix);
      assert.doesNotMatch(
        JSON.stringify(result.body),
        /Started on Telegram|Private instructions/,
      );
    }
    assert.equal(
      (
        await f.request(`/api/conversations/${f.id}/web-visibility`, "PUT", {
          hidden: true,
        })
      ).status,
      403,
    );
    for (const path of ["/api/conversations", "/api/conversations?deleted=1"])
      assert.ok(
        !(await f.request(path)).body.some(
          (row: { id: string }) => row.id === f.id,
        ),
      );
    assert.ok(
      !(await f.request("/api/tasks")).body.some(
        (row: { id: string }) => row.id === task.id,
      ),
    );
    assert.equal((await f.request(`/api/tasks/${task.id}/runs`)).status, 403);
    assert.equal(
      (
        await f.request(
          `/api/tasks/telegram-availability?conversationId=${f.id}`,
        )
      ).status,
      403,
    );
    assert.deepEqual(routing(f.app), before);
    assert.deepEqual((await f.app.snapshot(f.id)).view, histories.view);
    assert.equal(f.app.tasks.get(task.id)!.enabled, false);
  } finally {
    await f.close();
  }
});

test("isolated controls project pending actions only without reading snapshots, evidence, results or history", async () => {
  const f = await fixture({
    call: async () => ({
      content: [{ type: "text", text: "private evidence" }],
    }),
  });
  try {
    await f.app.actions.read(f.id, "mock", "read", {});
    const pending = f.app.actions.propose(f.id, 701, "mock", "write", {
      target: "Required review argument",
    });
    const completed = f.app.actions.propose(f.id, 702, "mock", "write", {
      secret: "completed private argument",
    });
    await f.app.actions.decide(f.id, completed.id, "deny");
    const uncertain = f.app.actions.propose(f.id, 703, "mock", "write", {
      secret: "uncertain private argument",
    });
    f.app.store.run(
      "UPDATE actions SET state='uncertain',result='private result' WHERE id=?",
      uncertain.id,
    );
    f.app.snapshot = async () => {
      throw new Error("Human controls must never read a conversation snapshot");
    };
    const path = `/api/human-controls/${f.id}`;
    assert.equal((await f.request(path, "GET", undefined, false)).status, 401);
    assert.equal(
      (await f.request(`/api/human-controls/${f.anchor}`)).status,
      403,
    );
    const result = await f.request(path);
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), [
      "actions",
      "cuaHandoffs",
      "mcpCalls",
      "mcpInteractions",
    ]);
    assert.deepEqual(
      result.body.actions.map((row: { id: string }) => row.id),
      [pending.id, uncertain.id],
    );
    assert.equal(result.body.actions[0].args, pending.args);
    assert.equal(result.body.actions[1].args, undefined);
    assert.doesNotMatch(
      JSON.stringify(result.body),
      /private evidence|private result|private argument|Existing web history|Started on Telegram/,
    );
    for (const suffix of [
      "/events",
      "/messages",
      "/settings",
      "/history/1/0",
      "/deliveries/abc/reconcile",
    ]) {
      assert.equal(
        (await f.request(path + suffix, "POST", {})).status,
        404,
        suffix,
      );
      assert.equal((await f.request(path + suffix)).status, 404, suffix);
    }
  } finally {
    await f.close();
  }
});

test("Telegram status redacts a classified legacy anchor without changing the binding", async () => {
  const f = await fixture();
  try {
    f.app.store.run(
      "UPDATE telegram SET conversationId=? WHERE chat='100' AND user='42'",
      f.id,
    );
    const before = routing(f.app);
    const result = await f.request("/api/telegram");
    assert.equal(result.status, 200);
    assert.equal(result.body.conversationId, null);
    assert.equal(result.body.conversationTitle, null);
    assert.doesNotMatch(JSON.stringify(result.body), /Started on Telegram/);
    assert.deepEqual(routing(f.app), before);
  } finally {
    await f.close();
  }
});
