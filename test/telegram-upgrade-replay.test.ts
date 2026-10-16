import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Runtime } from "../src/runtime.js";
import {
  Telegram,
  TelegramInputError,
  type TelegramUpdate,
} from "../src/telegram.js";
import { TelegramConnection } from "../src/telegram-connection.js";
import { hash } from "../src/store.js";

const update = (
  text = "synthetic upgrade input",
  thread?: number,
): TelegramUpdate => ({
  update_id: 70,
  message: {
    message_id: 70,
    text,
    from: { id: 42 },
    chat: { id: 100, type: "private" },
    ...(thread === undefined ? {} : { message_thread_id: thread }),
  },
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-upgrade-replay-"));
  let writes = 0;
  const options = {
    dir,
    mode: "demo" as const,
    gateway: {
      call: async (
        _server: string,
        _tool: string,
        _args: unknown,
        effect: string,
      ) => {
        if (effect === "action") writes++;
        return { content: [] };
      },
    },
  };
  let app = await Runtime.open(options);
  const anchor = await app.create("Original web binding");
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
    JSON.stringify({ token: "123:synthetic-only", botId: 123 }),
  );
  const sent: { text: string; thread?: number }[] = [];
  const engine = () =>
    new Telegram(
      app,
      {
        send: async (_chat, text, opts) => {
          sent.push({ text, thread: opts?.messageThreadId });
          return { ok: true };
        },
      },
      ["42"],
      ["100"],
      "synthetic_bot",
      true,
      123,
    );
  let bot = engine();
  let manager = new TelegramConnection(app, {
    apiFactory: () => {
      throw new Error("No network allowed");
    },
  });
  return {
    get app() {
      return app;
    },
    get bot() {
      return bot;
    },
    get writes() {
      return writes;
    },
    anchor,
    sent,
    async idle(id: string) {
      await (await app.conversation(id)).waitForIdle(context);
      await new Promise<void>((r) => setImmediate(r));
    },
    consume: (value: TelegramUpdate) =>
      (
        manager as unknown as {
          consume(
            value: TelegramUpdate,
            engine: Telegram,
            signal: AbortSignal,
          ): Promise<void>;
        }
      ).consume(value, bot, new AbortController().signal),
    async restart(legacy = false) {
      await bot.drain();
      await manager.close();
      await app.close();
      if (legacy) {
        const db = new DatabaseSync(join(dir, "app.sqlite"));
        // Existing ledgers have no replay provenance before this migration.
        db.exec(
          "DROP TABLE IF EXISTS telegram_legacy_updates; DELETE FROM meta WHERE key GLOB 'telegram:update-identity:*'",
        );
        db.close();
      }
      app = await Runtime.open(options);
      bot = engine();
      manager = new TelegramConnection(app, {
        apiFactory: () => {
          throw new Error("No network allowed");
        },
      });
    },
    async close() {
      await bot.drain();
      await manager.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("upgrade replay acknowledges a durable legacy result without importing history or repeating deliveries", async () => {
  const f = await fixture();
  try {
    const old = (await f.bot.receive(update())) as { conversationId: string };
    await f.idle(old.conversationId);
    await f.bot.flush();
    const before = f.app.store.get(
      "SELECT value FROM meta WHERE key='telegram:update:70'",
    );
    const sent = f.sent.length;
    await f.restart(true);
    assert.deepEqual(await f.bot.receive(update(undefined, 11)), {
      recovered: true,
    });
    await f.consume(update(undefined, 11));
    await f.bot.flush();
    assert.deepEqual(
      f.app.store.get("SELECT value FROM meta WHERE key='telegram:update:70'"),
      before,
    );
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 1);
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_topic_conversations").length,
      0,
    );
    assert.equal(f.sent.length, sent);
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM telegram_poll_receipts WHERE id=70",
      )?.state,
      "accepted",
    );
    assert.equal(
      f.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key='telegram:offset:123'",
      )?.value,
      "71",
    );
    await f.restart();
    assert.deepEqual(await f.bot.receive(update(undefined, 11)), {
      recovered: true,
    });
    await assert.rejects(
      () => f.bot.receive(update(undefined, 22)),
      TelegramInputError,
    );
    await assert.rejects(() => f.bot.receive(update()), TelegramInputError);
  } finally {
    await f.close();
  }
});

