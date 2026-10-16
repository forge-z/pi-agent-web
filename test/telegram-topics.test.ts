import { test } from "node:test";
import assert from "node:assert/strict";
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
import {
  Telegram,
  TelegramHttp,
  TelegramInputError,
  type TelegramUpdate,
  type TelegramTransport,
} from "../src/telegram.js";
import { TelegramTyping } from "../src/telegram-typing.js";
import { Store } from "../src/store.js";
import { DatabaseSync } from "node:sqlite";
import { queueTaskTelegram } from "../src/task-telegram.js";
import { TelegramTopics } from "../src/telegram-topics.js";

const update = (id: number, text: string, thread?: number): TelegramUpdate => ({
  update_id: id,
  message: {
    message_id: id,
    text,
    from: { id: 42 },
    chat: { id: 100, type: "private" },
    ...(thread === undefined ? {} : { message_thread_id: thread }),
  },
});
const idOf = (response: unknown) =>
  (response as { conversationId: string }).conversationId;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-topics-"));
  const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
  faux.setResponses(
    Array.from({ length: 30 }, () => fauxAssistantMessage("synthetic answer")),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const options = { dir, models, gateway: { call: async () => ({}) } };
  let app = await Runtime.open(options);
  const anchor = await app.create("Existing web history");
  app.store.consumeLink(app.store.link(anchor), "100", "42");
  app.store.run(
    "INSERT INTO meta VALUES (?,?)",
    "telegram:connection",
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
    JSON.stringify({ token: "123:synthetic-topics-only", botId: 123 }),
  );
  const sent: {
    chat: string;
    text: string;
    options?: { parseMode?: "HTML"; messageThreadId?: number };
  }[] = [];
  const engine = (
    typing?: TelegramTransport["typing"],
    extra: Partial<TelegramTransport> = {},
  ) =>
    new Telegram(
      app,
      {
        typing,
        send: async (chat, text, options) => {
          sent.push({ chat, text, options });
          return { ok: true };
        },
        ...extra,
      },
      ["42"],
      ["100"],
      "test_pi_bot",
      true,
      123,
    );
  return {
    get app() {
      return app;
    },
    anchor,
    engine,
    sent,
    faux,
    async idle(id: string) {
      await (await app.conversation(id)).waitForIdle(context);
      await new Promise<void>((r) => setImmediate(r));
    },
    async restart() {
      await app.close();
      app = await Runtime.open(options);
    },
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("private topics keep independent selections, histories and reply destinations alongside the legacy chat", async () => {
  const f = await fixture();
  const bot = f.engine();
  try {
    const original = (await f.app.snapshot(f.anchor)).view.entries;
    const a = idOf(await bot.receive(update(1, "topic A", 11)));
    const b = idOf(await bot.receive(update(2, "topic B", 22)));
    const legacy = idOf(await bot.receive(update(3, "legacy")));
    assert.equal(new Set([a, b, legacy, f.anchor]).size, 4);
    assert.equal(idOf(await bot.receive(update(4, "return to A", 11))), a);
    await Promise.all([f.idle(a), f.idle(b), f.idle(legacy)]);
    await bot.flush();
    assert.deepEqual((await f.app.snapshot(f.anchor)).view.entries, original);
    assert.deepEqual(
      f.sent.map((s) => s.options?.messageThreadId).sort(),
      [11, 11, 22, undefined].sort(),
    );
    await assert.rejects(
      f.app.admit(a, "web-continuation", "continue topic A in web", {
        source: "web",
      }),
      /Somente leitura/,
    );
    await f.idle(a);
    assert.equal(
      f.app.listConversations().find((c) => c.id === a)?.channel,
      "telegram",
    );
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE conversationId=?", b)
        .length,
      1,
    );
    await f.restart();
    assert.equal(
      idOf(await f.engine().receive(update(5, "persisted topic B", 22))),
      b,
    );
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("model changes and /new remain local to the current topic", async () => {
  const f = await fixture();
  const bot = f.engine();
  try {
    const a = idOf(await bot.receive(update(30, "/new A", 11)));
    const b = idOf(await bot.receive(update(31, "/new B", 22)));
    await bot.receive(update(32, "/model faux-2", 11));
    assert.equal((await f.app.settings.conversation(a)).modelId, "faux-2");
    assert.equal((await f.app.settings.conversation(b)).modelId, "faux-1");
    assert.equal(
      (await f.app.settings.conversation(f.anchor)).modelId,
      "faux-1",
    );
    const replacement = idOf(
      await bot.receive(update(33, "/new Replacement", 11)),
    );
    assert.notEqual(replacement, a);
    assert.equal(idOf(await bot.receive(update(34, "B continues", 22))), b);
    assert.equal(idOf(await bot.receive(update(35, `/chats ${a}`, 11))), a);
    await bot.receive(update(36, "A continues", 11));
    assert.equal(
      idOf(await bot.receive(update(33, "/new Replacement", 11))),
      replacement,
    );
    assert.equal(
      f.app.telegramChats.selected({
        chat: "100",
        user: "42",
        messageThreadId: 11,
      }),
      a,
    );
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("invalid, missing and non-private topic ids never fall back to the legacy history", async () => {
  const f = await fixture();
  const bot = f.engine();
  try {
    for (const thread of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      assert.deepEqual(await bot.receive(update(40, "bad", thread)), {
        ignored: true,
      });
    const missing = update(41, "missing");
    missing.message!.is_topic_message = true;
    assert.deepEqual(await bot.receive(missing), { ignored: true });
    const group = update(42, "group", 11);
    group.message!.chat.type = "supergroup";
    assert.deepEqual(await bot.receive(group), { ignored: true });
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_conversations").length,
      0,
    );
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
    const code = f.app.store.link(f.anchor);
    assert.match(
      (
        (await bot.receive(update(43, `/link ${code}`, 11))) as {
          error: string;
        }
      ).error,
      /sem tópico/,
    );
    assert.equal(f.app.store.all("SELECT * FROM links").length, 1);
    await bot.flush();
    assert.equal(f.sent.at(-1)?.options?.messageThreadId, 11);
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("queued task notifications retain their topics across selection changes and reject a wrong destination", async () => {
  const f = await fixture();
  const bot = f.engine();
  try {
    const a = idOf(await bot.receive(update(50, "/new A", 11)));
    const b = idOf(await bot.receive(update(51, "/new B", 22)));
    const queue = async (id: string, key: string) => {
      const task = await f.app.tasks.create({
        title: "Synthetic schedule",
        prompt: "synthetic",
        kind: "cron",
        schedule: "* * * * *",
        timezone: "UTC",
        conversationId: id,
        delivery: "web_telegram",
      });
      f.app.store.run(
        `INSERT INTO task_runs(id,taskId,scheduledAt,requestId,state,delivery,conversationId,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason)
         SELECT ?,id,?,?,'done',delivery,conversationId,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason FROM tasks WHERE id=?`,
        key,
        Date.now(),
        key,
        task.id,
      );
      queueTaskTelegram(
        f.app.store,
        id,
        key,
        "scheduled result " + "x".repeat(12000),
      );
    };
    await queue(a, "task-a");
    await queue(b, "task-b");
    await queue(f.anchor, "task-legacy");
    await bot.receive(update(52, "/new New A", 11));
    f.app.store.run(
      "UPDATE deliveries SET messageThreadId=99 WHERE id LIKE '%task-b:task-notification:0'",
    );
    await bot.flush();
    const notifications = f.sent.filter((s) =>
      s.text.includes("scheduled result"),
    );
    assert.deepEqual(
      notifications.map((s) => s.options?.messageThreadId).sort(),
      [11, undefined].sort(),
    );
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id LIKE '%task-b:task-notification:0'",
      )?.state,
      "cancelled",
    );
    assert.ok(
      f.sent
        .filter((s) => s.text.startsWith("x"))
        .some((s) => s.options?.messageThreadId === 22),
    );
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("revoked topic grants stay revoked after restart and cannot divert input or pending answers", async () => {
  const f = await fixture();
  let bot = f.engine();
  try {
    const a = idOf(await bot.receive(update(60, "topic A", 11)));
    const b = idOf(await bot.receive(update(61, "topic B", 22)));
    await Promise.all([f.idle(a), f.idle(b)]);
    f.app.store.run("DELETE FROM telegram_grants WHERE conversationId=?", a);
    const error = (await bot.receive(update(62, "revoked input", 11))) as {
      error: string;
    };
    assert.match(error.error, /\/new/);
    await bot.flush();
    assert.equal(
      f.sent.filter(
        (s) =>
          s.options?.messageThreadId === 11 &&
          s.text.trim() === "synthetic answer",
      ).length,
      0,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE text='revoked input'")
        .length,
      0,
    );
    await bot.drain();
    await f.restart();
    bot = f.engine();
    assert.match(
      (
        (await bot.receive(update(63, "still revoked", 11))) as {
          error: string;
        }
      ).error,
      /\/new/,
    );
    assert.equal(
      idOf(await bot.receive(update(64, "B stays available", 22))),
      b,
    );
    const fresh = idOf(await bot.receive(update(65, "/new New A", 11)));
    assert.notEqual(fresh, a);
    assert.equal(
      f.app.telegramChats.owns(a, {
        chat: "100",
        user: "42",
        messageThreadId: 11,
      }),
      false,
    );
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("topic task revocation cancels every frozen part even after regranting", async () => {
  const f = await fixture();
  const bot = f.engine();
  try {
    const a = idOf(await bot.receive(update(66, "/new Scheduled A", 11)));
    const task = await f.app.tasks.create({
      title: "Revocation",
      prompt: "synthetic",
      kind: "cron",
      schedule: "* * * * *",
      timezone: "UTC",
      conversationId: a,
      delivery: "web_telegram",
    });
    f.app.store.run(
      `INSERT INTO task_runs(id,taskId,scheduledAt,requestId,state,delivery,conversationId,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason)
         SELECT ?,id,?,?,'done',delivery,conversationId,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason FROM tasks WHERE id=?`,
      "revoked-task",
      Date.now(),
      "revoked-task",
      task.id,
    );
    queueTaskTelegram(
      f.app.store,
      a,
      "revoked-task",
      "revoked schedule " + "x".repeat(12000),
    );
    f.app.store.run("DELETE FROM telegram_grants WHERE conversationId=?", a);
    f.app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "100",
      "42",
      a,
    );
    await bot.flush();
    const parts = f.app.store.all<{ state: string; messageThreadId: number }>(
      "SELECT state,messageThreadId FROM deliveries WHERE id LIKE '%revoked-task:task-notification:%'",
    );
    assert.ok(parts.length > 1);
    assert.ok(
      parts.every((p) => p.state === "cancelled" && p.messageThreadId === 11),
    );
    assert.equal(
      f.sent.some((s) => s.text.includes("revoked schedule")),
      false,
    );
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("deleting the authorization anchor preserves an independently authorized topic", async () => {
  const f = await fixture();
  const bot = f.engine();
  try {
    const a = idOf(await bot.receive(update(67, "pending topic answer", 11)));
    await f.idle(a);
    await f.app.deleteConversation(f.anchor);
    assert.equal(
      idOf(await bot.receive(update(68, "continues independently", 11))),
      a,
    );
    await f.idle(a);
    await bot.receive(update(69, "/start", 22));
    await bot.flush();
    assert.equal(
      f.sent.filter((s) => s.text.trim() === "synthetic answer").length,
      2,
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM telegram_grants WHERE conversationId=?",
        f.anchor,
      ),
      undefined,
    );
    assert.equal(
      f.app.store.all(
        "SELECT * FROM requests WHERE text='continues independently'",
      ).length,
      1,
    );
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("schema upgrades preserve unthreaded origins, selections, grants and already pending deliveries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-topic-migration-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  db.exec(
    "CREATE TABLE telegram_conversations(conversationId TEXT PRIMARY KEY,chat TEXT NOT NULL,user TEXT NOT NULL);INSERT INTO telegram_conversations VALUES ('old','100','42');CREATE TABLE telegram_chat_selection(chat TEXT,user TEXT,conversationId TEXT NOT NULL,PRIMARY KEY(chat,user));INSERT INTO telegram_chat_selection VALUES ('100','42','old');CREATE TABLE deliveries(id TEXT PRIMARY KEY,chat TEXT,text TEXT,state TEXT DEFAULT 'pending',result TEXT,parseMode TEXT);INSERT INTO deliveries(id,chat,text) VALUES ('old:reply:0','100','old plain text');",
  );
  db.close();
  let store = new Store(dir);
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal(store.telegramThread("old"), undefined);
      assert.equal(
        store.get<{ conversationId: string }>(
          "SELECT * FROM telegram_chat_selection",
        )?.conversationId,
        "old",
      );
      assert.equal(
        store.get<{ messageThreadId: null; text: string }>(
          "SELECT * FROM deliveries",
        )?.messageThreadId,
        null,
      );
      assert.equal(
        store.get<{ text: string }>("SELECT * FROM deliveries")?.text,
        "old plain text",
      );
      assert.equal(
        store.all("SELECT * FROM telegram_topic_selection").length,
        0,
      );
      if (i === 0) {
        store.close();
        store = new Store(dir);
      }
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting and restoring one topic conversation cannot regrant it or change another topic", async () => {
  const f = await fixture();
  const bot = f.engine();
  try {
    const a = idOf(await bot.receive(update(70, "/new Delete A", 11)));
    const b = idOf(await bot.receive(update(71, "/new Keep B", 22)));
    await f.app.deleteConversation(a);
    f.app.restoreConversation(a);
    assert.match(
      ((await bot.receive(update(72, "deleted A", 11))) as { error: string })
        .error,
      /\/new/,
    );
    assert.equal(idOf(await bot.receive(update(73, "B intact", 22))), b);
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE text='deleted A'").length,
      0,
    );
    const fresh = idOf(await bot.receive(update(74, "/new Fresh A", 11)));
    assert.notEqual(fresh, a);
    const list = (await bot.receive(update(75, "/chats", 11))) as {
      data: { id: string }[];
    };
    assert.deepEqual(
      list.data.map((c) => c.id),
      [fresh],
    );
    assert.equal(
      f.app.telegramChats.selection({
        chat: "100",
        user: "42",
        messageThreadId: 22,
      }),
      b,
    );
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("simultaneous answers finishing in reverse order retain their original topics after /new", async () => {
  const f = await fixture();
  const bot = f.engine();
  let releaseA!: () => void;
  let releaseB!: () => void;
  const gateA = new Promise<void>((r) => {
    releaseA = r;
  });
  const gateB = new Promise<void>((r) => {
    releaseB = r;
  });
  f.faux.setResponses([
    async () => {
      await gateA;
      return fauxAssistantMessage("answer A");
    },
    async () => {
      await gateB;
      return fauxAssistantMessage("answer B");
    },
  ]);
  try {
    const a = idOf(await bot.receive(update(80, "A pending", 11)));
    const b = idOf(await bot.receive(update(81, "B pending", 22)));
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE status='pending'").length,
      2,
    );
    await bot.receive(update(82, "/new A replacement", 11));
    releaseB();
    await f.idle(b);
    await bot.flush();
    assert.equal(
      f.sent.find((s) => s.text.trim() === "answer B")?.options
        ?.messageThreadId,
      22,
    );
    assert.equal(
      f.sent.find((s) => s.text.trim() === "answer A"),
      undefined,
    );
    releaseA();
    await f.idle(a);
    await bot.flush();
    assert.equal(
      f.sent.find((s) => s.text.trim() === "answer A")?.options
        ?.messageThreadId,
      11,
    );
  } finally {
    releaseA();
    releaseB();
    await bot.drain();
    await f.close();
  }
});

test("approval and denial require the action's conversation in the current topic", async () => {
  const f = await fixture();
  const bot = f.engine();
  try {
    const a = idOf(await bot.receive(update(83, "/new Action A", 11)));
    await bot.receive(update(84, "/new Action B", 22));
    await f.app.actions.read(a, "mock", "read", {});
    const action = f.app.actions.propose(a, 1, "mock", "write", {});
    await assert.rejects(
      () => bot.receive(update(85, `/approve ${action.id}`, 22)),
      /nesta conversa/,
    );
    await assert.rejects(
      () => bot.receive(update(86, `/deny ${action.id}`, 22)),
      /nesta conversa/,
    );
    assert.equal(f.app.store.actions(a)[0].state, "pending");
    await bot.receive(update(87, `/approve ${action.id}`, 11));
    assert.equal(f.app.store.actions(a)[0].state, "done");
    await bot.flush();
    const receipts = f.sent.filter((s) => s.text.includes(`Ação ${action.id}`));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].options?.messageThreadId, 11);
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("typing cancellation in one topic leaves another renewing and stops all timers on drain", async (t) => {
  const f = await fixture();
  const calls: number[] = [];
  const bot = f.engine(async (_chat, options) => {
    calls.push(options!.messageThreadId!);
    return true;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  f.faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage("A");
    },
    async () => {
      await gate;
      return fauxAssistantMessage("B");
    },
  ]);
  const controller = new AbortController();
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  try {
    await bot.receive(update(90, "pending A", 11), controller.signal);
    await bot.receive(update(91, "pending B", 22));
    await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(calls, [11, 22]);
    controller.abort();
    t.mock.timers.tick(4000);
    await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(calls, [11, 22, 22]);
    await bot.drain();
    t.mock.timers.tick(8000);
    assert.deepEqual(calls, [11, 22, 22]);
  } finally {
    t.mock.timers.reset();
    release();
    await bot.drain();
    await f.close();
  }
});

test("startup reattaches pending topic inputs using their origin and rejects revoked unsent inputs", async () => {
  const f = await fixture();
  let bot = f.engine();
  try {
    const a = idOf(await bot.receive(update(100, "/new A", 11)));
    const b = idOf(await bot.receive(update(101, "/new B", 22)));
    for (const [id, key] of [
      [a, "restart-a"],
      [b, "restart-b"],
    ])
      f.app.store.run(
        "INSERT INTO requests(conversationId,requestId,text,source,chat) VALUES (?,?,?,'telegram','100')",
        id,
        key,
        "synthetic pending " + key,
      );
    f.app.store.run("DELETE FROM telegram_grants WHERE conversationId=?", a);
    await bot.drain();
    await f.restart();
    bot = f.engine();
    await f.idle(b);
    await bot.flush();
    assert.equal(
      f.app.store.get<{ status: string }>(
        "SELECT status FROM requests WHERE requestId='restart-a'",
      )?.status,
      "revoked",
    );
    assert.equal(
      f.app.store.get<{ status: string }>(
        "SELECT status FROM requests WHERE requestId='restart-b'",
      )?.status,
      "done",
    );
    assert.equal(
      f.sent.filter((s) => s.text.trim() === "synthetic answer").at(-1)?.options
        ?.messageThreadId,
      22,
    );
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("topic command selection cannot cross to another topic or an existing unthreaded history", async () => {
  const f = await fixture();
  const bot = f.engine();
  try {
    const a = idOf(await bot.receive(update(10, "/new Topic A", 11)));
    const b = idOf(await bot.receive(update(11, "/new Topic B", 22)));
    const legacy = idOf(await bot.receive(update(12, "/new Existing chat")));
    const result = (await bot.receive(update(13, "/chats", 11))) as {
      data: { id: string }[];
    };
    assert.deepEqual(
      result.data.map((c) => c.id),
      [a],
    );
    assert.match(
      ((await bot.receive(update(14, `/chats ${b}`, 11))) as { error: string })
        .error,
      /indisponível|autorizada/,
    );
    await assert.rejects(
      () => bot.receive(update(15, `/agents ${legacy}`, 11)),
      /autorizada/,
    );
    assert.equal(idOf(await bot.receive(update(16, "unchanged A", 11))), a);
    const retry = update(16, "unchanged A", 22);
    await assert.rejects(() => bot.receive(retry), TelegramInputError);
    await bot.flush();
    assert.ok(f.sent.some((s) => s.options?.messageThreadId === 11));
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("sendMessage carries the frozen topic id and leaves legacy sends unchanged", async () => {
  const original = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true }));
  };
  try {
    const http = new TelegramHttp("synthetic-test-token");
    await http.send("100", "topic", { parseMode: "HTML", messageThreadId: 22 });
    await http.send("100", "legacy");
    assert.deepEqual(bodies, [
      {
        chat_id: "100",
        text: "topic",
        parse_mode: "HTML",
        message_thread_id: 22,
      },
      { chat_id: "100", text: "legacy" },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("typing checks scale linearly across topics and clean the shared scheduler after cancellation", async (t) => {
  let checks = 0;
  const typing = new TelegramTyping(async () => true);
  const controllers: AbortController[] = [];
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  try {
    for (let i = 1; i <= 32; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      typing.start(
        i,
        "100",
        () => {
          checks++;
          return true;
        },
        { messageThreadId: i, signal: controller.signal },
      );
    }
    const before = checks;
    t.mock.timers.tick(250);
    assert.equal(checks - before, 32);
    for (const controller of controllers) controller.abort();
    const stopped = checks;
    t.mock.timers.tick(8000);
    assert.equal(checks, stopped);
  } finally {
    typing.close();
    t.mock.timers.reset();
  }
});

test("native topic creation creates one canonical web conversation before user text and across replay", async () => {
  const f = await fixture();
  const bot = f.engine();
  const created: TelegramUpdate = {
    update_id: 910,
    message: {
      message_id: 910,
      from: { id: 42 },
      chat: { id: 100, type: "private" },
      message_thread_id: 91,
      forum_topic_created: { name: "Native planning" },
    },
  };
  try {
    await bot.receive(created);
    const owner = { chat: "100", user: "42", messageThreadId: 91 };
    const id = f.app.telegramChats.selection(owner);
    assert.ok(id, "service event must create a canonical web conversation");
    assert.equal(
      f.app.listConversations().find((c) => c.id === id)?.title,
      "Native planning",
    );
    await bot.receive(created);
    assert.equal(f.app.telegramChats.list(owner).length, 1);
    await bot.drain();
    await f.restart();
    const restored = f.engine();
    await restored.receive(created);
    assert.equal(
      idOf(await restored.receive(update(911, "continue native planning", 91))),
      id,
    );
    assert.equal(f.app.telegramChats.list(owner).length, 1);
    await restored.drain();
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("an authorized topic continues input and answers after archiving the connection anchor", async () => {
  const f = await fixture();
  const bot = f.engine();
  try {
    const b = idOf(await bot.receive(update(920, "/new Keep B", 92)));
    await bot.flush();
    await f.app.deleteConversation(f.anchor);
    assert.equal(
      idOf(await bot.receive(update(921, "B after anchor archive", 92))),
      b,
    );
    await f.idle(b);
    await bot.flush();
    assert.ok(
      f.sent.some(
        (s) =>
          s.text.includes("synthetic answer") &&
          s.options?.messageThreadId === 92,
      ),
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM telegram_grants WHERE conversationId=?",
        f.anchor,
      ),
      undefined,
    );
    assert.equal(
      f.app.telegramChats.list({
        chat: "100",
        user: "42",
        messageThreadId: 92,
      })[0].id,
      b,
    );
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("uncertain sends in the old anchor never block an authorized separate topic", async () => {
  const f = await fixture();
  const bot = f.engine();
  try {
    const b = idOf(await bot.receive(update(930, "/new Keep B", 93)));
    await bot.flush();
    f.app.store.run(
      "INSERT INTO deliveries(id,chat,text,state) VALUES ('old-unknown','100','possibly sent old answer','uncertain')",
    );
    assert.equal(
      idOf(await bot.receive(update(931, "B with old uncertainty", 93))),
      b,
    );
    const fresh = idOf(
      await bot.receive(update(932, "/new New independent topic", 94)),
    );
    assert.ok(
      fresh,
      "new topic creation may use the remaining authorized B conversation",
    );
    await f.idle(b);
    await bot.flush();
    assert.ok(
      f.sent.some(
        (s) =>
          s.text.includes("synthetic answer") &&
          s.options?.messageThreadId === 93,
      ),
    );
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id='old-unknown'",
      )?.state,
      "uncertain",
    );
    assert.ok(!f.sent.some((s) => s.text === "possibly sent old answer"));
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("an interrupted native topic conversation creation is never duplicated on service replay after restart", async () => {
  const f = await fixture();
  const bot = f.engine();
  const event: TelegramUpdate = {
    update_id: 940,
    message: {
      message_id: 940,
      from: { id: 42 },
      chat: { id: 100, type: "private" },
      message_thread_id: 94,
      forum_topic_created: { name: "Interrupted native topic" },
    },
  };
  try {
    const create = f.app.create.bind(f.app);
    f.app.create = async (...args) => {
      const id = await create(...args);
      if (args[1]?.messageThreadId === 94)
        throw new Error("lost local completion");
      return id;
    };
    await assert.rejects(bot.receive(event), /lost local completion/);
    const count = f.app.listConversations().length;
    await bot.drain();
    await f.restart();
    const restored = f.engine();
    await restored.receive(event);
    assert.equal(
      f.app.listConversations().length,
      count,
      "an uncertain native create is never recreated",
    );
    assert.equal(
      f.app.telegramChats.selection({
        chat: "100",
        user: "42",
        messageThreadId: 94,
      }),
      undefined,
    );
    await restored.drain();
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("an ambiguous web topic creation blocks its matching native event while a distinct new topic still mirrors", async () => {
  const f = await fixture();
  const bot = f.engine();
  let calls = 0;
  try {
    const web = await f.app.create("Uncertain web topic");
    const topics = new TelegramTopics(f.app);
    const route = () => f.app.telegramChats.configuredOwner();
    const create = async () => {
      calls++;
      throw new Error("lost API response");
    };
    assert.equal((await topics.mirror(web, create, route)).state, "uncertain");
    const event = (
      id: number,
      thread: number,
      name: string,
    ): TelegramUpdate => ({
      update_id: id,
      message: {
        message_id: id,
        from: { id: 42 },
        chat: { id: 100, type: "private" },
        message_thread_id: thread,
        forum_topic_created: { name },
      },
    });
    await bot.receive(event(950, 95, "Uncertain web topic"));
    assert.equal(
      f.app.telegramChats.selection({
        chat: "100",
        user: "42",
        messageThreadId: 95,
      }),
      undefined,
    );
    await bot.receive(event(951, 96, "Distinct native topic"));
    const native = f.app.telegramChats.selection({
      chat: "100",
      user: "42",
      messageThreadId: 96,
    });
    assert.ok(
      native,
      "a distinct authenticated native creation remains available",
    );
    assert.notEqual(native, web);
    assert.equal((await topics.mirror(web, create, route)).state, "uncertain");
    assert.equal(calls, 1);
    assert.equal(f.app.listConversations().length, 3);
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("a revoked in-flight web topic with a lost result cannot regain its route through a native event", async () => {
  const f = await fixture();
  const bot = f.engine();
  try {
    const web = await f.app.create("Revoked web topic");
    const topics = new TelegramTopics(f.app);
    const result = await topics.mirror(
      web,
      async () => {
        f.app.store.run(
          "DELETE FROM telegram_grants WHERE conversationId=?",
          f.anchor,
        );
        f.app.store.run(
          "INSERT INTO telegram_grants VALUES ('100','42',?)",
          f.anchor,
        );
        throw new Error("lost result after authorization revocation");
      },
      () => f.app.telegramChats.configuredOwner(),
    );
    assert.equal(result.state, "cancelled");
    await bot.receive({
      update_id: 960,
      message: {
        message_id: 960,
        from: { id: 42 },
        chat: { id: 100, type: "private" },
        message_thread_id: 97,
        forum_topic_created: { name: "Revoked web topic" },
      },
    });
    assert.equal(
      f.app.telegramChats.selection({
        chat: "100",
        user: "42",
        messageThreadId: 97,
      }),
      undefined,
    );
    assert.equal(f.app.listConversations().length, 2);
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("a native creation event arriving during web topic creation keeps one canonical conversation", async () => {
  const f = await fixture();
  const topics = new TelegramTopics(f.app);
  const bot = f.engine(undefined, {
    settleTopicCreates: () => topics.settle(),
  });
  let observed: Promise<unknown> | undefined;
  try {
    const web = await f.app.create("Racing web topic");
    const result = await topics.mirror(
      web,
      () => {
        observed = bot.receive({
          update_id: 970,
          message: {
            message_id: 970,
            from: { id: 42 },
            chat: { id: 100, type: "private" },
            message_thread_id: 98,
            forum_topic_created: { name: "Racing web topic" },
          },
        });
        return Promise.resolve({ message_thread_id: 98 });
      },
      () => f.app.telegramChats.configuredOwner(),
    );
    assert.equal(result.state, "created");
    await observed;
    assert.equal(
      f.app.telegramChats.selection({
        chat: "100",
        user: "42",
        messageThreadId: 98,
      }),
      web,
    );
    assert.equal(f.app.listConversations().length, 2);
  } finally {
    await bot.drain();
    await f.close();
  }
});

test("native creation authority revocation leaves a durable cancelled receipt after regrant", async () => {
  const f = await fixture();
  const bot = f.engine();
  try {
    const original = f.app.harness.createConversation.bind(f.app.harness);
    Object.defineProperty(f.app.harness, "createConversation", {
      value: async (...args: Parameters<typeof original>) => {
        await original(...args);
        f.app.store.run(
          "DELETE FROM telegram_grants WHERE conversationId=?",
          f.anchor,
        );
        f.app.store.run(
          "INSERT INTO telegram_grants VALUES ('100','42',?)",
          f.anchor,
        );
        throw new Error("interrupted after authority revocation");
      },
    });
    const event: TelegramUpdate = {
      update_id: 980,
      message: {
        message_id: 980,
        from: { id: 42 },
        chat: { id: 100, type: "private" },
        message_thread_id: 99,
        forum_topic_created: { name: "Revoked native creation" },
      },
    };
    await assert.rejects(
      bot.receive(event),
      /interrupted after authority revocation/,
    );
    const receipt = JSON.parse(
      f.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key='telegram:native-topic-create:123:100:42:99'",
      )!.value,
    );
    assert.equal(receipt.state, "cancelled");
    assert.equal(receipt.authorityId, f.anchor);
    await bot.drain();
    await f.restart();
    const countAfterRecovery = f.app.listConversations().length;
    await f.engine().receive(event);
    assert.equal(
      f.app.telegramChats.selection({
        chat: "100",
        user: "42",
        messageThreadId: 99,
      }),
      undefined,
    );
    assert.equal(f.app.listConversations().length, countAfterRecovery);
    assert.equal(
      f.app.store.all(
        "SELECT * FROM telegram_topic_conversations WHERE messageThreadId=99",
      ).length,
      0,
    );
  } finally {
    await bot.drain();
    await f.close();
  }
});
