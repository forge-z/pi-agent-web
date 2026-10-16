import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";
test("web auth separate from provider, origin gate, idempotent admission, SSE snapshot reconnect and static PWA", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-http-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  const origin = "http://127.0.0.1:3000";
  const web = createAppServer(app, {
    password: "test-password-123",
    origin,
    secureCookie: false,
    publicDir: resolve("public"),
  });
  await new Promise<void>((resolve) =>
    web.server.listen(0, "127.0.0.1", resolve),
  );
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (
    path: string,
    method = "GET",
    data?: unknown,
    cookie = "",
    requestOrigin = origin,
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(data
          ? { "content-type": "application/json", origin: requestOrigin }
          : {}),
        cookie,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
  try {
    assert.equal((await request("/healthz")).status, 200);
    assert.equal((await request("/manifest.webmanifest")).status, 200);
    for (const asset of [
      "/markdown.js",
      "/marked.js",
      "/tools.js",
      "/telegram-deliveries.js",
    ]) {
      const response = await request(asset);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type")!, /javascript/);
      assert.ok((await response.text()).length > 100);
    }
    assert.equal(
      (await request("/node_modules/marked/package.json")).status,
      404,
    );
    assert.equal((await request("/api/conversations")).status, 401);
    assert.equal((await request("/api/settings")).status, 401);
    assert.equal(
      (
        await request(
          "/api/login",
          "POST",
          { password: "test-password-123" },
          "",
          "https://evil.test",
        )
      ).status,
      403,
    );
    const login = await request("/api/login", "POST", {
      password: "test-password-123",
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(";")[0];
    const status = (await (
      await request("/api/status", "GET", undefined, cookie)
    ).json()) as { credentials: unknown };
    assert.equal(status.credentials, null);
    const settingsResponse = await request(
      "/api/settings",
      "GET",
      undefined,
      cookie,
    );
    assert.equal(settingsResponse.status, 200);
    assert.equal(settingsResponse.headers.get("cache-control"), "no-store");
    const settings = await settingsResponse.json();
    assert.deepEqual(Object.keys(settings.appInfo).sort(), [
      "builtAt",
      "commit",
      "version",
    ]);
    assert.equal(settings.appInfo.version, "0.1.0");
    assert.match(settings.appInfo.commit, /^[a-f0-9]{7}$/);
    assert.equal(settings.appInfo.builtAt, null);

    const conversation = (await (
      await request(
        "/api/conversations",
        "POST",
        { title: "HTTP test" },
        cookie,
      )
    ).json()) as { id: string };
    const first = await (
      await request(
        `/api/conversations/${conversation.id}/messages`,
        "POST",
        { requestId: "http-one", text: "hello" },
        cookie,
      )
    ).json();
    const second = await (
      await request(
        `/api/conversations/${conversation.id}/messages`,
        "POST",
        { requestId: "http-one", text: "hello" },
        cookie,
      )
    ).json();
    assert.deepEqual(first, second);
    for (let i = 0; i < 2; i++) {
      const abort = new AbortController();
      const sse = await fetch(
        `${base}/api/conversations/${conversation.id}/events`,
        { headers: { cookie }, signal: abort.signal },
      );
      assert.equal(sse.headers.get("x-accel-buffering"), "no");
      const reader = sse.body!.getReader();
      let output = "";
      while (!output.includes("event: snapshot")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      assert.match(output, /event: snapshot/);
      abort.abort();
      await reader.cancel().catch(() => {});
    }
    assert.equal(
      (await request("/api/logout", "POST", {}, cookie)).status,
      200,
    );
    assert.equal(
      (await request("/api/conversations", "GET", undefined, cookie)).status,
      401,
    );
  } finally {
    await web.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unexpected failures are logged by shape only; storage faults return 500 and plain errors stay 400", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-errors-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  const origin = "http://127.0.0.1:3000";
  const web = createAppServer(app, {
    password: "test-password-123",
    origin,
    secureCookie: false,
    publicDir: resolve("public"),
  });
  await new Promise<void>((resolve) =>
    web.server.listen(0, "127.0.0.1", resolve),
  );
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const logged: string[] = [];
  t.mock.method(console, "error", (line: string) => logged.push(line));
  try {
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ password: "test-password-123" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    app.listConversations = () => {
      throw Object.assign(new Error("database leaked secret-value"), {
        code: "ERR_SQLITE_ERROR",
      });
    };
    const storage = await fetch(`${base}/api/conversations`, {
      headers: { cookie },
    });
    assert.equal(storage.status, 500);
    assert.deepEqual(await storage.json(), {
      error: "Não foi possível processar a operação",
    });
    app.listConversations = () => {
      throw new Error("validation detail secret-value");
    };
    const plain = await fetch(`${base}/api/conversations`, {
      headers: { cookie },
    });
    assert.equal(plain.status, 400);
    assert.deepEqual(logged, [
      "Falha interna em GET /api/conversations: Error (ERR_SQLITE_ERROR)",
      "Falha não classificada em GET /api/conversations: Error",
    ]);
  } finally {
    await web.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("static assets revalidate with ETags, fonts are cacheable and API responses are never stored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-static-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  const web = createAppServer(app, {
    password: "test-password-123",
    origin: "http://127.0.0.1:3000",
    secureCookie: false,
    publicDir: resolve("public"),
  });
  await new Promise<void>((resolve) =>
    web.server.listen(0, "127.0.0.1", resolve),
  );
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const script = await fetch(`${base}/app.js`);
    assert.equal(script.status, 200);
    assert.equal(script.headers.get("cache-control"), "no-cache");
    const etag = script.headers.get("etag");
    assert.match(etag ?? "", /^"[\w-]+"$/);
    await script.arrayBuffer();
    const revalidated = await fetch(`${base}/app.js`, {
      headers: { "if-none-match": `W/"other", ${etag}` },
    });
    assert.equal(revalidated.status, 304);
    assert.equal(await revalidated.text(), "");
    const font = await fetch(`${base}/fonts/dm-sans-400-normal.ttf`);
    assert.equal(font.headers.get("content-type"), "font/ttf");
    assert.equal(font.headers.get("cache-control"), "public, max-age=2592000");
    await font.arrayBuffer();
    const api = await fetch(`${base}/api/status`);
    assert.equal(api.status, 401);
    assert.equal(api.headers.get("cache-control"), "no-store");
    assert.equal(api.headers.get("etag"), null);
  } finally {
    await web.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("login attempts are limited per client behind a trusted proxy, and secure cookies stay secure on logout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-login-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  const origin = "http://127.0.0.1:3000";
  const servers = [true, false].map((trustProxy) =>
    createAppServer(app, {
      password: "test-password-123",
      origin,
      secureCookie: true,
      trustProxy,
      publicDir: resolve("public"),
    }),
  );
  try {
    const [proxied, direct] = await Promise.all(
      servers.map(async (web) => {
        await new Promise<void>((done) =>
          web.server.listen(0, "127.0.0.1", done),
        );
        const address = web.server.address();
        assert.ok(address && typeof address === "object");
        return `http://127.0.0.1:${address.port}`;
      }),
    );
    const login = (base: string, forwarded: string, password = "wrong") =>
      fetch(`${base}/api/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-forwarded-for": forwarded,
        },
        body: JSON.stringify({ password }),
      });
    for (const base of [proxied, direct])
      for (let i = 0; i < 10; i++)
        assert.equal((await login(base, "203.0.113.5")).status, 401);
    // A client cannot escape its bucket by prepending its own entries.
    assert.equal(
      (await login(proxied, "198.51.100.1, 203.0.113.5")).status,
      429,
    );
    assert.equal((await login(proxied, "203.0.113.9")).status, 401);
    // Without a trusted proxy the header is ignored.
    assert.equal((await login(direct, "203.0.113.9")).status, 429);
    const ok = await login(proxied, "203.0.113.10", "test-password-123");
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("set-cookie")!, /; Secure/);
    const logout = await fetch(`${proxied}/api/logout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie: ok.headers.get("set-cookie")!.split(";")[0],
      },
      body: "{}",
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie")!, /Max-Age=0; Secure$/);
  } finally {
    for (const web of servers) await web.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
