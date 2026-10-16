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
import { Runtime, type RuntimeOptions } from "../src/runtime.js";
import { McpGateway } from "../src/mcp.js";
import {
  Telegram,
  type TelegramUpdate,
  type TelegramTransport,
} from "../src/telegram.js";
import { telegramCommandCatalog } from "../src/telegram-commands.js";

const update = (id: number, text: string, thread?: number): TelegramUpdate => ({
  update_id: id,
  message: {
    message_id: id,
    text,
    from: { id: 42 },
    chat: { id: 100, type: "private" },
    ...(thread ? { message_thread_id: thread } : {}),
  },
});
const idOf = (result: unknown) =>
  (result as { conversationId: string }).conversationId;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-controls-"));
  const gateway = new McpGateway([
    {
      name: "cua",
      url: "https://cua.example/mcp",
      token: "local-root-test-only",
      mode: "direct",
      readTools: [],
      actionTools: [],
      cuaViewer: true,
    },
  ]);
  Object.defineProperty(gateway, "catalog", {
    value: async () => [{ server: "cua", mode: "direct", tools: [] }],
  });
  const faux = fauxProvider();
  faux.setResponses(
    Array.from({ length: 20 }, () => fauxAssistantMessage("synthetic answer")),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  let creates = 0;
  const options: RuntimeOptions = {
    dir,
    gateway,
    models,
    webOrigin: "https://pi.example",
    cuaViewerFactory: () => ({
      createTicket: async (_principal, clipboard) => {
        creates++;
        assert.equal(clipboard, false);
        return {
          url: "https://cua.example/viewer/#ticket=synthetic-private-ticket&clipboard=0",
          expiresAt: Date.now() + 1800000,
          principalId: "test",
        };
      },
    }),
  };
  let app = await Runtime.open(options);
  const anchor = await app.create("web anchor");
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
    JSON.stringify({ token: "123:synthetic-local", botId: 123 }),
  );
  const sent: {
    chat: string;
    text: string;
    options?: Parameters<TelegramTransport["send"]>[2];
  }[] = [];
  const answers: string[] = [];
  const engine = () =>
    new Telegram(
      app,
      {
        answerCallback: async (_id, text) => {
          answers.push(text);
        },
        send: async (chat, text, options) => {
          sent.push({ chat, text, options });
          return { ok: true };
        },
      },
      ["42"],
      ["100"],
      "test_pi_bot",
      true,
      123,
    );
  let bot = engine();
  return {
    get app() {
      return app;
    },
    get bot() {
      return bot;
    },
    sent,
    answers,
    faux,
    anchor,
    get creates() {
      return creates;
    },
    async idle(id: string) {
      await (await app.conversation(id)).waitForIdle(context);
      await new Promise<void>((r) => setImmediate(r));
    },
    async restart() {
      await bot.drain();
      await app.close();
      app = await Runtime.open(options);
      bot = engine();
    },
    async close() {
      await bot.drain();
      await app.close();
      await gateway.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("/topics is the advertised command and lists known topics across the authorized private chat", async () => {
  const f = await fixture();
  try {
    const a = idOf(await f.bot.receive(update(1, "/new Topic A", 11)));
    const b = idOf(await f.bot.receive(update(2, "/new Topic B", 22)));
    const result = (await f.bot.receive(update(3, "/topics", 11))) as {
      data: { id: string; messageThreadId: number }[];
    };
    assert.ok(Array.isArray(result.data));
    assert.deepEqual(
      result.data.map((r) => [r.id, r.messageThreadId]),
      [
        [b, 22],
        [a, 11],
      ],
    );
    assert.equal(
      telegramCommandCatalog.some((c) => c.command === "topics"),
      true,
    );
    assert.equal(
      telegramCommandCatalog.some((c) => c.command === "chats"),
      false,
    );
    await f.bot.flush();
    assert.match(f.sent.at(-1)!.text, /conhecidos/i);
  } finally {
    await f.close();
  }
});

test("a Telegram human CUA request queues a safe link and native control in its original topic", async () => {
  const f = await fixture();
  try {
    const id = idOf(await f.bot.receive(update(10, "/new CUA", 11)));
    f.faux.setResponses([
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: "handoff",
          name: "cua_request_handoff",
          arguments: { server: "cua" },
        },
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Waiting for human control"),
    ]);
    await f.bot.receive(update(11, "I need to take control of CUA", 11));
    await f.idle(id);
    assert.equal(f.app.cuaHandoffs!.list(id)[0].state, "pending");
    await f.bot.flush();
    assert.ok(
      f.sent.some(
        (r) =>
          r.options?.messageThreadId === 11 &&
          /intervenção|controle/i.test(r.text),
      ),
    );
    const status = (await f.bot.receive(update(12, "/cua", 11))) as {
      control?: boolean;
    };
    assert.equal(status.control, true);
    assert.equal(f.creates, 0);
    assert.doesNotMatch(
      JSON.stringify(f.sent),
      /synthetic-private-ticket|local-root-test-only/,
    );
  } finally {
    await f.close();
  }
});

const callback = (
  id: number,
  data: string,
  thread?: number,
  user = 42,
  chat = 100,
): TelegramUpdate => ({
  update_id: id,
  callback_query: {
    id: `query-${id}`,
    data,
    from: { id: user },
    message: {
      message_id: 50,
      date: 1,
      from: { id: 123 },
      chat: { id: chat, type: "private" },
      ...(thread ? { message_thread_id: thread } : {}),
    },
  },
});
function controlData(
  sent: { options?: Parameters<TelegramTransport["send"]>[2] }[],
  label: RegExp,
) {
  for (const row of [...sent].reverse()) {
    const button = row.options?.replyMarkup?.inline_keyboard
      .flat()
      .find((b) => label.test(b.text));
    if (button?.callback_data) return button.callback_data;
  }
  assert.fail(`Missing control ${label}`);
}
async function handoff(
  f: Awaited<ReturnType<typeof fixture>>,
  thread?: number,
) {
  const id = idOf(await f.bot.receive(update(10, "/new CUA", thread)));
  f.faux.setResponses([
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "handoff",
        name: "cua_request_handoff",
        arguments: { server: "cua" },
      },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Waiting for human control"),
  ]);
  await f.bot.receive(update(11, "I need to take control of CUA", thread));
  await f.idle(id);
  await f.bot.flush();
  return { id, row: f.app.cuaHandoffs!.list(id)[0] };
}

