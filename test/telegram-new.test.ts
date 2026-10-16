import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime, ConversationBusyError } from "../src/runtime.js";
import {
  Telegram,
  type TelegramTransport,
  type TelegramUpdate,
} from "../src/telegram.js";
import { telegramCommandCatalog } from "../src/telegram-commands.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

const update = (id: number, text: string, user = 42, chat = 100) => ({
  update_id: id,
  message: {
    message_id: id,
    text,
    from: { id: user },
    chat: { id: chat, type: "private" },
  },
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-new-"));
  const options = { dir, gateway: { call: async () => ({ content: [] }) } };
  let app = await Runtime.open(options);
  const anchor = await app.create("Web original");
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
    JSON.stringify({ token: "123:fake-local-only", botId: 123 }),
  );
  const sent: string[] = [];
  const engine = (transport: Partial<TelegramTransport> = {}) =>
    new Telegram(
      app,
      {
        send: async (_chat, text) => {
          sent.push(text);
          return { ok: true };
        },
        ...transport,
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
const idOf = (value: unknown) =>
  (value as { conversationId: string }).conversationId;

const createdTopic = (
  id: number,
  name: string,
  implicit = true,
  thread = 11,
): TelegramUpdate => ({
  update_id: id,
  message: {
    message_id: thread,
    date: id,
    message_thread_id: thread,
    from: { id: 42 },
    chat: { id: 100, type: "private" },
    forum_topic_created: {
      name,
      ...(implicit ? { is_name_implicit: true } : {}),
    },
  },
});

test("implicit native /new titles lose only the command prefix and match the new Pi conversation", async () => {
  const f = await fixture();
  const renamed: { chat: string; thread: number; name: string }[] = [];
  const transport = {
    editTopicName: async (chat: string, thread: number, name: string) => {
      renamed.push({ chat, thread, name });
      return true;
    },
  };
  try {
    const cases = [
      ["/new Férias em São Paulo", "Férias em São Paulo"],
      ["/new@test_pi_bot Café & ação", "Café & ação"],
      ["/new", "Conversa Telegram"],
      ["/new O'Brien /new amanhã", "O'Brien /new amanhã"],
      ['/new "Projeto Azul"', '"Projeto Azul"'],
      ["/new ‘Plano legítimo’", "‘Plano legítimo’"],
    ];
    for (const [index, [text, name]] of cases.entries()) {
      const id = 200 + 2 * index;
      const thread = 11 + index;
      const engine = f.engine(transport);
      const service = createdTopic(id, text, true, thread);
      await engine.receive(service);
      const command = update(id + 1, text);
      const selected = idOf(
        await engine.receive({
          ...command,
          message: { ...command.message, message_thread_id: thread },
        }),
      );
      assert.equal(
        f.app.listConversations().find((c) => c.id === selected)?.title,
        name,
      );
      assert.deepEqual(renamed.at(-1), { chat: "100", thread, name });
      assert.equal(
        f.app.store.get<{ name: string }>(
          "SELECT name FROM telegram_known_topics WHERE messageThreadId=?",
          thread,
        )?.name,
        name,
      );
      await engine.receive(service);
      assert.equal(renamed.length, index + 1);
    }
    await f.restart();
    await f.engine(transport).receive(createdTopic(200, cases[0][0]));
    assert.equal(renamed.length, cases.length);
  } finally {
    await f.close();
  }
});

test("explicit and ordinary native titles are preserved and commands in existing topics do not rename them", async () => {
  const f = await fixture();
  const renamed: string[] = [];
  const engine = f.engine({
    editTopicName: async (_chat, _thread, name) => {
      renamed.push(name);
      return true;
    },
  });
  try {
    for (const [index, [name, implicit]] of [
      ["/new Nome legítimo", false],
      ["Projeto /new amanhã", true],
      ["/new@different_bot Projeto", true],
      ["/news Projeto", true],
      ["/new " + "a".repeat(101), true],
      ["/new Linha\nquebrada", true],
    ].entries()) {
      await engine.receive(
        createdTopic(
          300 + index,
          name as string,
          implicit as boolean,
          30 + index,
        ),
      );
    }
    const command = update(320, "/new Outra conversa");
    await engine.receive({
      ...command,
      message: { ...command.message, message_thread_id: 30 },
    });
    assert.deepEqual(renamed, []);
    assert.equal(
      f.app.store.get<{ name: string }>(
        "SELECT name FROM telegram_known_topics WHERE messageThreadId=30",
      )?.name,
      "/new Nome legítimo",
    );
    // A previously observed event must not gain an external effect after upgrade.
    const prior = createdTopic(321, "/new Antigo", true, 41);
    await f.engine().receive(prior);
    await engine.receive(prior);
    assert.deepEqual(renamed, []);
  } finally {
    await f.close();
  }
});

test("an uncertain native title edit is not repeated by duplicate updates or restart", async () => {
  const f = await fixture();
  let attempts = 0;
  const transport = {
    editTopicName: async () => {
      attempts++;
      throw new Error("Synthetic uncertain transport");
    },
  };
  try {
    const service = createdTopic(400, "/new Projeto");
    await f.engine(transport).receive(service);
    await f.engine(transport).receive(service);
    await f.restart();
    await f.engine(transport).receive(service);
    assert.equal(attempts, 1);
    assert.equal(
      f.app.store.get<{ name: string }>(
        "SELECT name FROM telegram_known_topics WHERE messageThreadId=11",
      )?.name,
      "/new Projeto",
    );
  } finally {
    await f.close();
  }
});

test("pending native title edits revalidate binding, credential and newer topic observations", async (t) => {
  for (const change of ["grant", "credential", "manual-name", "closed"]) {
    await t.test(change, async () => {
      const f = await fixture();
      let attempts = 0;
      const transport = {
        editTopicName: async () => {
          attempts++;
          return true;
        },
      };
      const service = createdTopic(500, "/new Projeto");
      const run = f.app.store.run.bind(f.app.store);
      try {
        // Interrupt the durable observation before the first external attempt.
        f.app.store.run = (sql, ...args) => {
          if (
            sql.startsWith("UPDATE meta SET value=") &&
            String(args[1]).startsWith("telegram:topic-title:") &&
            JSON.parse(String(args[0])).state === "uncertain"
          )
            throw new Error("Synthetic storage interruption");
          return run(sql, ...args);
        };
        await assert.rejects(
          f.engine(transport).receive(service),
          /Synthetic storage interruption/,
        );
        f.app.store.run = run;
        assert.equal(attempts, 0);
        if (change === "grant")
          f.app.store.run(
            "DELETE FROM telegram_grants WHERE conversationId=?",
            f.app.telegramChats.selection({
              chat: "100",
              user: "42",
              messageThreadId: 11,
            })!,
          );
        if (change === "credential")
          f.app.store.run(
            "UPDATE credentials SET value=? WHERE provider='telegram:bot'",
            JSON.stringify({ token: "123:changed-synthetic-only", botId: 123 }),
          );
        if (change === "manual-name" || change === "closed") {
          const edit: TelegramUpdate = {
            update_id: 501,
            message: {
              message_id: 99,
              date: 501,
              message_thread_id: 11,
              from: { id: 42 },
              chat: { id: 100, type: "private" },
              ...(change === "manual-name"
                ? { forum_topic_edited: { name: "Nome humano legítimo" } }
                : { forum_topic_closed: {} }),
            },
          };
          await f.engine(transport).receive(edit);
        }
        await f.engine(transport).receive(service);
        assert.equal(attempts, 0);
        if (change === "grant") {
          f.app.store.run(
            "INSERT INTO telegram_grants VALUES (?,?,?)",
            "100",
            "42",
            f.app.telegramChats.selection({
              chat: "100",
              user: "42",
              messageThreadId: 11,
            })!,
          );
          await f.engine(transport).receive(service);
          assert.equal(attempts, 0);
        }
      } finally {
        f.app.store.run = run;
        await f.close();
      }
    });
  }
});

test("a delayed title edit preserves a newer observed manual name and duplicate events never issue another edit", async () => {
  const f = await fixture();
  let attempts = 0;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const engine = f.engine({
    editTopicName: async () => {
      attempts++;
      entered();
      await gate;
      return true;
    },
  });
  try {
    const service = createdTopic(600, "/new Projeto");
    const first = engine.receive(service);
    await started;
    await engine.receive(service);
    await engine.receive({
      update_id: 601,
      message: {
        message_id: 99,
        date: 601,
        message_thread_id: 11,
        from: { id: 42 },
        chat: { id: 100, type: "private" },
        forum_topic_edited: { name: "Escolha posterior" },
      },
    });
    release();
    await first;
    assert.equal(attempts, 1);
    assert.equal(
      f.app.store.get<{ name: string }>(
        "SELECT name FROM telegram_known_topics WHERE messageThreadId=11",
      )?.name,
      "Escolha posterior",
    );
  } finally {
    release();
    await f.close();
  }
});

test("permanent purge scrubs native title receipts only after the last Pi history in the topic is removed", async () => {
  const f = await fixture();
  let edits = 0;
  const transport = {
    editTopicName: async () => {
      edits++;
      return true;
    },
  };
  const engine = f.engine(transport);
  const command = (id: number, thread: number) => {
    const event = update(id, "/new Synthetic title");
    return {
      ...event,
      message: { ...event.message, message_thread_id: thread },
    };
  };
  const receipt = (id: number) =>
    JSON.parse(
      f.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        `telegram:topic-title:123:${id}`,
      )!.value,
    );
  try {
    const service = createdTopic(700, "/new Synthetic title");
    await engine.receive(service);
    const native = f.app.telegramChats.selection({
      chat: "100",
      user: "42",
      messageThreadId: 11,
    })!;
    const first = idOf(await engine.receive(command(701, 11)));
    const second = idOf(await engine.receive(command(702, 11)));
    await engine.receive(
      createdTopic(703, "/new Other synthetic title", true, 22),
    );
    await engine.receive(command(704, 22));
    const otherReceipt = receipt(703);
    const nativeArchive = await f.app.deleteConversation(native);
    await f.app.purgeConversation(native, true, nativeArchive.deletedAt);
    const firstArchive = await f.app.deleteConversation(first);
    await f.app.purgeConversation(first, true, firstArchive.deletedAt);
    assert.equal(receipt(700).name, "Synthetic title");
    const secondArchive = await f.app.deleteConversation(second);
    await f.app.purgeConversation(second, true, secondArchive.deletedAt);
    assert.deepEqual(receipt(700), { state: "cancelled" });
    assert.deepEqual(receipt(703), otherReceipt);
    await f.restart();
    await f.engine(transport).receive(service);
    assert.deepEqual(receipt(700), { state: "cancelled" });
    assert.equal(edits, 2);
  } finally {
    await f.close();
  }
});

test("completion of an in-flight native title edit cannot restore payload scrubbed by permanent purge", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const engine = f.engine({
    editTopicName: async () => {
      entered();
      await gate;
      return true;
    },
  });
  try {
    const first = engine.receive(createdTopic(800, "/new Synthetic title"));
    await started;
    const command = update(801, "/new Synthetic title");
    const id = idOf(
      await engine.receive({
        ...command,
        message: { ...command.message, message_thread_id: 11 },
      }),
    );
    const native = f.app.telegramChats
      .list({ chat: "100", user: "42", messageThreadId: 11 })
      .find((row) => row.id !== id)!.id;
    const nativeArchive = await f.app.deleteConversation(native);
    await f.app.purgeConversation(native, true, nativeArchive.deletedAt);
    const archived = await f.app.deleteConversation(id);
    await f.app.purgeConversation(id, true, archived.deletedAt);
    release();
    await first;
    assert.deepEqual(
      JSON.parse(
        f.app.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key='telegram:topic-title:123:800'",
        )!.value,
      ),
      { state: "cancelled" },
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM telegram_known_topics WHERE messageThreadId=11",
      ),
      undefined,
    );
  } finally {
    release();
    await f.close();
  }
});