test("ledger-only upgrade resumes exactly once in the delivered topic after failure before offset commit", async () => {
  const f = await fixture();
  try {
    f.app.store.run(
      "INSERT INTO telegram_updates VALUES (?,?)",
      70,
      hash(JSON.stringify(["42", "100", update().message!.text])),
    );
    await f.restart(true);
    f.app.store.db.exec(
      "CREATE TRIGGER fail_poll BEFORE INSERT ON telegram_poll_receipts BEGIN SELECT RAISE(ABORT,'mock offset crash'); END",
    );
    await assert.rejects(
      () => f.consume(update(undefined, 11)),
      /mock offset crash/,
    );
    const row = f.app.store.get<{ conversationId: string }>(
      "SELECT conversationId FROM requests WHERE requestId='telegram:70'",
    )!;
    await f.idle(row.conversationId);
    assert.equal(f.app.store.telegramThread(row.conversationId), 11);
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_poll_receipts").length,
      0,
    );
    f.app.store.db.exec("DROP TRIGGER fail_poll");
    await f.restart();
    await f.consume(update(undefined, 11));
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 1);
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM telegram_poll_receipts WHERE id=70",
      )?.state,
      "accepted",
    );
    await assert.rejects(
      () => f.bot.receive(update(undefined, 22)),
      TelegramInputError,
    );
  } finally {
    await f.close();
  }
});

test("upgrade recovers a submitted legacy request even when its outer result receipt was never committed", async () => {
  const f = await fixture();
  try {
    const old = (await f.bot.receive(update())) as { conversationId: string };
    await f.idle(old.conversationId);
    f.app.store.run("DELETE FROM meta WHERE key='telegram:update:70'");
    f.app.store.run(
      "UPDATE requests SET status='pending',submissionId=NULL WHERE requestId='telegram:70'",
    );
    await f.restart(true);
    assert.deepEqual(await f.bot.receive(update(undefined, 11)), {
      recovered: true,
    });
    await f.consume(update(undefined, 11));
    await f.idle(old.conversationId);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 1);
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_topic_conversations").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("legacy command receipt without outer receipt does not create or select another conversation", async () => {
  const f = await fixture();
  try {
    const u = update("/new Original");
    const old = await f.bot.receive(u);
    const conversations = f.app.listConversations();
    f.app.store.run("DELETE FROM meta WHERE key='telegram:update:70'");
    await f.bot.flush();
    const sent = f.sent.length;
    await f.restart(true);
    assert.deepEqual(await f.bot.receive(update("/new Original", 11)), {
      recovered: true,
    });
    await f.consume(update("/new Original", 11));
    await f.bot.flush();
    assert.deepEqual(f.app.listConversations(), conversations);
    assert.equal(f.app.store.all("SELECT * FROM command_receipts").length, 1);
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_topic_selection").length,
      0,
    );
    assert.equal(f.sent.length, sent);
    assert.ok(old);
  } finally {
    await f.close();
  }
});

test("legacy approved external effect is not repeated after interruption before the update result", async () => {
  const f = await fixture();
  try {
    await f.app.actions.read(f.anchor, "mock", "read", {});
    const action = f.app.actions.propose(f.anchor, 1, "mock", "write", {});
    await f.bot.receive(update(`/approve ${action.id}`));
    assert.equal(f.writes, 1);
    f.app.store.run("DELETE FROM meta WHERE key='telegram:update:70'");
    await f.restart(true);
    await f.consume(update(`/approve ${action.id}`, 11));
    await f.restart();
    await f.consume(update(`/approve ${action.id}`, 11));
    assert.equal(f.writes, 1);
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM actions WHERE id=?",
        action.id,
      )?.state,
      "done",
    );
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM telegram_poll_receipts WHERE id=70",
      )?.state,
      "accepted",
    );
  } finally {
    await f.close();
  }
});

test("upgrade replay cannot recover legacy histories with revoked grants or an archived lifecycle", async () => {
  for (const revoke of ["grant", "archive"] as const) {
    const f = await fixture();
    try {
      const old = (await f.bot.receive(update())) as { conversationId: string };
      await f.idle(old.conversationId);
      await f.restart(true);
      if (revoke === "grant")
        f.app.store.run(
          "DELETE FROM telegram_grants WHERE conversationId=?",
          old.conversationId,
        );
      else await f.app.deleteConversation(old.conversationId);
      await f.consume(update(undefined, 11));
      assert.equal(
        f.app.store.get<{ state: string }>(
          "SELECT state FROM telegram_poll_receipts WHERE id=70",
        )?.state,
        "rejected",
      );
      assert.equal(f.app.store.all("SELECT * FROM requests").length, 1);
      assert.equal(
        f.app.store.all("SELECT * FROM telegram_topic_conversations").length,
        0,
      );
    } finally {
      await f.close();
    }
  }
});