test("topic callbacks select only inside the target topic and never move source history or replay selection", async () => {
  const f = await fixture();
  try {
    const a = idOf(await f.bot.receive(update(1, "/new Topic A", 11)));
    const b = idOf(await f.bot.receive(update(2, "/new Topic B", 22)));
    await f.bot.receive(update(3, "/topics", 11));
    await f.bot.flush();
    const chooseB = controlData(f.sent, /Topic B/);
    const newerB = idOf(await f.bot.receive(update(4, "/new New B", 22)));
    assert.equal(
      f.app.telegramChats.selection({
        chat: "100",
        user: "42",
        messageThreadId: 22,
      }),
      newerB,
    );
    await f.bot.receive(callback(5, chooseB, 11));
    assert.equal(
      f.app.telegramChats.selection({
        chat: "100",
        user: "42",
        messageThreadId: 22,
      }),
      b,
    );
    assert.equal(
      f.app.telegramChats.selection({
        chat: "100",
        user: "42",
        messageThreadId: 11,
      }),
      a,
    );
    await f.bot.flush();
    assert.equal(f.sent.at(-1)?.options?.messageThreadId, 22);
    await f.bot.receive(update(6, `/topics ${newerB}`, 22));
    await f.bot.receive(callback(7, chooseB, 11));
    assert.equal(
      f.app.telegramChats.selection({
        chat: "100",
        user: "42",
        messageThreadId: 22,
      }),
      newerB,
    );
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
  } finally {
    await f.close();
  }
});