async function holdSettings(app: Runtime, id: string) {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = app.withConversationSettings(id, async () => {
    entered();
    await gate;
  });
  await ready;
  return async () => {
    release();
    await work;
  };
}

test("a temporarily busy binding preserves message, new and start updates for retry", async (t) => {
  for (const text of [
    "Mensagem durante ajustes",
    "/new Após ajustes",
    "/start",
  ]) {
    await t.test(text, async () => {
      const f = await fixture();
      let unlock: (() => Promise<void>) | undefined;
      try {
        const engine = f.engine();
        unlock = await holdSettings(f.app, f.anchor);
        await assert.rejects(
          engine.receive(update(100, text)),
          ConversationBusyError,
        );
        assert.equal(
          f.app.store.get("SELECT 1 FROM meta WHERE key='telegram:update:100'"),
          undefined,
        );
        assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 0);
        assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
        await unlock();
        unlock = undefined;
        const result = await engine.receive(update(100, text));
        assert.equal("control" in (result as object), false);
        if (text !== "/start") assert.ok(idOf(result));
        assert.deepEqual(await engine.receive(update(100, text)), result);
      } finally {
        await unlock?.();
        await f.close();
      }
    });
  }
});

test("a temporarily busy selected Telegram conversation does not produce deletion guidance", async () => {
  const f = await fixture();
  let unlock: (() => Promise<void>) | undefined;
  try {
    const engine = f.engine();
    const selected = idOf(
      await engine.receive(update(110, "/new Selecionada")),
    );
    unlock = await holdSettings(f.app, selected);
    await assert.rejects(
      engine.receive(update(111, "Preserve esta mensagem")),
      ConversationBusyError,
    );
    assert.equal(
      f.app.store.get("SELECT 1 FROM meta WHERE key='telegram:update:111'"),
      undefined,
    );
    await unlock();
    unlock = undefined;
    assert.equal(
      idOf(await engine.receive(update(111, "Preserve esta mensagem"))),
      selected,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE requestId='telegram:111'")
        .length,
      1,
    );
  } finally {
    await unlock?.();
    await f.close();
  }
});

