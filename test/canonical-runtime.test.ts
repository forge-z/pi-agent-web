import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";
import {
  TelegramConnection,
  type TelegramApi,
} from "../src/telegram-connection.js";
import { Telegram } from "../src/telegram.js";

async function fixture(schedule = false, delivery?: "web" | "web_telegram") {
  const dir = await mkdtemp(join(tmpdir(), "pi-canonical-runtime-"));
  const faux = fauxProvider();
  faux.setResponses(
    schedule
      ? [
          fauxAssistantMessage(
            {
              type: "toolCall",
              id: "cron",
              name: "tasks_create",
              arguments: {
                title: "Synthetic routine",
                prompt: "Synthetic summary",
                kind: "cron",
                schedule: "0 8 * * *",
                timezone: "UTC",
                ...(delivery === undefined ? {} : { delivery }),
              },
            },
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("Scheduled"),
        ]
      : Array.from({ length: 10 }, () =>
          fauxAssistantMessage("Synthetic answer"),
        ),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    models,
    gateway: { call: async () => ({ content: [] }) },
  });
  const anchor = await app.create("Anchor");
  app.store.consumeLink(app.store.link(anchor), "100", "42");
  app.store.run(
    "INSERT INTO meta VALUES ('telegram:connection',?)",
    JSON.stringify({
      enabled: true,
      bot: { id: 123 },
      userId: "42",
      chatId: "100",
      conversationId: anchor,
    }),
  );
  app.store.run(
    "INSERT INTO credentials VALUES ('telegram:bot',?)",
    JSON.stringify({ token: "123:synthetic-local-only", botId: 123 }),
  );
  const ownerA = { chat: "100", user: "42", messageThreadId: 101 };
  const a = await app.create("Topic A", ownerA);
  app.telegramChats.select(a, ownerA);
  return {
    app,
    anchor,
    a,
    ownerA,
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function settled(app: Runtime, id: string) {
  await (await app.conversation(id)).waitForIdle(context);
  const deadline = Date.now() + 5000;
  while (
    app.store.get(
      "SELECT 1 FROM requests WHERE conversationId=? AND status='pending'",
      id,
    )
  ) {
    assert.ok(Date.now() < deadline, "request must settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("runtime task tool captures Telegram request origin when model omits delivery", async () => {
  const f = await fixture(true);
  try {
    await f.app.admit(f.a, "telegram:1", "Create the requested daily routine", {
      source: "telegram",
      ...f.ownerA,
    });
    await settled(f.app, f.a);
    const [task] = f.app.tasks.list();
    assert.ok(task);
    assert.equal(task.delivery, "web_telegram");
    assert.equal(task.conversationId, f.a);
    const saved = f.app.store.get<{
      originRequestId: string;
      destinationMessageThreadId: number;
    }>("SELECT * FROM tasks WHERE id=?", task.id)!;
    assert.equal(saved.originRequestId, "telegram:1");
    assert.equal(saved.destinationMessageThreadId, 101);
  } finally {
    await f.close();
  }
});

test("web cannot continue Telegram topics even after the legacy anchor is archived", async () => {
  const f = await fixture();
  try {
    await f.app.deleteConversation(f.anchor);
    await assert.rejects(
      f.app.admit(f.a, "web-blocked", "Web input", { source: "web" }),
      /Somente leitura/,
    );
    assert.equal(
      f.app.store.get("SELECT 1 FROM requests WHERE requestId='web-blocked'"),
      undefined,
    );
    assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 0);
  } finally {
    await f.close();
  }
});

test("missing canonical grant blocks a web admission with reason instead of silently falling back", async () => {
  const f = await fixture();
  try {
    f.app.store.run("DELETE FROM telegram_grants WHERE conversationId=?", f.a);
    await assert.rejects(
      f.app.admit(f.a, "missing-route", "Synthetic input", { source: "web" }),
      /Somente leitura/,
    );
    assert.equal(
      f.app.store.get("SELECT 1 FROM requests WHERE requestId='missing-route'"),
      undefined,
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM telegram_grants WHERE conversationId=?",
        f.a,
      ),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("revocation while retrieving an answer cannot revive the captured reply after regrant", async () => {
  const f = await fixture();
  try {
    const lookup = f.app.harness.conversation.bind(f.app.harness);
    let revoked = false;
    f.app.harness.conversation = async (...args) => {
      const conversation = await lookup(...args);
      if (conversation && String(args[0]) === f.a) {
        const entries = conversation.entries.bind(conversation);
        conversation.entries = async (...read) => {
          const result = await entries(...read);
          if (!revoked && read[0]?.minEntryId !== undefined) {
            revoked = true;
            f.app.store.run(
              "DELETE FROM telegram_grants WHERE conversationId=?",
              f.a,
            );
            f.app.store.run(
              "INSERT INTO telegram_grants VALUES ('100','42',?)",
              f.a,
            );
          }
          return result;
        };
      }
      return conversation;
    };
    await f.app.admit(f.a, "revoked-reply", "Synthetic input", {
      source: "telegram",
      ...f.ownerA,
    });
    await settled(f.app, f.a);
    assert.ok(
      revoked,
      "revocation must occur while answer retrieval is awaited",
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM deliveries WHERE id=?",
        `${f.a}:revoked-reply:0`,
      ),
      undefined,
    );
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM request_telegram_routes WHERE requestId='revoked-reply'",
      )?.state,
      "blocked",
    );
    assert.ok(
      (await f.app.snapshot(f.a, true)).routingErrors.some(
        (error) =>
          error.requestId === "revoked-reply" && /revog/.test(error.reason),
      ),
    );
  } finally {
    await f.close();
  }
});

test("changing and restoring a grant permanently revokes an admitted request", async () => {
  const f = await fixture();
  try {
    f.app.store.run(
      "INSERT INTO request_telegram_routes VALUES (?,?,'100','42','123',101,'authorized',NULL)",
      f.a,
      "captured",
    );
    f.app.store.queueTelegram(
      `${f.a}:captured:web-input`,
      "100",
      "Synthetic input",
      3500,
      f.a,
      101,
    );
    f.app.store.run(
      "UPDATE telegram_grants SET user='99' WHERE conversationId=?",
      f.a,
    );
    f.app.store.run(
      "UPDATE telegram_grants SET user='42' WHERE conversationId=?",
      f.a,
    );
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM request_telegram_routes WHERE requestId='captured'",
      )?.state,
      "revoked",
    );
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id=?",
        `${f.a}:captured:web-input:0`,
      )?.state,
      "cancelled",
    );
  } finally {
    await f.close();
  }
});