test("native CUA callbacks mint once, keep bearer outside Telegram, require explicit return attestation and passively await next human input", async () => {
  const f = await fixture();
  try {
    const { id, row } = await handoff(f, 11);
    const take = controlData(f.sent, /Assumir/);
    const before = f.app.store.all("SELECT * FROM requests").length;
    await f.bot.receive(callback(12, take, 11));
    await f.bot.flush();
    assert.equal(f.creates, 1);
    assert.equal(f.app.cuaHandoffs!.list(id)[0].state, "active");
    assert.ok(
      f.sent.some(
        (r) =>
          r.options?.messageThreadId === 11 &&
          r.options.replyMarkup?.inline_keyboard
            .flat()
            .some((b) => b.url === `https://pi.example/human-controls?c=${id}`),
      ),
    );
    await f.bot.receive(callback(13, take, 11));
    assert.equal(f.creates, 1);
    const beginReturn = controlData(f.sent, /Devolver controle/);
    await f.bot.receive(callback(14, beginReturn, 11));
    await f.bot.flush();
    assert.equal(f.app.cuaHandoffs!.holds(id), true);
    const attest = controlData(f.sent, /Fechei todas as abas/);
    await f.bot.receive(callback(15, attest, 11));
    await f.bot.flush();
    assert.equal(f.app.cuaHandoffs!.holds(id), false);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, before);
    assert.equal(f.app.cuaHandoffs!.feedback(id).length, 1);
    assert.doesNotMatch(
      JSON.stringify(f.sent),
      /synthetic-private-ticket|local-root-test-only/,
    );
    f.faux.setResponses([
      async (transcript) => {
        assert.match(JSON.stringify(transcript), /controlReturned/);
        return fauxAssistantMessage("Continued after return");
      },
    ]);
    await f.bot.receive(update(16, "Continue the authorized task", 11));
    await f.idle(id);
    assert.equal(f.app.cuaHandoffs!.feedback(id).length, 0);
    const next = f.app.cuaHandoffs!.request(id, 9000, "cua");
    await f.bot.receive(callback(17, attest, 11));
    assert.equal(
      f.app.cuaHandoffs!.list(id).find((r) => r.id === next.id)?.state,
      "pending",
    );
    assert.notEqual(next.id, row.id);
  } finally {
    await f.close();
  }
});

test("CUA controls reject wrong owner, chat, topic, credential binding, expired nonce and revoked grant", async () => {
  const f = await fixture();
  try {
    const { id } = await handoff(f, 11);
    const take = controlData(f.sent, /Assumir/);
    for (const bad of [
      callback(20, take, 22),
      callback(21, take, 11, 99),
      callback(22, take, 11, 42, 200),
    ])
      await f.bot.receive(bad);
    assert.equal(f.creates, 0);
    const key = `telegram:button:${take}`;
    const saved = f.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      key,
    )!.value;
    f.app.store.run(
      "UPDATE meta SET value=? WHERE key=?",
      JSON.stringify({ ...JSON.parse(saved), expiresAt: 1 }),
      key,
    );
    await f.bot.receive(callback(23, take, 11));
    assert.equal(f.creates, 0);
    f.app.store.run("UPDATE meta SET value=? WHERE key=?", saved, key);
    const credential = f.app.store.get<{ value: string }>(
      "SELECT value FROM credentials WHERE provider='telegram:bot'",
    )!.value;
    f.app.store.run(
      "UPDATE credentials SET value=? WHERE provider='telegram:bot'",
      JSON.stringify({ token: "123:rotated-local", botId: 123 }),
    );
    await f.bot.receive(callback(24, take, 11));
    assert.equal(f.creates, 0);
    f.app.store.run(
      "UPDATE credentials SET value=? WHERE provider='telegram:bot'",
      credential,
    );
    f.app.store.run("DELETE FROM telegram_grants WHERE conversationId=?", id);
    await f.bot.receive(callback(25, take, 11));
    assert.equal(f.creates, 0);
    assert.equal(f.app.cuaHandoffs!.holds(id), true);
  } finally {
    await f.close();
  }
});