test("busy bindings keep outbox pending until retry while real revocation still cancels", async () => {
  const f = await fixture();
  let unlock: (() => Promise<void>) | undefined;
  try {
    const engine = f.engine();
    f.app.store.run(
      "INSERT INTO deliveries(id,chat,text) VALUES ('busy-outbox','100','local pending reply')",
    );
    unlock = await holdSettings(f.app, f.anchor);
    await engine.flush();
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id='busy-outbox'",
      )?.state,
      "pending",
    );
    assert.equal(f.sent.length, 0);
    await unlock();
    unlock = undefined;
    await engine.flush();
    await engine.flush();
    assert.deepEqual(f.sent, ["local pending reply"]);
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id='busy-outbox'",
      )?.state,
      "sent",
    );
    await f.app.deleteConversation(f.anchor);
    f.app.store.run(
      "INSERT INTO deliveries(id,chat,text) VALUES ('revoked-outbox','100','must never send')",
    );
    await engine.flush();
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id='revoked-outbox'",
      )?.state,
      "cancelled",
    );
    assert.equal(f.sent.length, 1);
  } finally {
    await unlock?.();
    await f.close();
  }
});

test("unexpected binding failures propagate without durable recovery or outbox cancellation", async () => {
  const f = await fixture();
  try {
    const engine = f.engine();
    const binding = f.app.telegramChats.binding.bind(f.app.telegramChats);
    const authority = f.app.telegramChats.creationAuthority.bind(
      f.app.telegramChats,
    );
    f.app.telegramChats.creationAuthority = () => {
      throw new Error("synthetic storage unavailable");
    };
    f.app.telegramChats.binding = () => {
      throw new Error("synthetic storage unavailable");
    };
    for (const text of ["Mensagem", "/start"])
      await assert.rejects(
        engine.receive(update(text === "/start" ? 121 : 120, text)),
        /synthetic storage unavailable/,
      );
    f.app.store.run(
      "INSERT INTO deliveries(id,chat,text) VALUES ('storage-outbox','100','local pending reply')",
    );
    await assert.rejects(engine.flush(), /synthetic storage unavailable/);
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id='storage-outbox'",
      )?.state,
      "pending",
    );
    assert.equal(
      f.app.store.all("SELECT * FROM meta WHERE key LIKE 'telegram:update:%'")
        .length,
      0,
    );
    f.app.telegramChats.binding = binding;
    f.app.telegramChats.creationAuthority = authority;
  } finally {
    await f.close();
  }
});