test("modern no-topic and topic hashes reject changes of thread, text, user and chat after restart", async () => {
  for (const thread of [undefined, 11]) {
    const f = await fixture();
    try {
      const old = (await f.bot.receive(update(undefined, thread))) as {
        conversationId: string;
      };
      await f.idle(old.conversationId);
      await f.restart();
      await assert.rejects(
        () => f.bot.receive(update(undefined, 22)),
        TelegramInputError,
      );
      await assert.rejects(
        () => f.bot.receive(update("changed", thread)),
        TelegramInputError,
      );
      for (const field of ["from", "chat"] as const) {
        const mutated = update(undefined, thread);
        mutated.message![field]!.id++;
        assert.deepEqual(await f.bot.receive(mutated), { ignored: true });
        const broader = new Telegram(
          f.app,
          { send: async () => ({}) },
          ["42", "43"],
          ["100", "101"],
          "synthetic_bot",
        );
        try {
          await assert.rejects(
            () => broader.receive(mutated),
            TelegramInputError,
          );
        } finally {
          await broader.drain();
        }
      }
      assert.equal(f.app.store.all("SELECT * FROM requests").length, 1);
    } finally {
      await f.close();
    }
  }
});

test("legacy replay scope promotion rolls back on persistence failure and retries without effects", async () => {
  const f = await fixture();
  try {
    const old = (await f.bot.receive(update())) as { conversationId: string };
    await f.idle(old.conversationId);
    await f.restart(true);
    const original = f.app.store.get(
      "SELECT * FROM telegram_updates WHERE id=70",
    );
    f.app.store.db.exec(
      "CREATE TRIGGER fail_scope BEFORE UPDATE ON telegram_legacy_updates BEGIN SELECT RAISE(ABORT,'mock scope crash'); END",
    );
    await assert.rejects(
      () => f.consume(update(undefined, 11)),
      /mock scope crash/,
    );
    assert.deepEqual(
      f.app.store.get("SELECT * FROM telegram_updates WHERE id=70"),
      original,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_poll_receipts").length,
      0,
    );
    assert.equal(
      f.app.store.get<{ replayFingerprint: string | null }>(
        "SELECT replayFingerprint FROM telegram_legacy_updates WHERE id=70",
      )?.replayFingerprint,
      null,
    );
    f.app.store.db.exec("DROP TRIGGER fail_scope");
    await f.restart();
    await f.consume(update(undefined, 11));
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM telegram_poll_receipts WHERE id=70",
      )?.state,
      "accepted",
    );
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 1);
  } finally {
    await f.close();
  }
});

test("ledger-only promotion survives interruption before admission without allowing another topic", async () => {
  const f = await fixture();
  try {
    f.app.store.run(
      "INSERT INTO telegram_updates VALUES (?,?)",
      70,
      hash(JSON.stringify(["42", "100", update().message!.text])),
    );
    await f.restart(true);
    const admit = f.app.admit.bind(f.app);
    f.app.admit = async () => {
      throw new Error("mock admission crash");
    };
    await assert.rejects(
      () => f.consume(update(undefined, 11)),
      /mock admission crash/,
    );
    f.app.admit = admit;
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_poll_receipts").length,
      0,
    );
    await f.restart();
    await assert.rejects(
      () => f.bot.receive(update(undefined, 22)),
      TelegramInputError,
    );
    await f.consume(update(undefined, 11));
    const row = f.app.store.get<{ conversationId: string }>(
      "SELECT conversationId FROM requests WHERE requestId='telegram:70'",
    )!;
    await f.idle(row.conversationId);
    assert.equal(f.app.store.telegramThread(row.conversationId), 11);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 1);
  } finally {
    await f.close();
  }
});