test("observed topic names and closed states affect menus without creating native topics or admitting service messages", async () => {
  const f = await fixture();
  try {
    const a = idOf(await f.bot.receive(update(1, "/new A", 11)));
    const b = idOf(await f.bot.receive(update(2, "/new B", 22)));
    const service = (
      id: number,
      thread: number,
      fields: object,
    ): TelegramUpdate => ({
      update_id: id,
      message: {
        message_id: id,
        from: { id: 42 },
        chat: { id: 100, type: "private" },
        message_thread_id: thread,
        ...fields,
      },
    });
    await f.bot.receive(
      service(3, 11, { forum_topic_created: { name: "Native A" } }),
    );
    await f.bot.receive(service(4, 22, { forum_topic_closed: {} }));
    const menu = (await f.bot.receive(update(5, "/topics", 11))) as {
      data: { id: string; name: string; state: string }[];
    };
    assert.deepEqual(
      menu.data.map((r) => r.id),
      [a],
    );
    assert.equal(menu.data[0].name, "Native A");
    await f.bot.receive(
      service(6, 11, { forum_topic_edited: { name: "Renamed topic" } }),
    );
    await f.bot.receive(service(7, 22, { forum_topic_reopened: {} }));
    const fresh = (await f.bot.receive(update(8, "/topics", 11))) as {
      data: { id: string; name: string }[];
    };
    assert.deepEqual(
      fresh.data.map((r) => r.id),
      [b, a],
    );
    assert.equal(fresh.data[1].name, "Renamed topic");
    await assert.rejects(
      f.app.renameConversation(a, "Unsent web name"),
      /Conecte o Telegram/,
    );
    await f.app.deleteConversation(b);
    const after = (await f.bot.receive(update(9, "/topics", 11))) as {
      data: { id: string; title: string }[];
    };
    assert.deepEqual(
      after.data.map((r) => r.id),
      [a],
    );
    assert.equal(after.data[0].title, "Renamed topic");
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
  } finally {
    await f.close();
  }
});

test("an observed native topic is mirrored before selection without admitting history in the menu's source topic", async () => {
  const f = await fixture();
  try {
    const a = idOf(await f.bot.receive(update(1, "/new Source", 11)));
    const created = update(2, "", 33);
    delete created.message!.text;
    created.message!.forum_topic_created = { name: "Empty native topic" };
    await f.bot.receive(created);
    const result = (await f.bot.receive(update(3, "/topics", 11))) as {
      data: { id: string; messageThreadId: number; name: string }[];
    };
    assert.ok(
      result.data.some(
        (r) =>
          r.id ===
            f.app.telegramChats.selection({
              chat: "100",
              user: "42",
              messageThreadId: 33,
            }) &&
          r.messageThreadId === 33 &&
          r.name === "Empty native topic",
      ),
    );
    await f.bot.flush();
    await f.bot.receive(
      callback(4, controlData(f.sent, /Empty native topic/), 11),
    );
    const target = f.app.telegramChats.selection({
      chat: "100",
      user: "42",
      messageThreadId: 33,
    });
    assert.ok(target);
    assert.notEqual(target, a);
    assert.equal(
      f.app.telegramChats.selection({
        chat: "100",
        user: "42",
        messageThreadId: 11,
      }),
      a,
    );
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
    await f.bot.flush();
    assert.equal(f.sent.at(-1)?.options?.messageThreadId, 33);
  } finally {
    await f.close();
  }
});