test("deferred deliveries survive restart and recheck grant revocation before retry", async (t) => {
  for (const revoke of [false, true]) {
    await t.test(
      revoke ? "revoked before retry" : "authorized after restart",
      async () => {
        const f = await fixture();
        let unlock: (() => Promise<void>) | undefined;
        try {
          f.app.store.run(
            "INSERT INTO deliveries(id,chat,text) VALUES ('deferred-restart','100','local durable reply')",
          );
          unlock = await holdSettings(f.app, f.anchor);
          await f.engine().flush();
          assert.equal(
            f.app.store.get<{ state: string }>(
              "SELECT state FROM deliveries WHERE id='deferred-restart'",
            )?.state,
            "pending",
          );
          await unlock();
          unlock = undefined;
          if (revoke)
            f.app.store.run(
              "DELETE FROM telegram_grants WHERE conversationId=?",
              f.anchor,
            );
          await f.restart();
          await f.engine().flush();
          assert.equal(
            f.app.store.get<{ state: string }>(
              "SELECT state FROM deliveries WHERE id='deferred-restart'",
            )?.state,
            revoke ? "cancelled" : "sent",
          );
          assert.deepEqual(f.sent, revoke ? [] : ["local durable reply"]);
        } finally {
          await unlock?.();
          await f.close();
        }
      },
    );
  }
});