test("a stale revoked route does not cancel a new request on a metadata-only connection update", async () => {
  const f = await fixture();
  try {
    f.app.store.run(
      "INSERT INTO request_telegram_routes VALUES (?,?,'100','42','999',101,'revoked','old bot')",
      f.a,
      "old",
    );
    f.app.store.run(
      "INSERT INTO request_telegram_routes VALUES (?,?,'100','42','123',101,'authorized',NULL)",
      f.a,
      "new",
    );
    f.app.store.queueTelegram(
      `${f.a}:new:web-input`,
      "100",
      "Synthetic new input",
      3500,
      f.a,
      101,
    );
    f.app.store.run(
      "UPDATE meta SET value=json_set(value,'$.conversationId',?) WHERE key='telegram:connection'",
      f.a,
    );
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id=?",
        `${f.a}:new:web-input:0`,
      )?.state,
      "pending",
    );
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM request_telegram_routes WHERE requestId='new'",
      )?.state,
      "authorized",
    );
  } finally {
    await f.close();
  }
});

test("replayed HTTP web creation stays separate from a later native Telegram topic", async () => {
  const f = await fixture();
  let topicCalls = 0;
  const api: TelegramApi = {
    async call(method, payload, signal) {
      if (method === "getMe")
        return { id: 123, is_bot: true, username: "synthetic_pi_bot" };
      if (method === "getWebhookInfo") return { url: "" };
      if (method === "createForumTopic") {
        topicCalls++;
        return { message_thread_id: 501, name: payload?.name };
      }
      if (method === "getUpdates") {
        if (payload?.timeout)
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        return [];
      }
      if (method === "getMyCommands") return [];
      return true;
    },
  };
  const connection = new TelegramConnection(f.app, { apiFactory: () => api });
  const origin = "http://localhost:3000";
  const web = createAppServer(f.app, {
    origin,
    password: "synthetic-password-only",
    secureCookie: false,
    telegramConnection: connection,
  });
  try {
    await connection.restore();
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
    const create = async () => {
      const response = await fetch(base + "/api/conversations", {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({
          title: "Synthetic web topic",
          requestId: "new-web-conversation",
        }),
      });
      assert.equal(response.status, 201);
      return (await response.json()) as {
        id: string;
        telegramMirror: { state: string; messageThreadId: number };
      };
    };
    const [first, second] = await Promise.all([create(), create()]);
    assert.equal(first.id, second.id);
    assert.equal(topicCalls, 0);
    assert.equal(f.app.store.telegramThread(first.id), undefined);
    const engine = new Telegram(
      f.app,
      { send: async () => ({ message_id: 1 }) },
      ["42"],
      ["100"],
      "synthetic_pi_bot",
      true,
      123,
    );
    await engine.receive({
      update_id: 500,
      message: {
        message_id: 500,
        from: { id: 42 },
        chat: { id: 100, type: "private" },
        message_thread_id: 501,
        forum_topic_created: { name: "Synthetic web topic" },
      },
    });
    await engine.drain();
    assert.equal(
      f.app.store.all(
        "SELECT c.id FROM conversations c JOIN telegram_topic_conversations p ON p.conversationId=c.id WHERE p.messageThreadId=501",
      ).length,
      1,
    );
    assert.notEqual(
      f.app.telegramChats.selection({
        chat: "100",
        user: "42",
        messageThreadId: 501,
      }),
      first.id,
    );
    assert.equal((await create()).id, first.id);
    assert.equal(topicCalls, 0);
  } finally {
    await web.close();
    await f.close();
  }
});