test("deleted and purged conversations remove native button routes and pending menu snapshots", async () => {
  const f = await fixture();
  try {
    const a = idOf(await f.bot.receive(update(1, "/new Source", 11)));
    const b = idOf(
      await f.bot.receive(update(2, "/new Target secret title", 22)),
    );
    await f.bot.flush();
    await f.bot.receive(update(3, "/topics", 11));
    const archive = await f.app.deleteConversation(b);
    await f.bot.flush();
    assert.equal(
      f.sent.some(
        (r) => /Target secret title/.test(r.text) && /conhecidos/.test(r.text),
      ),
      false,
    );
    await f.app.purgeConversation(b, true, archive.deletedAt);
    assert.equal(
      f.app.store
        .all<{ value: string }>(
          "SELECT value FROM meta WHERE key GLOB 'telegram:button:*' OR key GLOB 'telegram:markup:*'",
        )
        .some(
          (r) =>
            r.value.includes(`\"conversationId\":\"${b}\"`) ||
            r.value.includes("Target secret title"),
        ),
      false,
    );
    assert.equal(
      f.app.telegramChats.selected({
        chat: "100",
        user: "42",
        messageThreadId: 11,
      }),
      a,
    );
    assert.deepEqual(await f.bot.receive(update(3, "/topics", 11)), {
      ignored: true,
    });
    assert.equal(
      f.app.store.get("SELECT 1 FROM conversations WHERE id=?", b),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("private unthreaded CUA controls and legacy binding authorization remain supported", async () => {
  const f = await fixture();
  try {
    const { id } = await handoff(f);
    const take = controlData(f.sent, /Assumir/);
    await f.bot.receive(callback(12, take));
    await f.bot.flush();
    assert.equal(f.creates, 1);
    assert.equal(f.app.cuaHandoffs!.list(id)[0].state, "active");
    assert.equal(f.sent.at(-1)?.options?.messageThreadId, undefined);
    await f.bot.receive(update(13, "/cua"));
    await f.bot.receive(update(13, "/cua"));
    assert.equal(f.creates, 1);
  } finally {
    await f.close();
  }
});

test("web chat input cannot start CUA in a readonly Telegram history", async () => {
  const f = await fixture();
  try {
    const id = idOf(await f.bot.receive(update(1, "/new Read only", 11)));
    await f.bot.flush();
    await assert.rejects(
      f.app.admit(id, "web-handoff", "I need to take control", {
        source: "web",
      }),
      /Somente leitura/,
    );
    assert.equal(f.app.cuaHandoffs!.list(id).length, 0);
  } finally {
    await f.close();
  }
});

test("empty topic callbacks recheck credentials, closure and grants before async creation commits ownership or selection", async (t) => {
  for (const scenario of ["credentials", "closed", "grant"])
    await t.test(scenario, async () => {
      const f = await fixture();
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let entered!: () => void;
      const paused = new Promise<void>((r) => {
        entered = r;
      });
      try {
        const source = idOf(await f.bot.receive(update(1, "/new Source", 11)));
        const empty = update(2, "", 33);
        delete empty.message!.text;
        empty.message!.forum_topic_edited = { name: "Empty" };
        await f.bot.receive(empty);
        await f.bot.receive(update(3, "/topics", 11));
        await f.bot.flush();
        const choose = controlData(f.sent, /Empty/);
        const original = f.app.harness.createConversation.bind(f.app.harness);
        Object.defineProperty(f.app.harness, "createConversation", {
          value: async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            entered();
            await gate;
            return result;
          },
        });
        const operation = f.bot.receive(callback(4, choose, 11));
        await paused;
        if (scenario === "credentials")
          f.app.store.run(
            "UPDATE credentials SET value=? WHERE provider='telegram:bot'",
            JSON.stringify({ token: "123:rotated-local", botId: 123 }),
          );
        else if (scenario === "closed") {
          const close = update(5, "", 33);
          delete close.message!.text;
          close.message!.forum_topic_closed = {};
          await f.bot.receive(close);
        } else
          f.app.store.run(
            "DELETE FROM telegram_grants WHERE conversationId=?",
            source,
          );
        release();
        await operation;
        assert.equal(
          f.app.telegramChats.selection({
            chat: "100",
            user: "42",
            messageThreadId: 33,
          }),
          undefined,
        );
        assert.equal(
          f.app.store.all(
            "SELECT * FROM telegram_topic_conversations WHERE messageThreadId=33",
          ).length,
          0,
        );
      } finally {
        release();
        await f.close();
      }
    });
});

test("native lifecycle observations are idempotent, reject changed update payloads and ignore older events", async () => {
  const f = await fixture();
  try {
    const event = (id: number, fields: object) => {
      const row = update(id, "", 11);
      delete row.message!.text;
      Object.assign(row.message!, fields);
      return row;
    };
    await f.bot.receive(
      event(2, { forum_topic_created: { name: "Original" } }),
    );
    const closed = event(3, { forum_topic_closed: {} });
    await f.bot.receive(closed);
    await f.bot.receive(event(5, { forum_topic_reopened: {} }));
    await f.bot.receive(event(6, { forum_topic_edited: { name: "Current" } }));
    await f.bot.receive(closed);
    await f.bot.receive(
      event(4, { forum_topic_edited: { name: "Out of order" } }),
    );
    const row = f.app.store.get<{ name: string; closed: number }>(
      "SELECT * FROM telegram_known_topics WHERE messageThreadId=11",
    )!;
    assert.equal(row.name, "Current");
    assert.equal(row.closed, 0);
    await assert.rejects(
      () => f.bot.receive(event(3, { forum_topic_reopened: {} })),
      /conteúdo diferente/,
    );
    const wrongTopic = event(3, { forum_topic_closed: {} });
    wrongTopic.message!.message_thread_id = 22;
    await assert.rejects(() => f.bot.receive(wrongTopic), /conteúdo diferente/);
    await f.restart();
    await f.bot.receive(closed);
    assert.equal(
      f.app.store.get<{ closed: number }>(
        "SELECT closed FROM telegram_known_topics WHERE messageThreadId=11",
      )!.closed,
      0,
    );
  } finally {
    await f.close();
  }
});

test("purging a conversation created from an empty topic invalidates every older empty-topic menu and preserves other histories", async () => {
  const f = await fixture();
  try {
    const a = idOf(await f.bot.receive(update(1, "/new Source", 11)));
    const empty = update(2, "", 33);
    delete empty.message!.text;
    empty.message!.forum_topic_created = { name: "Native secret title" };
    await f.bot.receive(empty);
    await f.bot.receive(update(3, "/topics", 11));
    await f.bot.flush();
    const first = controlData(f.sent, /Native secret title/);
    await f.bot.receive(update(4, "/topics", 11));
    await f.bot.flush();
    const second = controlData(f.sent, /Native secret title/);
    assert.notEqual(first, second);
    await f.bot.receive(callback(5, first, 11));
    await f.bot.flush();
    const b = f.app.telegramChats.selection({
      chat: "100",
      user: "42",
      messageThreadId: 33,
    })!;
    const archive = await f.app.deleteConversation(b);
    await f.app.purgeConversation(b, true, archive.deletedAt);
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM meta WHERE key=?",
        `telegram:button:${second}`,
      ),
      undefined,
    );
    assert.equal(
      f.app.store
        .all<{ value: string }>(
          "SELECT value FROM meta WHERE key GLOB 'telegram:markup:*'",
        )
        .some((r) => r.value.includes("Native secret title")),
      false,
    );
    await f.bot.receive(callback(6, second, 11));
    assert.equal(
      f.app.telegramChats.selection({
        chat: "100",
        user: "42",
        messageThreadId: 33,
      }),
      undefined,
    );
    assert.equal(
      f.app.telegramChats.selected({
        chat: "100",
        user: "42",
        messageThreadId: 11,
      }),
      a,
    );
    assert.equal(
      f.app.store.all(
        "SELECT * FROM telegram_topic_conversations WHERE messageThreadId=33",
      ).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("callback, normal and service inputs share a changed-update identity guard", async () => {
  const f = await fixture();
  try {
    await f.bot.receive(update(1, "/new Source", 11));
    await f.bot.receive(update(2, "/new Target", 22));
    await f.bot.receive(update(3, "/topics", 11));
    await f.bot.flush();
    const choose = controlData(f.sent, /Target/);
    await f.bot.receive(callback(4, choose, 11));
    await assert.rejects(
      () => f.bot.receive(update(4, "/new Changed", 11)),
      /conteúdo diferente/,
    );
    await assert.rejects(
      () => f.bot.receive(callback(2, choose, 11)),
      /conteúdo diferente/,
    );
    const service = update(5, "", 33);
    delete service.message!.text;
    service.message!.forum_topic_created = { name: "Observed" };
    await f.bot.receive(service);
    await assert.rejects(
      () => f.bot.receive(update(5, "/new Changed", 11)),
      /conteúdo diferente/,
    );
    await assert.rejects(
      () => f.bot.receive(callback(5, choose, 11)),
      /conteúdo diferente/,
    );
  } finally {
    await f.close();
  }
});

test("uncertain or creating handoffs cannot remint or release using old controls, including restart", async () => {
  const f = await fixture();
  try {
    const { id, row } = await handoff(f, 11);
    const take = controlData(f.sent, /Assumir/);
    f.app.store.run(
      "UPDATE cua_handoffs SET state='creating' WHERE id=?",
      row.id,
    );
    await f.restart();
    await f.bot.receive(callback(12, take, 11));
    await f.bot.receive(update(13, "/cua", 11));
    await f.bot.flush();
    assert.equal(f.creates, 0);
    assert.equal(f.app.cuaHandoffs!.list(id)[0].state, "uncertain");
    assert.equal(f.app.cuaHandoffs!.holds(id), true);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 1);
  } finally {
    await f.close();
  }
});

test("a newer Telegram message date accepts a lower randomized update ID after an idle week", async () => {
  const f = await fixture();
  try {
    const older = update(90000, "", 11);
    delete older.message!.text;
    older.message!.date = 1700000000;
    older.message!.forum_topic_closed = {};
    await f.bot.receive(older);
    const newer = update(50, "", 11);
    delete newer.message!.text;
    newer.message!.date = 1700700000;
    newer.message!.forum_topic_reopened = {};
    await f.bot.receive(newer);
    assert.equal(
      f.app.store.get<{ closed: number }>(
        "SELECT closed FROM telegram_known_topics WHERE messageThreadId=11",
      )!.closed,
      0,
    );
    const late = update(99999, "", 11);
    delete late.message!.text;
    late.message!.date = 1700000001;
    late.message!.forum_topic_closed = {};
    await f.bot.receive(late);
    assert.equal(
      f.app.store.get<{ closed: number }>(
        "SELECT closed FROM telegram_known_topics WHERE messageThreadId=11",
      )!.closed,
      0,
    );
  } finally {
    await f.close();
  }
});

test("malformed callbacks are ignored without admitting work or changing selection", async () => {
  const f = await fixture();
  try {
    for (const query of [
      true,
      {},
      { id: "bad", message: { chat: { id: 100, type: "private" } } },
      { id: "bad", from: { id: 42 }, message: {} },
    ]) {
      assert.deepEqual(
        await f.bot.receive({
          update_id: 30,
          callback_query: query,
        } as unknown as TelegramUpdate),
        { ignored: true },
      );
    }
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
  } finally {
    await f.close();
  }
});

test("partial native topic events retain independently observed name and state when delivered out of order", async () => {
  const f = await fixture();
  try {
    const event = (
      id: number,
      date: number,
      thread: number,
      fields: object,
    ) => {
      const row = update(id, "", thread);
      delete row.message!.text;
      row.message!.date = date;
      Object.assign(row.message!, fields);
      return row;
    };
    await f.bot.receive(update(1, "/new Source", 11));
    await f.bot.receive(
      event(11, 101, 22, {
        forum_topic_edited: { name: "Renamed while closed" },
      }),
    );
    await f.bot.receive(event(10, 100, 22, { forum_topic_closed: {} }));
    const closed = f.app.store.get<{ name: string; closed: number }>(
      "SELECT name,closed FROM telegram_known_topics WHERE messageThreadId=22",
    )!;
    assert.equal(closed.name, "Renamed while closed");
    assert.equal(closed.closed, 1);
    await f.bot.receive(event(21, 201, 33, { forum_topic_reopened: {} }));
    const ordinary = update(22, "/help", 33);
    ordinary.message!.date = 202;
    await f.bot.receive(ordinary);
    await f.bot.receive(
      event(20, 200, 33, {
        forum_topic_edited: { name: "Earlier explicit name" },
      }),
    );
    const open = f.app.store.get<{ name: string; closed: number }>(
      "SELECT name,closed FROM telegram_known_topics WHERE messageThreadId=33",
    )!;
    assert.equal(open.name, "Earlier explicit name");
    assert.equal(open.closed, 0);
    const result = (await f.bot.receive(update(30, "/topics", 11))) as {
      data: { messageThreadId: number }[];
    };
    assert.equal(
      result.data.some((r) => r.messageThreadId === 22),
      false,
    );
  } finally {
    await f.close();
  }
});

test("/controls opens only the authenticated operational page for the current topic without admitting a turn", async () => {
  const f = await fixture();
  try {
    const id = await f.app.telegramChats.ensure({
      chat: "100",
      user: "42",
      messageThreadId: 11,
    });
    const before = f.app.listConversations();
    const result = await f.bot.receive(update(1900, "/controls", 11));
    await f.bot.flush();
    assert.equal((result as { control: boolean }).control, true);
    assert.deepEqual(f.app.listConversations(), before);
    assert.ok(
      f.sent.some((row) =>
        row.options?.replyMarkup?.inline_keyboard
          .flat()
          .some((b) => b.url === `https://pi.example/human-controls?c=${id}`),
      ),
    );
    assert.equal(
      f.app.store.get("SELECT 1 FROM requests WHERE requestId='telegram:1900'"),
      undefined,
    );
  } finally {
    await f.close();
  }
});
