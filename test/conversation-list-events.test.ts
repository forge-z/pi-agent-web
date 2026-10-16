import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Telegram visibility metadata never changes the web list stream", async () => {
  const f = await fixture();
  const stream = await f.open();
  try {
    await stream.wait(1);
    const id = await f.app.create("Telegram", { chat: "42", user: "42" });
    f.app.setConversationWebHidden(id, true);
    f.app.setConversationWebHidden(id, false);
    await delay(1200);
    assert.equal(stream.changes().length, 1);
  } finally {
    stream.close();
    await f.close();
  }
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-conversation-list-events-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  const anchor = await app.create("Synthetic web anchor");
  app.store.consumeLink(app.store.link(anchor), "42", "42");
  const web = createAppServer(app, {
    password: "synthetic-list-password",
    origin: "http://localhost:3000",
    secureCookie: false,
  });
  await new Promise<void>((resolve) =>
    web.server.listen(0, "127.0.0.1", resolve),
  );
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: "synthetic-list-password" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  async function open(selected?: string) {
    const path = selected
      ? `/api/conversations/${selected}/events`
      : "/api/conversations/events";
    const request = httpRequest(`${base}${path}`, {
      headers: { cookie },
    });
    const response = await new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        request.once("response", resolve);
        request.once("error", reject);
        request.end();
      },
    );
    const frames: string[] = [];
    let buffer = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        frames.push(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    });
    return {
      response,
      frames,
      changes: () =>
        frames.filter((frame) => frame.startsWith("event: conversations\n")),
      async wait(count: number) {
        const end = Date.now() + 4000;
        while (this.changes().length < count && Date.now() < end)
          await delay(10);
        assert.equal(this.changes().length, count);
      },
      close: () => {
        response.destroy();
        request.destroy();
      },
    };
  }
  return {
    app,
    anchor,
    web,
    base,
    cookie,
    open,
    async close() {
      await web.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("Telegram creation, names and lifecycle do not reveal metadata through web list SSE", async () => {
  const f = await fixture();
  const stream = await f.open();
  try {
    await stream.wait(1);
    const initial = stream.changes()[0];
    const id = await f.app.create("Telegram secret", {
      chat: "42",
      user: "42",
    });
    await f.app.deleteConversation(id);
    f.app.restoreConversation(id);
    await f.app.renameConversation(id, "Private TG title");
    await delay(1200);
    assert.equal(stream.changes().length, 1);
    assert.equal(stream.changes()[0], initial);
    const rows = await (
      await fetch(`${f.base}/api/conversations`, {
        headers: { cookie: f.cookie },
      })
    ).json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, f.anchor);
  } finally {
    stream.close();
    await f.close();
  }
});

test("list SSE requires authentication, reconnects with current state and closes an expired session", async () => {
  const f = await fixture();
  const stream = await f.open();
  try {
    assert.equal(
      (await fetch(`${f.base}/api/conversations/events`)).status,
      401,
    );
    await stream.wait(1);
    stream.close();
    const reconnected = await f.open();
    try {
      await reconnected.wait(1);
      assert.equal(reconnected.changes()[0], stream.changes()[0]);
      const ended = new Promise<void>((resolve) =>
        reconnected.response.once("end", resolve),
      );
      f.app.store.run("UPDATE sessions SET expires=0");
      await Promise.race([
        ended,
        delay(2500).then(() => {
          throw new Error("expired list SSE remained open");
        }),
      ]);
      assert.equal(reconnected.changes().length, 1);
    } finally {
      reconnected.close();
    }
  } finally {
    stream.close();
    await f.close();
  }
});

test("the selected idle web history stream ignores Telegram chats", async () => {
  const f = await fixture();
  const snapshot = await f.app.snapshot(f.anchor);
  f.app.snapshot = async () => snapshot;
  const stream = await f.open(f.anchor);
  try {
    await stream.wait(1);
    const deadline = Date.now() + 3000;
    while (
      !stream.frames.some((frame) => frame.startsWith("event: snapshot\n")) &&
      Date.now() < deadline
    )
      await delay(10);
    assert.equal(
      stream.frames.filter((frame) => frame.startsWith("event: snapshot\n"))
        .length,
      1,
    );
    await delay(1100);
    assert.equal(stream.changes().length, 1);
    await f.app.create("Synthetic other-transport chat", {
      chat: "42",
      user: "42",
    });
    await delay(1200);
    assert.equal(stream.changes().length, 1);
    assert.equal(
      stream.frames.filter((frame) => frame.startsWith("event: snapshot\n"))
        .length,
      1,
    );
    stream.close();
    const reconnected = await f.open(f.anchor);
    try {
      await reconnected.wait(1);
      assert.equal(reconnected.changes()[0], stream.changes()[0]);
    } finally {
      reconnected.close();
    }
  } finally {
    stream.close();
    await f.close();
  }
});

test("native Telegram names update internal canonical titles without web metadata or echo edits", async () => {
  const f = await fixture();
  const stream = await f.open();
  try {
    await stream.wait(1);
    const topic = await f.app.create("Synthetic Pi alias", {
      chat: "42",
      user: "42",
      messageThreadId: 11,
    });
    await delay(1200);
    assert.equal(stream.changes().length, 1);
    const { Telegram } = await import("../src/telegram.js");
    let nativeEdits = 0;
    const bot = new Telegram(
      f.app,
      {
        send: async () => ({}),
        editTopicName: async () => {
          nativeEdits++;
          return true;
        },
      },
      ["42"],
      ["42"],
    );
    const event = (updateId: number, date: number, name: string) => ({
      update_id: updateId,
      message: {
        message_id: updateId,
        date,
        from: { id: 42 },
        chat: { id: 42, type: "private" },
        message_thread_id: 11,
        forum_topic_edited: { name },
      },
    });
    await bot.receive(event(1600, 100, "Synthetic native name"));
    await delay(1200);
    const rows = (await (
      await fetch(`${f.base}/api/conversations`, {
        headers: { cookie: f.cookie },
      })
    ).json()) as ReturnType<Runtime["listConversations"]>;
    assert.equal(
      rows.find((c) => c.id === topic),
      undefined,
    );
    assert.equal(
      rows.find((c) => c.id === topic),
      undefined,
    );
    await assert.rejects(
      f.app.renameConversation(topic, "Unsent title"),
      /Conecte o Telegram/,
    );
    await bot.receive(event(1601, 99, "Stale native name"));
    await delay(1200);
    assert.equal(
      stream.changes().length,
      1,
      "stale events must not change presentation or loop notifications",
    );
    assert.equal(
      f.app.listConversations().find((c) => c.id === topic)?.title,
      "Synthetic native name",
    );
    assert.equal(nativeEdits, 0);
  } finally {
    stream.close();
    await f.close();
  }
});