test("native conversation creation cannot expand grants after authority revoke and regrant during an await", async () => {
  const f = await fixture();
  try {
    const owner = { chat: "100", user: "42", messageThreadId: 901 };
    const authority = f.app.telegramChats.creationAuthority(owner);
    const create = f.app.harness.createConversation.bind(f.app.harness);
    f.app.harness.createConversation = async (...args) => {
      const result = await create(...args);
      f.app.store.run(
        "DELETE FROM telegram_grants WHERE conversationId=?",
        authority,
      );
      f.app.store.run(
        "INSERT INTO telegram_grants VALUES ('100','42',?)",
        authority,
      );
      return result;
    };
    await assert.rejects(
      f.app.create("Native synthetic", owner),
      /revogada durante/,
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM telegram_topic_conversations WHERE messageThreadId=901",
      ),
      undefined,
    );
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 2);
  } finally {
    await f.close();
  }
});

test("web creation receipts survive restart and block uncertain, changed-title and purged replays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-create-recovery-"));
  const options = { dir, gateway: { call: async () => ({ content: [] }) } };
  let app = await Runtime.open(options);
  try {
    const id = await app.createWebConversation("Synthetic saved", "saved");
    assert.throws(
      () => app.createWebConversation("Different title", "saved"),
      /título diferente/,
    );
    app.store.run(
      "INSERT INTO web_conversation_creations VALUES ('interrupted','Synthetic interrupted',NULL,'uncertain')",
    );
    await app.close();
    app = await Runtime.open(options);
    assert.equal(
      await app.createWebConversation("Synthetic saved", "saved"),
      id,
    );
    let called = false;
    const create = app.create.bind(app);
    app.create = async (...args) => {
      called = true;
      return create(...args);
    };
    assert.throws(
      () => app.createWebConversation("Synthetic interrupted", "interrupted"),
      /não confirmada/,
    );
    assert.equal(called, false);
    const archived = await app.deleteConversation(id);
    await app.purgeConversation(id, true, archived.deletedAt);
    const tombstone = app.store.get<{
      title: string | null;
      conversationId: string | null;
    }>("SELECT * FROM web_conversation_creations WHERE requestId='saved'")!;
    assert.equal(tombstone.title, null);
    assert.equal(tombstone.conversationId, null);
    assert.throws(
      () => app.createWebConversation("Synthetic saved", "saved"),
      /excluída/,
    );
    assert.equal(called, false);
    assert.equal(app.store.all("SELECT id FROM conversations").length, 0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("new task delivery follows the request channel while Telegram retains its captured topic", async () => {
  for (const source of ["web", "telegram"] as const) {
    const f = await fixture(true, "web");
    try {
      const id =
        source === "web" ? await f.app.create("Independent web task") : f.a;
      await f.app.admit(
        id,
        `${source}:canonical-default`,
        "Crie um resumo diário às 8h UTC",
        source === "telegram" ? { source, ...f.ownerA } : { source },
      );
      await settled(f.app, id);
      const [task] = f.app.tasks.list();
      assert.ok(task);
      assert.equal(
        task.delivery,
        source === "telegram" ? "web_telegram" : "web",
      );
      assert.equal(task.originSource, source);
      assert.equal(
        task.destinationMessageThreadId,
        source === "telegram" ? 101 : null,
      );
    } finally {
      await f.close();
    }
  }
});

test("canonical task tools preserve an explicit human web-only choice independent of model destination", async () => {
  for (const source of ["web", "telegram"] as const) {
    const f = await fixture(true, "web_telegram");
    try {
      const id =
        source === "web" ? await f.app.create("Independent web task") : f.a;
      await f.app.admit(
        id,
        `${source}:explicit-web-only`,
        "Crie um resumo diário às 8h UTC; somente na web.",
        source === "telegram" ? { source, ...f.ownerA } : { source },
      );
      await settled(f.app, id);
      const [task] = f.app.tasks.list();
      assert.ok(task);
      assert.equal(task.delivery, "web");
      assert.equal(task.originSource, source);
      assert.equal(task.destinationChat, null);
    } finally {
      await f.close();
    }
  }
});

test("a model cannot reverse a human channel choice through tasks_set_delivery in the creation turn", async () => {
  for (const choice of ["somente na web", "no Telegram"]) {
    const f = await fixture();
    try {
      const models = f.app.models;
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage(
          {
            type: "toolCall",
            id: "create-choice",
            name: "tasks_create",
            arguments: {
              title: "Synthetic choice",
              prompt: "Synthetic summary",
              kind: "cron",
              schedule: "0 8 * * *",
              timezone: "UTC",
            },
          },
          { stopReason: "toolUse" },
        ),
        async () =>
          fauxAssistantMessage(
            {
              type: "toolCall",
              id: "reverse-choice",
              name: "tasks_set_delivery",
              arguments: {
                taskId: f.app.tasks.list()[0]!.id,
                delivery: choice === "somente na web" ? "web_telegram" : "web",
              },
            },
            { stopReason: "toolUse" },
          ),
        fauxAssistantMessage("Synthetic final answer"),
      ]);
      models.setProvider(faux.provider);
      await f.app.admit(
        f.a,
        "channel-choice",
        `Crie um resumo diário; entregue ${choice}.`,
        { source: "telegram", ...f.ownerA },
      );
      await settled(f.app, f.a);
      const task = f.app.tasks.list()[0]!;
      assert.equal(
        task.delivery,
        choice === "somente na web" ? "web" : "web_telegram",
      );
      assert.equal(
        f.app.store.all("SELECT * FROM task_delivery_changes").length,
        0,
      );
      assert.equal(
        f.app.store.all("SELECT * FROM task_runs").length,
        0,
        "no cron should run",
      );
    } finally {
      await f.close();
    }
  }
});