test("uncertain legacy commands and external writes are acknowledged without rerunning them", async () => {
  for (const kind of ["command", "action"] as const) {
    const f = await fixture();
    try {
      let text: string;
      if (kind === "command") {
        text = "/new Before interruption";
        await f.bot.receive(update(text));
        f.app.store.run(
          "UPDATE command_receipts SET state='pending',result=NULL WHERE requestId='telegram:70'",
        );
      } else {
        await f.app.actions.read(f.anchor, "mock", "read", {});
        const action = f.app.actions.propose(f.anchor, 1, "mock", "write", {});
        text = `/approve ${action.id}`;
        await f.bot.receive(update(text));
        // External effect happened but its completion could not be persisted.
        f.app.store.run(
          "UPDATE actions SET state='running',result=NULL WHERE id=?",
          action.id,
        );
        assert.equal(f.writes, 1);
      }
      f.app.store.run("DELETE FROM meta WHERE key='telegram:update:70'");
      const count = f.app.listConversations().length;
      await f.restart(true);
      await f.consume(update(text, 11));
      await f.restart();
      await f.consume(update(text, 11));
      assert.equal(f.app.listConversations().length, count);
      assert.equal(f.writes, kind === "action" ? 1 : 0);
      assert.equal(
        f.app.store.get<{ state: string }>(
          `SELECT state FROM ${kind === "command" ? "command_receipts" : "actions"}`,
        )?.state,
        "uncertain",
      );
      assert.equal(
        f.app.store.get<{ state: string }>(
          "SELECT state FROM telegram_poll_receipts WHERE id=70",
        )?.state,
        "accepted",
      );
    } finally {
      await f.close();
    }
  }
});

test("legacy compatibility never accepts changed text, owners or an already scoped pre-migration ledger", async () => {
  for (const thread of [undefined, 11]) {
    const f = await fixture();
    try {
      const prior = (await f.bot.receive(update(undefined, thread))) as {
        conversationId: string;
      };
      await f.idle(prior.conversationId);
      await f.restart(true);
      await assert.rejects(
        () => f.bot.receive(update("changed text", 11)),
        TelegramInputError,
      );
      const broader = new Telegram(
        f.app,
        { send: async () => ({}) },
        ["42", "43"],
        ["100", "101"],
        "synthetic_bot",
      );
      try {
        for (const field of ["from", "chat"] as const) {
          const mutated = update(undefined, 11);
          mutated.message![field]!.id++;
          await assert.rejects(
            () => broader.receive(mutated),
            TelegramInputError,
          );
        }
      } finally {
        await broader.drain();
      }
      if (thread !== undefined)
        await assert.rejects(
          () => f.bot.receive(update(undefined, 22)),
          TelegramInputError,
        );
      assert.equal(f.app.store.all("SELECT * FROM requests").length, 1);
    } finally {
      await f.close();
    }
  }
});

test("persisted polling receipt and legacy no-topic replay remain idempotent", async () => {
  for (const pollReceipt of [false, true]) {
    const f = await fixture();
    try {
      const old = (await f.bot.receive(update())) as { conversationId: string };
      await f.idle(old.conversationId);
      if (pollReceipt) {
        f.app.store.run(
          "INSERT INTO telegram_poll_receipts VALUES (123,70,?,'accepted')",
          hash(JSON.stringify(update(undefined, 11))),
        );
        f.app.store.run("INSERT INTO meta VALUES ('telegram:offset:123','71')");
      }
      await f.restart(true);
      await f.consume(update(undefined, pollReceipt ? 11 : undefined));
      assert.equal(
        f.app.store.get<{ state: string }>(
          "SELECT state FROM telegram_poll_receipts WHERE id=70",
        )?.state,
        "accepted",
      );
      assert.equal(f.app.store.all("SELECT * FROM requests").length, 1);
      assert.equal(
        f.app.store.all(
          "SELECT * FROM deliveries WHERE id='telegram:rejected:70'",
        ).length,
        0,
      );
    } finally {
      await f.close();
    }
  }
});

