import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test(
  "malformed unauthenticated request targets return a controlled error and leave the server alive",
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-http-malformed-url-"));
    const child = spawn(
      process.execPath,
      [
        "--unhandled-rejections=strict",
        "--import",
        "tsx",
        "test/server-malformed-url-child.ts",
        dir,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let errors = "";
    child.stderr!.on("data", (chunk) => {
      errors += String(chunk);
    });
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    try {
      const port = await new Promise<number>((resolve, reject) => {
        child.once("message", (value) => resolve(value as number));
        child.once("error", reject);
        child.once("close", (code, signal) =>
          reject(new Error(`HTTP child exited (${signal ?? code}): ${errors}`)),
        );
      });
      const get = (path: string) =>
        new Promise<{
          status: number | undefined;
          body: string;
          type: string | undefined;
        }>((resolve, reject) => {
          // The path option sends the target verbatim; fetch would reject it client-side.
          const req = request(
            { host: "127.0.0.1", port, path, headers: { connection: "close" } },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => {
                body += chunk;
              });
              response.on("error", reject);
              response.on("end", () =>
                resolve({
                  status: response.statusCode,
                  body,
                  type: response.headers["content-type"],
                }),
              );
            },
          );
          req.on("error", (error) =>
            reject(new Error(`${error.message}; HTTP child stderr: ${errors}`)),
          );
          req.setTimeout(3000, () =>
            req.destroy(new Error("HTTP request timed out")),
          );
          req.end();
        });
      for (const target of [
        "http://[",
        "//[",
        "http://user:secret-value@[?token=secret-value",
      ]) {
        const response = await get(target);
        assert.equal(response.status, 500);
        assert.match(response.type ?? "", /application\/json/);
        assert.deepEqual(JSON.parse(response.body), {
          error: "Não foi possível processar a operação",
        });
        const health = await get("/healthz");
        assert.equal(health.status, 200);
        assert.deepEqual(JSON.parse(health.body), { ok: true });
      }
      assert.equal((await get("/api/conversations")).status, 401);
      assert.equal(child.exitCode, null);
      child.send("close");
      assert.deepEqual(await closed, { code: 0, signal: null });
      assert.equal(
        (
          errors.match(
            /Falha interna em GET <invalid-url>: TypeError \(ERR_INVALID_URL\)/g,
          ) ?? []
        ).length,
        3,
      );
      assert.doesNotMatch(errors, /secret-value/);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await closed;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
