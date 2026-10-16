import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { chatSnapshot } from "../src/chat-snapshot.js";
import { createAppServer } from "../src/server.js";
import { Telegram, type TelegramUpdate } from "../src/telegram.js";

const answer = "Synthetic readable response. ".repeat(60).slice(0, 1443);
const gateway = {
  call: async () => {
    throw new Error("External tools forbidden");
  },
};
function signedAnswer(thinkingSize = 3917, textSize = 92) {
  return fauxAssistantMessage([
    {
      type: "thinking",
      thinking: "H".repeat(514),
      thinkingSignature: "S".repeat(thinkingSize),
    },
    {
      type: "text",
      text: answer,
      textSignature: "T".repeat(textSize),
    },
  ]);
}
function visibleText(message: { content: unknown }) {
  return (message.content as { type: string; text?: string }[])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

for (const [thinkingSize, textSize] of [
  [3917, 92],
  [10000, 10000],
])
  test(`native signatures (${thinkingSize}/${textSize}) cannot consume the readable answer preview`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-signature-preview-"));
    const app = await Runtime.open({ dir, mode: "demo", gateway });
    try {
      const id = await app.create("Synthetic preview");
      const original = signedAnswer(thinkingSize, textSize);
      await app.harness.commit(
        (tx) =>
          tx.appendEntry(Number(id) as ConversationId, {
            kind: "pi.assistant",
            model: [original],
          }),
        context,
      );
      const snapshot = await app.snapshot(id);
      const projected = chatSnapshot(snapshot).history.messages[0];
      assert.equal(visibleText(projected), answer);
      assert.equal(projected.previewTruncated, false);
      assert.equal(projected.previewMetadataOmitted, true);
      assert.deepEqual(JSON.parse(JSON.stringify(projected.content)), [
        { type: "thinking" },
        { type: "text", text: answer },
      ]);
      const live = chatSnapshot({
        ...snapshot,
        view: {
          ...snapshot.view,
          docs: {
            "pi.live": {
              generation: { message: original as unknown as JsonObject },
            },
          },
        },
      }).view.docs["pi.live"]!.generation!.message;
      assert.equal(visibleText(live), answer);
      assert.deepEqual(
        (await app.snapshot(id)).view.entries[0].model![0],
        original,
      );
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

test("signature-named tool arguments remain user data even inside thinking/text-shaped objects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-user-signature-preview-"));
  const app = await Runtime.open({ dir, mode: "demo", gateway });
  try {
    const id = await app.create();
    const args = {
      thinkingSignature: "user-thinking-value",
      textSignature: "user-text-value",
      nested: { type: "thinking", thinkingSignature: "nested-user-value" },
      text: { type: "text", textSignature: "nested-text-value" },
    };
    await app.harness.commit(
      (tx) =>
        tx.appendEntry(Number(id) as ConversationId, {
          kind: "pi.assistant",
          model: [
            fauxAssistantMessage({
              type: "toolCall",
              id: "synthetic-call",
              name: "synthetic_tool",
              arguments: args,
            }),
          ],
        }),
      context,
    );
    const projected = chatSnapshot(await app.snapshot(id)).history.messages[0];
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          (projected.content as { arguments: unknown }[])[0].arguments,
        ),
      ),
      args,
    );
    assert.equal(projected.previewTruncated, false);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("web answers stay readable, Telegram HTTP reads are denied, and both full signed originals survive restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-signed-answer-http-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const original = signedAnswer();
  faux.setResponses([original, original]);
  const options = { dir, models, gateway };
  let app = await Runtime.open(options);
  let web: ReturnType<typeof createAppServer> | undefined;
  let bot: Telegram | undefined;
  const storedMessages = new Map<string, typeof original>();
  try {
    const anchor = await app.create("Synthetic web source");
    app.store.consumeLink(app.store.link(anchor), "100", "42");
    bot = new Telegram(
      app,
      { send: async () => ({ ok: true }) },
      ["42"],
      ["100"],
    );
    const input = (id: number, text: string): TelegramUpdate => ({
      update_id: id,
      message: {
        message_id: id,
        from: { id: 42 },
        chat: { id: 100, type: "private" },
        text,
      },
    });
    const selected = (await bot.receive(
      input(1, "/new Synthetic Telegram source"),
    )) as { conversationId: string };
    const telegramId = selected.conversationId;
    await bot.receive(input(2, "Synthetic Telegram input"));
    await (await app.conversation(telegramId)).waitForIdle(context);
    const origin = "http://localhost:3000";
    web = createAppServer(app, {
      origin,
      password: "synthetic-password-only",
      secureCookie: false,
    });
    await new Promise<void>((resolve) =>
      web!.server.listen(0, "127.0.0.1", resolve),
    );
    const address = web.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ password: "synthetic-password-only" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const post = await fetch(`${base}/api/conversations/${anchor}/messages`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "synthetic-web-input",
        text: "Synthetic web input",
      }),
    });
    assert.equal(post.status, 202);
    await (await app.conversation(anchor)).waitForIdle(context);
    for (const id of [telegramId, anchor]) {
      const storedOriginal = (await app.snapshot(id)).view.entries.find(
        (entry) => entry.model?.[0].role === "assistant",
      )!.model![0] as typeof original;
      assert.deepEqual(storedOriginal.content, original.content);
      storedMessages.set(id, storedOriginal);
      for (let reload = 0; reload < 2; reload++) {
        const response = await fetch(
          `${base}/api/conversations/${id}?view=chat`,
          { headers: { cookie } },
        );
        if (id === telegramId) {
          assert.equal(response.status, 403);
          continue;
        }
        assert.equal(response.status, 200);
        const compact = (await response.json()) as {
          history: {
            messages: { role: string; content: unknown }[];
            keys: string[];
          };
        };
        const index = compact.history.messages.findIndex(
          (message) => message.role === "assistant",
        );
        assert.equal(visibleText(compact.history.messages[index]), answer);
        const key = compact.history.keys[index].replace(":", "/");
        const full = await fetch(
          `${base}/api/conversations/${id}/history/${key}`,
          { headers: { cookie } },
        );
        assert.equal(full.status, 200);
        assert.deepEqual(await full.json(), storedOriginal);
        assert.equal(
          (await fetch(`${base}/api/conversations/${id}/history/${key}`))
            .status,
          401,
        );
      }
      const conversation = await app.conversation(id);
      const text = JSON.stringify(
        (await conversation.context(context)).entries,
      );
      assert.ok(text.includes("S".repeat(3917)));
      assert.ok(text.includes("T".repeat(92)));
    }
    await bot.drain();
    bot = undefined;
    await web.close();
    web = undefined;
    await app.close();
    app = await Runtime.open(options);
    for (const id of [telegramId, anchor]) {
      const snapshot = await app.snapshot(id);
      assert.deepEqual(
        snapshot.view.entries.find(
          (entry) => entry.model?.[0].role === "assistant",
        )!.model![0],
        storedMessages.get(id),
      );
      assert.equal(
        visibleText(
          chatSnapshot(snapshot).history.messages.find(
            (message) => message.role === "assistant",
          )!,
        ),
        answer,
      );
    }
  } finally {
    await bot?.drain();
    await web?.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