test("permanent purge blocks legacy topic replay before and after promotion with or without a polling receipt", async () => {
  for (const promoted of [false, true])
    for (const pollReceipt of [false, true]) {
      const f = await fixture();
      try {
        const original = (await f.bot.receive(update())) as {
          conversationId: string;
        };
        await f.idle(original.conversationId);
        await f.restart(true);
        if (promoted)
          assert.deepEqual(await f.bot.receive(update(undefined, 11)), {
            recovered: true,
          });
        if (pollReceipt)
          f.app.store.run(
            "INSERT INTO telegram_poll_receipts VALUES (123,70,?,'accepted')",
            hash(JSON.stringify(update(undefined, 11))),
          );
        const archived = await f.app.deleteConversation(
          original.conversationId,
        );
        await f.app.purgeConversation(
          original.conversationId,
          true,
          archived.deletedAt,
        );
        const conversations = f.app.listConversations();
        await f.consume(update(undefined, 11));
        assert.equal(
          f.app.store.get(
            "SELECT 1 FROM requests WHERE requestId='telegram:70'",
          ),
          undefined,
        );
        assert.deepEqual(f.app.listConversations(), conversations);
        assert.equal(
          f.app.store.all("SELECT * FROM telegram_topic_conversations").length,
          0,
        );
        assert.ok(
          f.app.store.get("SELECT 1 FROM telegram_purged_updates WHERE id=70"),
        );
        assert.deepEqual(
          f.app.store
            .all<{ name: string }>("PRAGMA table_info(telegram_purged_updates)")
            .map((r) => r.name),
          ["id"],
        );
        assert.deepEqual(
          {
            ...f.app.store.get<{ id: number }>(
              "SELECT * FROM telegram_purged_updates WHERE id=70",
            ),
          },
          { id: 70 },
        );
        assert.equal(
          f.app.store.get(
            "SELECT value FROM meta WHERE key='telegram:update:70'",
          ),
          undefined,
        );
        assert.equal(
          f.app.store.get("SELECT 1 FROM telegram_legacy_updates WHERE id=70"),
          undefined,
        );
        await f.bot.flush();
        assert.equal(f.sent.length, 0);
        await f.restart();
        assert.deepEqual(await f.bot.receive(update(undefined, 11)), {
          ignored: true,
        });
        assert.deepEqual(
          await f.bot.receive(update("changed purged content", 22)),
          { ignored: true },
        );
        assert.equal(
          f.app.store.get(
            "SELECT 1 FROM requests WHERE requestId='telegram:70'",
          ),
          undefined,
        );
      } finally {
        await f.close();
      }
    }
});

