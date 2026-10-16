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
import { Telegram } from "../src/telegram.js";
import { createAppServer } from "../src/server.js";
import {
  TelegramConnection,
  type TelegramApi,
} from "../src/telegram-connection.js";

async function fixture(transient = false, existingDir?: string) {
  const dir =
    existingDir ?? (await mkdtemp(join(tmpdir(), "pi-web-topic-recovery-")));
  const faux = fauxProvider();
  faux.setResponses(
    Array.from({ length: 10 }, () =>
      fauxAssistantMessage("Synthetic assistant answer"),
    ),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    models,
    gateway: { call: async () => ({ content: [] }) },
  });
  const anchor = existingDir
    ? app.listConversations().at(-1)!.id
    : await app.create("Synthetic authority");
  if (!existingDir) {
    app.store.consumeLink(app.store.link(anchor), "100", "42");
    app.store.run(
      "INSERT INTO meta VALUES ('telegram:connection',?)",
      JSON.stringify({
        enabled: true,
        bot: { id: 123 },
        chatId: "100",
        userId: "42",
        conversationId: anchor,
      }),
    );
    app.store.run(
      "INSERT INTO credentials VALUES ('telegram:bot',?)",
      JSON.stringify({ token: "123:synthetic-local-only", botId: 123 }),
    );
  }
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  let calls = 0;
  let uncertain = false;
  const edits: Record<string, unknown>[] = [];
  const methods: string[] = [];
  let edit: (payload: Record<string, unknown>) => Promise<unknown> = async () =>
    true;
  let createError: Error | undefined;
  let createResult:
    ((payload: Record<string, unknown>) => Promise<unknown>) | undefined;
  const fake: TelegramApi = {
    async call(method, payload = {}, signal) {
      methods.push(method);
      if (method === "getMe") {
        await ready;
        return { id: 123, is_bot: true, username: "synthetic_pi_bot" };
      }
      if (method === "getWebhookInfo") return { url: "" };
      if (method === "getUpdates") {
        if (payload.timeout && !signal?.aborted)
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        return [];
      }
      if (method === "createForumTopic") {
        calls++;
        if (createError) throw createError;
        if (uncertain) throw new Error("Synthetic response lost");
        if (createResult) return createResult(payload);
        return { message_thread_id: 500 + calls, name: payload.name };
      }
      if (method === "editForumTopic") {
        edits.push(payload);
        return edit(payload);
      }
      if (method === "getMyCommands") return [];
      return true;
    },
  };
  const manager = new TelegramConnection(app, { apiFactory: () => fake });
  const origin = "http://localhost:3000";
  const web = createAppServer(app, {
    origin,
    password: "synthetic-password-only",
    secureCookie: false,
    telegramConnection: manager,
  });
  if (!transient) {
    releaseReady();
    await manager.restore();
  }
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
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    authenticated = true,
    requestOrigin = origin,
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        origin: requestOrigin,
        "content-type": "application/json",
        ...(authenticated ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  return {
    app,
    faux,
    methods,
    anchor,
    dir,
    manager,
    request,
    get calls() {
      return calls;
    },
    edits,
    setEdit(handler: typeof edit) {
      edit = handler;
    },
    setCreate(handler: NonNullable<typeof createResult>) {
      createResult = handler;
    },
    setCreateError(error?: Error) {
      createError = error;
    },
    loseResponse() {
      uncertain = true;
    },
    async ready() {
      releaseReady();
      await manager.restore();
    },
    async close(retain = false) {
      releaseReady();
      await web.close();
      await app.close();
      if (!retain) await rm(dir, { recursive: true, force: true });
    },
  };
}

test("connected Telegram never receives web turns or topic creation, including idempotent web creates", async () => {
  const f = await fixture();
  try {
    const before = f.app.store.all("SELECT * FROM telegram_grants");
    const input = { title: "Web only", requestId: "separate-web-create" };
    const first = await f.request("/api/conversations", "POST", input);
    const retry = await f.request("/api/conversations", "POST", input);
    assert.equal(first.status, 201);
    assert.equal(first.body.id, retry.body.id);
    const id = first.body.id;
    assert.equal(
      (
        await f.request(`/api/conversations/${id}/messages`, "POST", {
          requestId: "separate-web-message",
          text: "Web input",
        })
      ).status,
      202,
    );
    await (await f.app.conversation(id)).waitForIdle(context);
    assert.equal(f.calls, 0);
    assert.equal(f.edits.length, 0);
    assert.equal(f.app.store.telegramThread(id), undefined);
    assert.deepEqual(f.app.store.all("SELECT * FROM telegram_grants"), before);
    assert.equal(
      f.app.store.get("SELECT 1 FROM deliveries WHERE id LIKE ?", `${id}:%`),
      undefined,
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM request_telegram_routes WHERE conversationId=?",
        id,
      ),
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
    assert.equal(f.calls, 0);
  } finally {
    await f.close();
  }
});

test("legacy pending and uncertain topic receipts remain intact and cannot be completed through web", async () => {
  const f = await fixture(true);
  try {
    for (const state of ["pending", "uncertain", "created"]) {
      const id = await f.app.create("Legacy intent");
      const value = JSON.stringify({
        state,
        requestedName: "Legacy intent",
        route: { chat: "100", user: "42", botId: 123 },
      });
      f.app.store.run(
        "INSERT INTO meta VALUES (?,?)",
        `telegram:topic-create:${id}`,
        value,
      );
      assert.equal(
        (
          await f.request(`/api/conversations/${id}/telegram/topic`, "POST", {
            confirm: true,
          })
        ).status,
        403,
      );
      assert.equal(
        f.app.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key=?",
          `telegram:topic-create:${id}`,
        )?.value,
        value,
      );
    }
    await f.ready();
    assert.equal(f.calls, 0);
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_conversations").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("long Unicode native creation preserves the title and canonical binding through restart", async () => {
  let f = await fixture();
  try {
    const name = "😀".repeat(128);
    const bot = new Telegram(
      f.app,
      { send: async () => ({}) },
      ["42"],
      ["100"],
      undefined,
      true,
      123,
    );
    await bot.receive({
      update_id: 9201,
      message: {
        message_id: 9201,
        date: Math.floor(Date.now() / 1000),
        from: { id: 42 },
        chat: { id: 100, type: "private" },
        message_thread_id: 902,
        forum_topic_created: { name },
      },
    });
    const topic = f.app.listConversations().find((c) => c.title === name)!;
    assert.ok(topic);
    assert.equal(f.app.store.telegramThread(topic.id), 902);
    const dir = f.dir;
    await f.close(true);
    f = await fixture(false, dir);
    assert.equal(
      f.app.listConversations().find((c) => c.id === topic.id)?.title,
      name,
    );
    assert.equal(f.app.store.telegramThread(topic.id), 902);
    assert.equal(f.calls, 0);
    assert.equal(f.edits.length, 0);
  } finally {
    await f.close();
  }
});