test("task delivery requires a channel directive in the active request, not an unrelated change and mention", async () => {
  const f = await fixture();
  try {
    const task = await f.app.tasks.create({
      conversationId: f.a,
      title: "Synthetic saved task",
      prompt: "Synthetic report",
      kind: "cron",
      schedule: "0 8 * * *",
      timezone: "UTC",
      delivery: "web",
    });
    const faux = fauxProvider();
    f.app.models.setProvider(faux.provider);
    const cases = [
      {
        text: "Change the schedule to 9 AM. I use Telegram.",
        desired: "web_telegram",
        expected: "web",
      },
      {
        text: "Update the task I created on Telegram to run at 9 AM.",
        desired: "web_telegram",
        expected: "web",
      },
      {
        text: "Show me how to change the delivery to Telegram.",
        desired: "web_telegram",
        expected: "web",
      },
      {
        text: "Change the delivery to Telegram if I approve later.",
        desired: "web_telegram",
        expected: "web",
      },
      {
        text: "Change the title to Telegram.",
        desired: "web_telegram",
        expected: "web",
      },
      {
        text: "Change the delivery to Telegram.",
        desired: "web_telegram",
        expected: "web_telegram",
      },
      {
        text: "Show me how to change the delivery to web only.",
        desired: "web",
        expected: "web_telegram",
      },
      {
        text: "Change the delivery to web only if I approve later.",
        desired: "web",
        expected: "web_telegram",
      },
      {
        text: "Mude a entrega somente na web.",
        desired: "web",
        expected: "web",
      },
    ];
    for (const [index, c] of cases.entries()) {
      faux.setResponses([
        fauxAssistantMessage(
          {
            type: "toolCall",
            id: `delivery-${index}`,
            name: "tasks_set_delivery",
            arguments: { taskId: task.id, delivery: c.desired },
          },
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Synthetic answer after tool result"),
      ]);
      await f.app.admit(f.a, `delivery-directive-${index}`, c.text, {
        source: "telegram",
        ...f.ownerA,
      });
      await settled(f.app, f.a);
      assert.equal(
        f.app.tasks.list().find((t) => t.id === task.id)?.delivery,
        c.expected,
        c.text,
      );
    }
    assert.equal(
      f.app.store.all("SELECT * FROM task_delivery_changes").length,
      2,
    );
    assert.equal(f.app.store.all("SELECT * FROM task_runs").length, 0);
  } finally {
    await f.close();
  }
});