test("new is a Telegram menu command and creates a selected dedicated chat with optional title", async () => {
  const f = await fixture();
  try {
    assert.ok(telegramCommandCatalog.some((entry) => entry.command === "new"));
    const first = idOf(await f.engine().receive(update(1, "/new")));
    assert.notEqual(first, f.anchor);
    assert.equal(
      f.app.listConversations().find((row) => row.id === first)?.title,
      "Conversa Telegram",
    );
    const second = idOf(
      await f.engine().receive(update(2, "/new@test_pi_bot Viagem")),
    );
    assert.equal(
      f.app.listConversations().find((row) => row.id === second)?.title,
      "Viagem",
    );
    assert.equal(
      idOf(await f.engine().receive(update(3, "Mensagem seguinte"))),
      second,
    );
    await (await f.app.conversation(second)).waitForIdle(context);
    await f.restart();
    assert.equal(
      idOf(await f.engine().receive(update(4, "Depois do reinício"))),
      second,
    );
    await f.engine().receive(update(5, "/new@different_bot Ignorar"));
    assert.equal(
      f.app.listConversations().filter((row) => row.channel === "telegram")
        .length,
      2,
    );
  } finally {
    await f.close();
  }
});

test("relinking a new web chat with history preserves its web origin and creates a separate new Telegram chat", async () => {
  const f = await fixture();
  try {
    await f.app.deleteConversation(f.anchor);
    const web = await f.app.create("Web antes do pareamento");
    await f.app.admit(web, "web-before-link", "Mensagem web antes do vínculo", {
      source: "web",
    });
    await (await f.app.conversation(web)).waitForIdle(context);
    const before = (await f.app.snapshot(web)).view.entries;
    const engine = f.engine();
    assert.deepEqual(
      await engine.receive(update(130, `/link ${f.app.store.link(web)}`)),
      { linked: web },
    );
    assert.equal(f.app.telegramChats.dedicated(web), false);
    assert.equal(
      f.app.listConversations().find((c) => c.id === web)?.channel,
      "web",
    );
    const telegram = idOf(
      await engine.receive(update(131, "/new Contexto Telegram")),
    );
    assert.notEqual(telegram, web);
    assert.deepEqual((await f.app.snapshot(web)).view.entries, before);
    assert.equal(
      f.app.listConversations().find((c) => c.id === telegram)?.channel,
      "telegram",
    );
    await engine.receive(update(132, "Mensagem somente Telegram"));
    await (await f.app.conversation(telegram)).waitForIdle(context);
    assert.deepEqual((await f.app.snapshot(web)).view.entries, before);
    await f.app.admit(web, "web-after-link", "Continuar enviando pela web", {
      source: "web",
    });
    await (await f.app.conversation(web)).waitForIdle(context);
    await f.restart();
    assert.equal(
      f.app.listConversations().find((c) => c.id === web)?.channel,
      "web",
    );
    assert.equal(
      f.app.listConversations().find((c) => c.id === telegram)?.channel,
      "telegram",
    );
    f.app.commands.authorize(web, { source: "web" });
    assert.throws(
      () => f.app.commands.authorize(telegram, { source: "web" }),
      /Somente leitura/,
    );
    assert.equal(
      f.app.store.all(
        "SELECT * FROM requests WHERE conversationId=? AND source='web'",
        web,
      ).length,
      2,
    );
    assert.equal(
      f.app.store.all(
        "SELECT * FROM requests WHERE conversationId=? AND source='telegram'",
        web,
      ).length,
      0,
    );
    assert.equal(
      f.app.store.all(
        "SELECT * FROM requests WHERE conversationId=? AND source='telegram'",
        telegram,
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("new replaces a deleted or purged selection using an active binding and deduplicates concurrent updates", async () => {
  const f = await fixture();
  try {
    const old = idOf(await f.engine().receive(update(10, "/chats new Antiga")));
    const archived = await f.app.deleteConversation(old);
    const engine = f.engine();
    const stale = (await engine.receive(update(11, "Seleção excluída"))) as {
      error: string;
    };
    assert.match(stale.error, /\/new/);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
    await f.app.purgeConversation(old, true, archived.deletedAt);
    const [a, b] = await Promise.all([
      engine.receive(update(12, "/new Nova")),
      engine.receive(update(12, "/new Nova")),
    ]);
    assert.deepEqual(a, b);
    assert.notEqual(idOf(a), old);
    assert.equal(
      idOf(await engine.receive(update(13, "Nova mensagem"))),
      idOf(a),
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM telegram_grants WHERE conversationId=?",
        old,
      ),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("after all chats are deleted new and normal messages explain relinking without reviving grants, including purge and restart", async () => {
  const f = await fixture();
  try {
    const selected = idOf(
      await f.engine().receive(update(20, "/chats new Telegram")),
    );
    await f.app.deleteConversation(selected);
    const archived = await f.app.deleteConversation(f.anchor);
    const engine = f.engine();
    const result = (await engine.receive(update(21, "/new"))) as {
      error: string;
    };
    assert.match(result.error, /Vincular Telegram/);
    assert.match(result.error, /\/link/);
    await engine.flush();
    assert.match(f.sent.at(-1)!, /Vincular Telegram/);
    await engine.receive(update(21, "/new"));
    await engine.flush();
    assert.equal(f.sent.length, 1);
    await engine.receive(update(22, "/start"));
    await engine.flush();
    assert.equal(f.sent.length, 2);
    assert.match(f.sent.at(-1)!, /Vincular Telegram/);
    await f.app.purgeConversation(f.anchor, true, archived.deletedAt);
    await f.restart();
    const after = f.engine();
    await after.receive(update(23, "Sem silêncio"));
    await after.flush();
    assert.equal(f.sent.length, 3);
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 0);
    assert.equal(f.app.store.all("SELECT * FROM telegram").length, 0);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
    assert.equal(f.app.listConversations().length, 0);
  } finally {
    await f.close();
  }
});

test("configured metadata without a valid current credential cannot authorize control replies", async () => {
  for (const value of [
    undefined,
    "{}",
    JSON.stringify({ token: "", botId: 123 }),
    JSON.stringify({ token: "123:fake", botId: 999 }),
  ]) {
    const f = await fixture();
    try {
      await f.app.deleteConversation(f.anchor);
      f.app.store.run("DELETE FROM credentials WHERE provider='telegram:bot'");
      if (value !== undefined)
        f.app.store.run(
          "INSERT INTO credentials VALUES ('telegram:bot',?)",
          value,
        );
      const engine = f.engine();
      assert.deepEqual(await engine.receive(update(40, "/new")), {
        ignored: true,
      });
      await engine.flush();
      assert.equal(f.sent.length, 0);
      assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 0);
    } finally {
      await f.close();
    }
  }
});

test("recovery guidance is cancelled after disconnect, owner change or credential rotation and cannot drain old outbox", async () => {
  for (const change of ["disconnect", "owner", "credential"]) {
    const f = await fixture();
    try {
      await f.app.deleteConversation(f.anchor);
      const engine = f.engine();
      await engine.receive(update(30, "/new"));
      f.app.store.run(
        "INSERT INTO deliveries(id,chat,text) VALUES ('legacy-secret','100','old secret')",
      );
      if (change === "credential")
        f.app.store.run(
          "UPDATE credentials SET value=? WHERE provider='telegram:bot'",
          JSON.stringify({ token: "123:rotated-fake", botId: 123 }),
        );
      else {
        const row = f.app.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key='telegram:connection'",
        )!;
        const config = JSON.parse(row.value);
        if (change === "disconnect") config.enabled = false;
        else config.userId = "77";
        f.app.store.run(
          "UPDATE meta SET value=? WHERE key='telegram:connection'",
          JSON.stringify(config),
        );
      }
      await engine.flush();
      assert.equal(f.sent.length, 0);
      assert.equal(
        f.app.store.all("SELECT * FROM deliveries WHERE state='pending'")
          .length,
        0,
      );
      assert.deepEqual(await engine.receive(update(31, "/new", 77)), {
        ignored: true,
      });
      assert.deepEqual(await engine.receive(update(32, "/new")), {
        ignored: true,
      });
    } finally {
      await f.close();
    }
  }
});

test("canonical titles follow ordered native observations across restart without echo edits", async () => {
  const f = await fixture();
  let edits = 0;
  const transport = {
    editTopicName: async () => {
      edits++;
      return true;
    },
  };
  const title = (id: string) =>
    f.app.listConversations().find((c) => c.id === id)!;
  try {
    const id = await f.app.create("Human Pi alias", {
      chat: "100",
      user: "42",
      messageThreadId: 11,
    });
    await f
      .engine(transport)
      .receive(createdTopic(1200, "Human native name", false));
    assert.equal(title(id).title, "Human native name");
    assert.equal(title(id).piTitle, "Human native name");
    assert.equal(title(id).telegramTopicName, "Human native name");
    await assert.rejects(
      f.app.renameConversation(id, "Unsent web name"),
      /Conecte o Telegram/,
    );
    const edited = createdTopic(1202, "Renamed in Telegram", false);
    edited.message!.forum_topic_edited = { name: "Renamed in Telegram" };
    delete edited.message!.forum_topic_created;
    await f.engine(transport).receive(edited);
    await f.engine(transport).receive(createdTopic(1201, "Older event", false));
    assert.equal(title(id).title, "Renamed in Telegram");
    assert.equal(title(id).piTitle, "Renamed in Telegram");
    await f.restart();
    await f
      .engine(transport)
      .receive(createdTopic(1200, "Human native name", false));
    assert.equal(title(id).title, "Renamed in Telegram");
    assert.equal(title(id).piTitle, "Renamed in Telegram");
    assert.equal(edits, 0, "observations must not echo native edits");
  } finally {
    await f.close();
  }
});

test("uncertain ownerless legacy control is visible, explicitly audited and never resent", async () => {
  const f = await fixture();
  let sends = 0;
  const transport = {
    send: async () => {
      sends++;
      throw new Error("Synthetic lost acknowledgement");
    },
  };
  try {
    // A revoked history grant generates control guidance without a delivery owner.
    f.app.store.run(
      "DELETE FROM telegram_grants WHERE conversationId=?",
      f.anchor,
    );
    await f.engine(transport).receive(update(1300, "Synthetic input"));
    await f.engine(transport).flush();
    const row = f.app.store.get<{ id: string }>(
      "SELECT id FROM deliveries WHERE id GLOB 'telegram:control:*' AND state='uncertain'",
    )!;
    assert.ok(row);
    // Match the historical unowned, main-chat control: no scope metadata.
    f.app.store.run(
      "DELETE FROM delivery_conversations WHERE deliveryId=?",
      row.id,
    );
    if (
      f.app.store.get(
        "SELECT 1 FROM sqlite_master WHERE name='telegram_delivery_scopes'",
      )
    )
      f.app.store.run(
        "DELETE FROM telegram_delivery_scopes WHERE deliveryId=?",
        row.id,
      );
    f.app.store.run(
      "DELETE FROM meta WHERE key=?",
      `telegram:control-route:${row.id}`,
    );
    f.app.store.run(
      "UPDATE deliveries SET messageThreadId=NULL WHERE id=?",
      row.id,
    );
    f.app.store.run(
      "INSERT INTO telegram_grants VALUES ('100','42',?)",
      f.anchor,
    );
    const other = await f.app.create("Unrelated web conversation");
    const topic = await f.app.create("Other topic", {
      chat: "100",
      user: "42",
      messageThreadId: 22,
    });
    f.app.store.run(
      "INSERT INTO meta VALUES (?,?)",
      `telegram:control-route:${row.id}`,
      "{malformed legacy metadata",
    );
    const pending = (await f.app.snapshot(f.anchor, true)).deliveries as {
      id: string;
      state: string;
      blocksDeletion: boolean;
    }[];
    assert.equal(pending.find((d) => d.id === row.id)?.blocksDeletion, true);
    assert.equal((await f.app.snapshot(topic, true)).deliveries.length, 0);
    await assert.rejects(f.app.deleteConversation(f.anchor), /entrega/);
    assert.throws(
      () => f.app.reconcileDelivery(other, row.id, "Checked"),
      /encontrada/,
    );
    assert.throws(
      () => f.app.reconcileDelivery(f.anchor, row.id, "  "),
      /Nota/,
    );
    await f.restart();
    await f.engine(transport).flush();
    assert.equal(sends, 1);
    const resolved = f.app.reconcileDelivery(
      f.anchor,
      row.id,
      "Verified externally; close without resending.",
    );
    assert.equal(resolved.state, "reconciled");
    assert.ok(
      f.app.store.get(
        "SELECT 1 FROM telegram_delivery_resolutions WHERE deliveryId=? AND conversationId=?",
        row.id,
        f.anchor,
      ),
    );
    assert.throws(
      () => f.app.reconcileDelivery(f.anchor, row.id, "Again"),
      /incerta/,
    );
    f.app.store.run(
      "INSERT INTO requests(conversationId,requestId,text,status) VALUES (?,'active','synthetic','pending')",
      f.anchor,
    );
    await assert.rejects(f.app.deleteConversation(f.anchor), /pendente/);
    f.app.store.run(
      "UPDATE requests SET status='done' WHERE conversationId=?",
      f.anchor,
    );
    await f.app.deleteConversation(f.anchor);
    assert.ok(f.app.listConversations().some((c) => c.id === other));
    assert.ok(f.app.listConversations().some((c) => c.id === topic));
    await f.restart();
    await f.engine(transport).flush();
    assert.equal(sends, 1);
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id=?",
        row.id,
      )?.state,
      "reconciled",
    );
  } finally {
    await f.close();
  }
});

test("new recovery scope stays with its original anchor; active and foreign deliveries cannot be resolved", async () => {
  const f = await fixture();
  const transport = {
    send: async () => {
      throw new Error("Synthetic unknown send result");
    },
  };
  try {
    f.app.store.run(
      "DELETE FROM telegram_grants WHERE conversationId=?",
      f.anchor,
    );
    await f.engine(transport).receive(update(1400, "Synthetic recovery input"));
    await f.engine(transport).flush();
    const row = f.app.store.get<{ id: string }>(
      "SELECT id FROM deliveries WHERE id GLOB 'telegram:control:*' AND state='uncertain'",
    )!;
    assert.equal(
      f.app.store.get<{ conversationId: string }>(
        "SELECT conversationId FROM telegram_delivery_scopes WHERE deliveryId=?",
        row.id,
      )?.conversationId,
      f.anchor,
    );
    const replacement = await f.app.create("Replacement binding");
    f.app.store.consumeLink(f.app.store.link(replacement), "100", "42");
    await f.restart();
    assert.ok(
      (await f.app.snapshot(f.anchor, true)).deliveries.some(
        (d) => d.id === row.id,
      ),
    );
    assert.equal(
      (await f.app.snapshot(replacement, true)).deliveries.length,
      0,
    );
    assert.throws(
      () => f.app.reconcileDelivery(replacement, row.id, "Wrong conversation"),
      /encontrada/,
    );
    f.app.store.queueTelegram(
      `${f.anchor}:active`,
      "100",
      "synthetic active",
      3500,
      f.anchor,
    );
    f.app.store.run(
      "UPDATE deliveries SET state='sending' WHERE id=?",
      `${f.anchor}:active:0`,
    );
    assert.throws(
      () => f.app.reconcileDelivery(f.anchor, `${f.anchor}:active:0`, "No"),
      /incerta/,
    );
    await assert.rejects(f.app.deleteConversation(f.anchor), /entrega/);
    // A shared control is visible to its target but only its owner can resolve it.
    f.app.store.queueTelegram(
      "shared-control",
      "100",
      "synthetic shared",
      3500,
      replacement,
    );
    f.app.store.run(
      "UPDATE deliveries SET state='uncertain' WHERE id='shared-control:0'",
    );
    f.app.store.run(
      "INSERT INTO telegram_control_parts VALUES ('shared-control:0',?)",
      f.anchor,
    );
    const shared = (await f.app.snapshot(f.anchor, true)).deliveries.find(
      (d) => d.id === "shared-control:0",
    )!;
    assert.equal(shared.blocksDeletion, true);
    assert.equal(shared.canReconcile, false);
    assert.throws(
      () => f.app.reconcileDelivery(f.anchor, "shared-control:0", "No"),
      /encontrada/,
    );
    f.app.reconcileDelivery(
      replacement,
      "shared-control:0",
      "Verified by owner",
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM telegram_delivery_resolutions WHERE deliveryId=?",
        row.id,
      ),
      undefined,
    );
    f.app.store.db.exec(
      "CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON telegram_delivery_resolutions BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
    );
    assert.throws(
      () => f.app.reconcileDelivery(f.anchor, row.id, "Failed audit"),
      /audit failure/,
    );
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id=?",
        row.id,
      )?.state,
      "uncertain",
    );
    f.app.store.db.exec("DROP TRIGGER synthetic_audit_failure");
  } finally {
    await f.close();
  }
});
