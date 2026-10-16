import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, hash } from "../src/store.js";
import { TelegramChats } from "../src/telegram-chats.js";
import { ConversationBusyError, type Runtime } from "../src/runtime.js";
import { TelegramConnection } from "../src/telegram-connection.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-topic-mirror-"));
  let store = new Store(dir);
  const appObject = {
    options: { dir },
    get store() {
      return store;
    },
    assertConversationAvailable(id: string) {
      if (
        store.conversationDeleted(id) ||
        !store.get("SELECT 1 FROM conversations WHERE id=?", id)
      )
        throw new Error("unavailable conversation");
    },
    assertHandoffAvailable() {},
    telegramChats: undefined as unknown as TelegramChats,
  };
  const app = appObject as unknown as Runtime;
  appObject.telegramChats = new TelegramChats(app);
  store.run(
    "INSERT INTO conversations VALUES ('1','Authorized anchor'),('2','Web planning')",
  );
  store.run("INSERT INTO telegram VALUES ('100','1','42')");
  store.run("INSERT INTO telegram_grants VALUES ('100','42','1')");
  const identity = JSON.stringify({
    token: "123:synthetic-no-network",
    botId: 123,
  });
  store.run("INSERT INTO credentials VALUES ('telegram:bot',?)", identity);
  store.run(
    "INSERT INTO meta VALUES ('telegram:connection',?)",
    JSON.stringify({
      enabled: true,
      bot: { id: 123 },
      chatId: "100",
      userId: "42",
      conversationId: "1",
    }),
  );
  const route = {
    chat: "100",
    user: "42",
    botId: 123,
    credentialBinding: hash(identity),
  };
  return {
    app,
    route,
    async restart() {
      store.close();
      store = new Store(dir);
    },
    async close() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function service(app: Runtime) {
  const module = await import("../src/telegram-topics.js").catch(
    () => undefined,
  );
  assert.ok(
    module?.TelegramTopics,
    "durable Telegram topic mirror service must exist",
  );
  return new module.TelegramTopics(app);
}

test("web topic creation claims before API, mirrors the same id, and remains idempotent after restart", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const topics = await service(f.app);
    const create = async (chat: string, name: string) => {
      calls++;
      assert.equal(chat, "100");
      assert.equal(name, "Web planning");
      const receipt = f.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key='telegram:topic-create:2'",
      );
      assert.equal(JSON.parse(receipt!.value).state, "uncertain");
      return { message_thread_id: 82, name };
    };
    const result = await topics.mirror("2", create, () => f.route);
    assert.equal(result.state, "created");
    assert.equal(
      f.app.telegramChats.selected({ ...f.route, messageThreadId: 82 }),
      "2",
    );
    assert.equal(f.app.store.all("SELECT * FROM conversations").length, 2);
    await f.restart();
    assert.equal(
      (await (await service(f.app)).mirror("2", create, () => f.route)).state,
      "existing",
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("an ambiguous createForumTopic failure never retries across concurrent callers or restart", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const topics = await service(f.app);
    const create = async () => {
      calls++;
      throw new Error("lost response after mutation");
    };
    const results = await Promise.all([
      topics.mirror("2", create, () => f.route),
      topics.mirror("2", create, () => f.route),
    ]);
    assert.ok(results.every((result) => result.state === "uncertain"));
    await f.restart();
    assert.equal(
      (await (await service(f.app)).mirror("2", create, () => f.route)).state,
      "uncertain",
    );
    assert.equal(calls, 1);
    assert.equal(
      f.app.store.get("SELECT 1 FROM telegram_grants WHERE conversationId='2'"),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("disconnected, revoked and changed routes never create or restore grants", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const topics = await service(f.app);
    const create = async () => {
      calls++;
      return { message_thread_id: 82 };
    };
    assert.equal(
      (await topics.mirror("2", create, () => undefined)).state,
      "unavailable",
    );
    f.app.store.run("DELETE FROM telegram_grants WHERE conversationId='1'");
    assert.equal(
      (await topics.mirror("2", create, () => f.route)).state,
      "unavailable",
    );
    assert.equal(calls, 0);
    f.app.store.run("INSERT INTO telegram_grants VALUES ('100','42','1')");
    await topics.mirror(
      "2",
      async () => {
        calls++;
        f.app.store.run("DELETE FROM telegram_grants WHERE conversationId='1'");
        return { message_thread_id: 82 };
      },
      () => f.route,
    );
    assert.equal(
      f.app.store.get("SELECT 1 FROM telegram_grants WHERE conversationId='2'"),
      undefined,
    );
    f.app.store.run("INSERT INTO telegram_grants VALUES ('100','42','1')");
    assert.equal(
      (await topics.mirror("2", create, () => f.route)).state,
      "cancelled",
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("revoking a successful mirrored conversation never regrants or creates another topic", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const topics = await service(f.app);
    const create = async () => {
      calls++;
      return { message_thread_id: 82 };
    };
    await topics.mirror("2", create, () => f.route);
    f.app.store.run("DELETE FROM telegram_grants WHERE conversationId='2'");
    await f.restart();
    assert.equal(
      (await (await service(f.app)).mirror("2", create, () => f.route)).state,
      "cancelled",
    );
    assert.equal(calls, 1);
    assert.equal(
      f.app.store.get("SELECT 1 FROM telegram_grants WHERE conversationId='2'"),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("authority revocation during topic creation remains terminal after regranting", async () => {
  const f = await fixture();
  try {
    const topics = await service(f.app);
    const result = await topics.mirror(
      "2",
      async () => {
        f.app.store.run("DELETE FROM telegram_grants WHERE conversationId='1'");
        f.app.store.run("INSERT INTO telegram_grants VALUES ('100','42','1')");
        return { message_thread_id: 82 };
      },
      () => f.route,
    );
    assert.equal(result.state, "cancelled");
    assert.equal(
      f.app.store.get("SELECT 1 FROM telegram_grants WHERE conversationId='2'"),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("disconnecting and reconnecting during an external creation cannot revive its receipt", async () => {
  const f = await fixture();
  try {
    const topics = await service(f.app);
    const result = await topics.mirror(
      "2",
      async () => {
        const saved = f.app.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key='telegram:connection'",
        )!.value;
        f.app.store.run(
          "UPDATE meta SET value=json_set(value,'$.enabled',0) WHERE key='telegram:connection'",
        );
        f.app.store.run(
          "UPDATE meta SET value=? WHERE key='telegram:connection'",
          saved,
        );
        return { message_thread_id: 82 };
      },
      () => f.route,
    );
    assert.equal(result.state, "cancelled");
    assert.equal(
      f.app.store.get("SELECT 1 FROM telegram_grants WHERE conversationId='2'"),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("authorized reconnecting creation stays pending until explicit ready completion", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const topics = await service(f.app);
    const create = async () => {
      calls++;
      return { message_thread_id: 82 };
    };
    const pending = await topics.mirror("2", create, () => f.route, {
      ready: false,
    });
    assert.equal(pending.state, "pending");
    assert.equal(pending.canComplete, true);
    assert.ok(pending.reason);
    assert.equal(calls, 0);
    const receipt = JSON.parse(
      f.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key='telegram:topic-create:2'",
      )!.value,
    );
    assert.equal(
      receipt.authorizationVersion,
      f.app.store.authorizationVersion(f.route, "1"),
    );
    assert.equal(
      (await topics.mirror("2", create, () => f.route)).state,
      "pending",
    );
    assert.equal(calls, 0);
    const completed = await Promise.all([
      topics.mirror("2", create, () => f.route, { explicitCompletion: true }),
      topics.mirror("2", create, () => f.route, { explicitCompletion: true }),
    ]);
    assert.ok(completed.every((result) => result.state === "created"));
    assert.equal(calls, 1);
    assert.equal(
      f.app.telegramChats.selected({ ...f.route, messageThreadId: 82 }),
      "2",
    );
  } finally {
    await f.close();
  }
});

test("pending creation survives restart without an external attempt and completes the same conversation explicitly", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const create = async () => {
      calls++;
      return { message_thread_id: 82 };
    };
    await (
      await service(f.app)
    ).mirror("2", create, () => f.route, { ready: false });
    await f.restart();
    const topics = await service(f.app);
    assert.equal(
      (await topics.mirror("2", create, () => f.route)).state,
      "pending",
    );
    assert.equal(calls, 0);
    assert.equal(
      (
        await topics.mirror("2", create, () => f.route, {
          explicitCompletion: true,
        })
      ).state,
      "created",
    );
    assert.equal(calls, 1);
    assert.equal(f.app.store.all("SELECT * FROM conversations").length, 2);
  } finally {
    await f.close();
  }
});

test("pending intent cannot complete after grant or connection revocation followed by restoration", async (t) => {
  for (const change of ["grant", "connection"])
    await t.test(change, async () => {
      const f = await fixture();
      let calls = 0;
      try {
        const topics = await service(f.app);
        const create = async () => {
          calls++;
          return { message_thread_id: 82 };
        };
        await topics.mirror("2", create, () => f.route, { ready: false });
        if (change === "grant") {
          f.app.store.run(
            "DELETE FROM telegram_grants WHERE conversationId='1'",
          );
          f.app.store.run(
            "INSERT INTO telegram_grants VALUES ('100','42','1')",
          );
        } else {
          const value = f.app.store.get<{ value: string }>(
            "SELECT value FROM meta WHERE key='telegram:connection'",
          )!.value;
          f.app.store.run(
            "UPDATE meta SET value=json_set(value,'$.enabled',0) WHERE key='telegram:connection'",
          );
          f.app.store.run(
            "UPDATE meta SET value=? WHERE key='telegram:connection'",
            value,
          );
        }
        assert.equal(
          (
            await topics.mirror("2", create, () => f.route, {
              explicitCompletion: true,
            })
          ).state,
          "cancelled",
        );
        assert.equal(calls, 0);
        assert.equal(
          f.app.store.get(
            "SELECT 1 FROM telegram_grants WHERE conversationId='2'",
          ),
          undefined,
        );
      } finally {
        await f.close();
      }
    });
});

test("explicit completion never retries uncertain creation or repairs a revoked existing topic", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const topics = await service(f.app);
    const create = async () => {
      calls++;
      throw new Error("ambiguous API outcome");
    };
    await topics.mirror("2", create, () => f.route);
    assert.equal(
      (
        await topics.mirror("2", create, () => f.route, {
          explicitCompletion: true,
        })
      ).state,
      "uncertain",
    );
    assert.equal(calls, 1);
    f.app.store.run(
      "INSERT INTO conversations VALUES ('3','Already revoked topic')",
    );
    f.app.store.run(
      "INSERT INTO telegram_conversations VALUES ('3','100','42')",
    );
    f.app.store.run("INSERT INTO telegram_topic_conversations VALUES ('3',83)");
    assert.equal(
      (
        await topics.mirror("3", create, () => f.route, {
          explicitCompletion: true,
        })
      ).state,
      "cancelled",
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("missing authority never persists pending intent or invokes an API", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    f.app.store.run("DELETE FROM telegram_grants WHERE conversationId='1'");
    const result = await (
      await service(f.app)
    ).mirror(
      "2",
      async () => {
        calls++;
        return { message_thread_id: 82 };
      },
      () => f.route,
      { ready: false },
    );
    assert.equal(result.state, "unavailable");
    assert.equal(result.canComplete, false);
    assert.ok(result.reason);
    assert.equal(calls, 0);
    assert.equal(
      f.app.store.get("SELECT 1 FROM meta WHERE key='telegram:topic-create:2'"),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("connection adapter saves transient intent and only explicit completion invokes its simulated API", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const connection = new TelegramConnection(f.app, {
      apiFactory: () => ({
        call: async (method, payload) => {
          assert.equal(method, "createForumTopic");
          assert.deepEqual(payload, { chat_id: "100", name: "Web planning" });
          calls++;
          return { message_thread_id: 82 };
        },
      }),
    });
    assert.deepEqual(await connection.mirrorConversation("2"), {
      state: "unavailable",
      canComplete: false,
    });
    Reflect.set(connection, "state", "connecting");
    assert.equal((await connection.mirrorConversation("2")).state, "pending");
    assert.equal(calls, 0);
    Reflect.set(connection, "state", "connected");
    assert.equal((await connection.mirrorConversation("2")).state, "pending");
    assert.equal(calls, 0);
    const result = await connection.mirrorConversation("2", true);
    assert.equal(result.state, "created");
    assert.equal(
      (await connection.mirrorConversation("2", true)).state,
      "existing",
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("old web conversations without an intent can complete explicitly but stale pending versions cannot", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const topics = await service(f.app);
    const create = async () => {
      calls++;
      return { message_thread_id: 82 };
    };
    await topics.mirror("2", create, () => f.route, { ready: false });
    f.app.store.run(
      "UPDATE meta SET value=json_set(value,'$.authorizationVersion','stale') WHERE key='telegram:topic-create:2'",
    );
    assert.equal(
      (
        await topics.mirror("2", create, () => f.route, {
          explicitCompletion: true,
        })
      ).state,
      "cancelled",
    );
    assert.equal(calls, 0);
    f.app.store.run(
      "INSERT INTO conversations VALUES ('3','Old client web conversation')",
    );
    assert.equal(
      (
        await topics.mirror("3", create, () => f.route, {
          explicitCompletion: true,
        })
      ).state,
      "created",
    );
    assert.equal(calls, 1);
    assert.equal(
      f.app.telegramChats.selected({ ...f.route, messageThreadId: 82 }),
      "3",
    );
  } finally {
    await f.close();
  }
});

test("a valid pending intent remains pending while its live route is temporarily unavailable", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const topics = await service(f.app);
    const create = async () => {
      calls++;
      return { message_thread_id: 82 };
    };
    await topics.mirror("2", create, () => f.route, { ready: false });
    const paused = await topics.mirror("2", create, () => undefined, {
      explicitCompletion: true,
    });
    assert.equal(paused.state, "pending");
    assert.equal(paused.canComplete, true);
    assert.ok(paused.reason);
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test("enabled blocked connections explain unavailable completion without invoking the API", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const connection = new TelegramConnection(f.app, {
      apiFactory: () => ({
        call: async () => {
          calls++;
          return {};
        },
      }),
    });
    for (const state of ["blocked", "webhook_conflict"]) {
      Reflect.set(connection, "state", state);
      const result = await connection.mirrorConversation("2", true);
      assert.equal(result.state, "unavailable");
      assert.equal(result.canComplete, false);
      assert.ok(result.reason);
    }
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test("restored targets with a revoked initial route permanently cancel their pending intent", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const topics = await service(f.app);
    const create = async () => {
      calls++;
      return { message_thread_id: 82 };
    };
    await topics.mirror("2", create, () => f.route, { ready: false });
    f.app.store.run("INSERT INTO telegram_initial_revocations VALUES ('2')");
    assert.equal(
      (
        await topics.mirror("2", create, () => f.route, {
          explicitCompletion: true,
        })
      ).state,
      "cancelled",
    );
    const receipt = JSON.parse(
      f.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key='telegram:topic-create:2'",
      )!.value,
    );
    assert.equal(receipt.state, "cancelled");
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test("explicit legacy anchor completion reuses its exact grant without inserting another grant", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const result = await (
      await service(f.app)
    ).mirror(
      "1",
      async () => {
        calls++;
        return { message_thread_id: 81 };
      },
      () => f.route,
      { explicitCompletion: true },
    );
    assert.equal(result.state, "created");
    assert.equal(calls, 1);
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 1);
    assert.equal(
      f.app.telegramChats.selected({ ...f.route, messageThreadId: 81 }),
      "1",
    );
  } finally {
    await f.close();
  }
});

test("explicit completion cannot revive an unmapped target with any proven revoked grant", async (t) => {
  for (const previousOwner of ["current", "foreign"])
    await t.test(previousOwner, async () => {
      const f = await fixture();
      let calls = 0;
      try {
        const target = previousOwner === "current" ? "1" : "3";
        if (previousOwner === "current") {
          f.app.store.run(
            "INSERT INTO telegram_grants VALUES ('100','42','2')",
          );
          f.app.store.run(
            "DELETE FROM telegram_grants WHERE conversationId='1'",
          );
        } else {
          f.app.store.run(
            "INSERT INTO conversations VALUES ('3','Foreign revoked web history')",
          );
          f.app.store.run(
            "INSERT INTO telegram_grants VALUES ('200','99','3')",
          );
          f.app.store.run(
            "DELETE FROM telegram_grants WHERE conversationId='3'",
          );
        }
        const result = await (
          await service(f.app)
        ).mirror(
          target,
          async () => {
            calls++;
            return { message_thread_id: 81 };
          },
          () => f.route,
          { explicitCompletion: true },
        );
        assert.equal(result.state, "cancelled");
        assert.equal(calls, 0);
        assert.equal(
          f.app.store.get(
            "SELECT 1 FROM telegram_grants WHERE conversationId=?",
            target,
          ),
          undefined,
        );
      } finally {
        await f.close();
      }
    });
});

test("pending intent freezes the target grant version as well as the creation authority", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    f.app.store.run("INSERT INTO telegram_grants VALUES ('100','42','2')");
    const topics = await service(f.app);
    const create = async () => {
      calls++;
      return { message_thread_id: 81 };
    };
    await topics.mirror("1", create, () => f.route, { ready: false });
    const receipt = JSON.parse(
      f.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key='telegram:topic-create:1'",
      )!.value,
    );
    assert.equal(
      receipt.targetAuthorizationVersion,
      f.app.store.authorizationVersion(f.route, "1"),
    );
    f.app.store.run("DELETE FROM telegram_grants WHERE conversationId='1'");
    f.app.store.run("INSERT INTO telegram_grants VALUES ('100','42','1')");
    assert.equal(
      (
        await topics.mirror("1", create, () => f.route, {
          explicitCompletion: true,
        })
      ).state,
      "cancelled",
    );
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test("target grant revocation during the external call remains terminal after regrant", async () => {
  const f = await fixture();
  try {
    f.app.store.run("INSERT INTO telegram_grants VALUES ('100','42','2')");
    const topics = await service(f.app);
    const result = await topics.mirror(
      "1",
      async () => {
        const receipt = JSON.parse(
          f.app.store.get<{ value: string }>(
            "SELECT value FROM meta WHERE key='telegram:topic-create:1'",
          )!.value,
        );
        assert.equal(
          receipt.targetAuthorizationVersion,
          f.app.store.authorizationVersion(f.route, "1"),
        );
        f.app.store.run("DELETE FROM telegram_grants WHERE conversationId='1'");
        f.app.store.run("INSERT INTO telegram_grants VALUES ('100','42','1')");
        return { message_thread_id: 81 };
      },
      () => f.route,
      { explicitCompletion: true },
    );
    assert.equal(result.state, "cancelled");
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM telegram_topic_conversations WHERE conversationId='1'",
      ),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("a temporary authority settings lock preserves an unattempted pending intent only while frozen versions match", async (t) => {
  for (const stale of [false, true])
    await t.test(
      stale ? "stale authority" : "unchanged authority",
      async () => {
        const f = await fixture();
        let calls = 0;
        try {
          const topics = await service(f.app);
          const create = async () => {
            calls++;
            return { message_thread_id: 82 };
          };
          await topics.mirror("2", create, () => f.route, { ready: false });
          if (stale)
            f.app.store.run(
              "UPDATE meta SET value=json_set(value,'$.authorizationVersion','stale') WHERE key='telegram:topic-create:2'",
            );
          const available = f.app.assertConversationAvailable.bind(f.app);
          f.app.assertConversationAvailable = (id) => {
            if (id === "1") throw new ConversationBusyError();
            available(id);
          };
          const locked = await topics.mirror("2", create, () => f.route, {
            explicitCompletion: true,
          });
          assert.equal(locked.state, stale ? "cancelled" : "pending");
          assert.equal(calls, 0);
          const receipt = JSON.parse(
            f.app.store.get<{ value: string }>(
              "SELECT value FROM meta WHERE key='telegram:topic-create:2'",
            )!.value,
          );
          assert.equal(receipt.state, stale ? "cancelled" : "pending");
          f.app.assertConversationAvailable = available;
          assert.equal(
            (
              await topics.mirror("2", create, () => f.route, {
                explicitCompletion: true,
              })
            ).state,
            stale ? "cancelled" : "created",
          );
          assert.equal(calls, stale ? 0 : 1);
        } finally {
          await f.close();
        }
      },
    );
});
