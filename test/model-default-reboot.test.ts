import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

test(
  "real boot persists a web default and existing overrides when MODEL_ID changes on redeploy",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-model-reboot-"));
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const origin = `http://127.0.0.1:${address.port}`;
    let cookie = "";
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(origin + path, {
        method,
        headers: { origin, cookie, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (path === "/api/login")
        cookie = response.headers.get("set-cookie")!.split(";")[0];
      assert.ok(response.ok, `${path}: ${response.status}`);
      return response.json();
    };
    async function boot(model: string) {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/main.ts"],
        {
          cwd: new URL("..", import.meta.url),
          env: {
            PATH: process.env.PATH,
            APP_MODE: "live",
            MODEL_ID: model,
            DATA_DIR: dir,
            HOST: "127.0.0.1",
            PORT: String(port),
            APP_ORIGIN: origin,
            WEB_PASSWORD: "synthetic-reboot-password",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const exited = once(child, "exit");
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Boot timed out")),
            10000,
          );
          child.once("error", reject);
          child.once("exit", () => reject(new Error("Boot exited early")));
          child.stdout.on("data", (chunk: Buffer) => {
            if (String(chunk).includes(`em ${origin}`)) {
              clearTimeout(timeout);
              resolve();
            }
          });
        });
      } catch (error) {
        child.kill("SIGKILL");
        await exited;
        throw error;
      }
      return async () => {
        child.kill("SIGTERM");
        await exited;
      };
    }
    let stop: (() => Promise<void>) | undefined;
    try {
      stop = await boot("gpt-6.1-sol");
      await request("/api/login", "POST", {
        password: "synthetic-reboot-password",
      });
      const existing = await request("/api/conversations", "POST", {
        title: "Existing override",
        requestId: "existing-model",
      });
      const override = {
        provider: "openai",
        modelId: "gpt-6.1-sol",
        effort: "xhigh",
      };
      await request(
        `/api/conversations/${existing.id}/settings`,
        "PUT",
        override,
      );
      const choice = {
        provider: "openai",
        modelId: "gpt-5.6-sol",
        effort: "low",
      };
      await request("/api/settings", "PUT", choice);
      await stop();
      stop = undefined;
      stop = await boot("gpt-6.1-sol");
      const saved = await request("/api/settings");
      assert.deepEqual(
        {
          provider: saved.provider,
          modelId: saved.modelId,
          effort: saved.effort,
        },
        choice,
      );
      assert.deepEqual(
        (await request(`/api/conversations/${existing.id}`)).settings,
        override,
      );
      const fresh = await request("/api/conversations", "POST", {
        title: "Uses saved default",
        requestId: "new-model",
      });
      assert.deepEqual(
        (await request(`/api/conversations/${fresh.id}`)).settings,
        choice,
      );
      assert.equal((await request("/api/conversations")).length, 2);
    } finally {
      await stop?.();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