test("purge finds update ownership in a request when the outer Telegram result was not saved", async () => {
  const f = await fixture();
  try {
    const original = (await f.bot.receive(update())) as {
      conversationId: string;
    };
    await f.idle(original.conversationId);
    f.app.store.run("DELETE FROM meta WHERE key='telegram:update:70'");
    await f.restart(true);
    const archived = await f.app.deleteConversation(original.conversationId);
    await f.app.purgeConversation(
      original.conversationId,
      true,
      archived.deletedAt,
    );
    await f.consume(update(undefined, 11));
    assert.ok(
      f.app.store.get("SELECT 1 FROM telegram_purged_updates WHERE id=70"),
    );
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_topic_conversations").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("purge protects a command's target conversation without its outer update result", async () => {
  const f = await fixture();
  try {
    const result = (await f.bot.receive(
      update("/new Synthetic deleted title"),
    )) as { conversationId: string };
    f.app.store.run("DELETE FROM meta WHERE key='telegram:update:70'");
    await f.restart(true);
    const archived = await f.app.deleteConversation(result.conversationId);
    await f.app.purgeConversation(
      result.conversationId,
      true,
      archived.deletedAt,
    );
    const conversations = f.app.listConversations();
    await f.consume(update("/new Synthetic deleted title", 11));
    assert.deepEqual(f.app.listConversations(), conversations);
    assert.ok(
      f.app.store.get("SELECT 1 FROM telegram_purged_updates WHERE id=70"),
    );
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_topic_selection").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("purge protects a completed action through its owned decision delivery when the outer receipt is absent", async () => {
  const f = await fixture();
  try {
    const conversation = (await f.bot.receive(update())) as {
      conversationId: string;
    };
    await f.idle(conversation.conversationId);
    await f.app.actions.read(conversation.conversationId, "mock", "read", {});
    const action = f.app.actions.propose(
      conversation.conversationId,
      1,
      "mock",
      "write",
      {},
    );
    const approval = update(`/approve ${action.id}`);
    approval.update_id = 71;
    await f.bot.receive(approval);
    await f.idle(conversation.conversationId);
    f.app.store.run("DELETE FROM meta WHERE key='telegram:update:71'");
    await f.restart(true);
    const archived = await f.app.deleteConversation(
      conversation.conversationId,
    );
    await f.app.purgeConversation(
      conversation.conversationId,
      true,
      archived.deletedAt,
    );
    approval.message!.message_thread_id = 11;
    await f.consume(approval);
    assert.ok(
      f.app.store.get("SELECT 1 FROM telegram_purged_updates WHERE id=71"),
    );
    assert.equal(f.app.store.all("SELECT * FROM actions").length, 0);
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_topic_conversations").length,
      0,
    );
    assert.equal(f.writes, 1);
  } finally {
    await f.close();
  }
});

test("a failed purge rolls back the terminal marks and a retry persists them", async () => {
  const f = await fixture();
  try {
    const original = (await f.bot.receive(update())) as {
      conversationId: string;
    };
    await f.idle(original.conversationId);
    await f.restart(true);
    const archived = await f.app.deleteConversation(original.conversationId);
    f.app.store.db.exec(
      "CREATE TRIGGER fail_purge BEFORE DELETE ON requests BEGIN SELECT RAISE(ABORT,'mock purge crash'); END",
    );
    await assert.rejects(
      () =>
        f.app.purgeConversation(
          original.conversationId,
          true,
          archived.deletedAt,
        ),
      /mock purge crash/,
    );
    assert.equal(
      f.app.store.get("SELECT 1 FROM telegram_purged_updates WHERE id=70"),
      undefined,
    );
    assert.ok(
      f.app.store.get("SELECT 1 FROM requests WHERE requestId='telegram:70'"),
    );
    f.app.store.db.exec("DROP TRIGGER fail_purge");
    await f.restart();
    assert.ok(
      f.app.store.get("SELECT 1 FROM telegram_purged_updates WHERE id=70"),
    );
    await f.consume(update(undefined, 11));
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
  } finally {
    await f.close();
  }
});

test("purging one topic leaves other topics and legitimate ledger-only recovery unaffected", async () => {
  const f = await fixture();
  try {
    const a = (await f.bot.receive(update(undefined, 11))) as {
      conversationId: string;
    };
    const bUpdate = update("Other topic remains", 22);
    bUpdate.update_id = 71;
    const b = (await f.bot.receive(bUpdate)) as { conversationId: string };
    await Promise.all([f.idle(a.conversationId), f.idle(b.conversationId)]);
    const ledgerOnly = update("Unrelated pending update", 33);
    ledgerOnly.update_id = 72;
    f.app.store.run(
      "INSERT INTO telegram_updates VALUES (?,?)",
      72,
      hash(JSON.stringify(["42", "100", ledgerOnly.message!.text])),
    );
    await f.restart(true);
    const archived = await f.app.deleteConversation(a.conversationId);
    await f.app.purgeConversation(a.conversationId, true, archived.deletedAt);
    assert.deepEqual(
      f.app.store
        .all<{ id: number }>("SELECT * FROM telegram_purged_updates")
        .map((row) => ({ ...row })),
      [{ id: 70 }],
    );
    assert.deepEqual(await f.bot.receive(update(undefined, 11)), {
      ignored: true,
    });
    const other = (await f.bot.receive(bUpdate)) as { conversationId: string };
    assert.equal(other.conversationId, b.conversationId);
    const resumed = (await f.bot.receive(ledgerOnly)) as {
      conversationId: string;
    };
    await f.idle(resumed.conversationId);
    assert.equal(f.app.store.telegramThread(resumed.conversationId), 33);
    await assert.rejects(
      () =>
        f.bot.receive({
          ...ledgerOnly,
          message: { ...ledgerOnly.message!, message_thread_id: 22 },
        }),
      TelegramInputError,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE requestId='telegram:72'")
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("purging web inputs with Telegram-like request IDs does not discard unrelated Telegram updates", async () => {
  for (const command of [false, true]) {
    const f = await fixture();
    try {
      const original = (await f.bot.receive(update(undefined, 11))) as {
        conversationId: string;
      };
      await f.idle(original.conversationId);
      const web = await f.app.create("Unrelated web history");
      await f.app.admit(web, "telegram:70", command ? "/help" : "Web input", {
        source: "web",
      });
      await f.idle(web);
      const archived = await f.app.deleteConversation(web);
      await f.app.purgeConversation(web, true, archived.deletedAt);
      assert.equal(
        f.app.store.all("SELECT * FROM telegram_purged_updates").length,
        0,
      );
      const replay = (await f.bot.receive(update(undefined, 11))) as {
        conversationId: string;
      };
      assert.equal(replay.conversationId, original.conversationId);
      assert.equal(f.app.store.all("SELECT * FROM requests").length, 1);
    } finally {
      await f.close();
    }
  }
});
