import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";

// Changing this route to serialize the entire message, or omitting any visible
// text block/separator, must break exact reconstruction and response bounds.
test("authenticated history text pages reconstruct long signed answers exactly with bounded transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-history-text-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: {
      call: async () => {
        throw new Error("External calls forbidden");
      },
    },
  });
  const origin = "http://localhost:3000";
  const web = createAppServer(app, {
    origin,
    password: "synthetic-only",
    secureCookie: false,
  });
  try {
    const id = await app.create("Synthetic text pages");
    const first =
      "# Synthetic answer\n\n" +
      "abc😀<script>alert(1)</script>\n".repeat(1400);
    const last = "Final visible block.";
    const message = fauxAssistantMessage([
      {
        type: "thinking",
        thinking: "Hidden reasoning",
        thinkingSignature: "S".repeat(100000),
      },
      { type: "text", text: first, textSignature: "T".repeat(100000) },
      { type: "text", text: last },
    ]);
    const entry = await app.harness.commit(
      (tx) =>
        tx.appendEntry(Number(id) as ConversationId, {
          kind: "pi.assistant",
          model: [message],
        }),
      context,
    );
    await new Promise<void>((resolve) =>
      web.server.listen(0, "127.0.0.1", resolve),
    );
    const address = web.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ password: "synthetic-only" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const path = `/api/conversations/${id}/history/${entry.id}/0?view=text`;
    let offset: number | null = 0;
    const chunks: string[] = [];
    while (offset !== null) {
      const response: Response = await fetch(
        `${base}${path}&offset=${offset}`,
        { headers: { cookie } },
      );
      assert.equal(response.status, 200);
      const raw = await response.text();
      assert.ok(Buffer.byteLength(raw) < 100000);
      const page = JSON.parse(raw) as {
        text: string;
        offset: number;
        nextOffset: number | null;
        totalChars: number;
      };
      assert.equal(page.offset, offset);
      assert.equal(typeof page.text, "string");
      assert.ok(page.text.length > 0 && page.text.length <= 16384);
      assert.ok(!/[\uD800-\uDBFF]$/.test(page.text));
      assert.equal(page.totalChars, first.length + 1 + last.length);
      chunks.push(page.text);
      offset = page.nextOffset;
      assert.ok(chunks.length <= 10, "cursor must advance and terminate");
    }
    assert.equal(chunks.join(""), first + "\n" + last);
    assert.ok(chunks.length > 1);
    assert.equal((await fetch(base + path)).status, 401);
    for (const bad of ["-1", "NaN", "1.2", "9007199254740992"]) {
      assert.equal(
        (await fetch(`${base}${path}&offset=${bad}`, { headers: { cookie } }))
          .status,
        400,
      );
    }
    const end = await fetch(
      `${base}${path}&offset=${first.length + 1 + last.length}`,
      { headers: { cookie } },
    );
    assert.deepEqual(await end.json(), {
      text: "",
      offset: first.length + 1 + last.length,
      nextOffset: null,
      totalChars: first.length + 1 + last.length,
    });
    assert.deepEqual(
      (await app.snapshot(id)).view.entries[0].model![0],
      message,
    );
  } finally {
    await web.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded text pages keep ordinary Markdown paragraphs together when a boundary is available", async () => {
  const { chatMessageTextPage } = await import("../src/chat-snapshot.js");
  const paragraph = "**Readable prose.** " + "x".repeat(8967) + "\n\n";
  assert.ok(paragraph.length > 8192 && paragraph.length < 16384);
  const message = fauxAssistantMessage(paragraph.repeat(4));
  const first = chatMessageTextPage(message);
  assert.equal(first.text, paragraph);
  assert.equal(first.nextOffset, paragraph.length);
  const second = chatMessageTextPage(message, first.nextOffset!);
  assert.equal(second.text, paragraph);
});
