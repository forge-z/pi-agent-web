import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationError, type Runtime } from "./runtime.js";
import { hash } from "./store.js";
import { ProviderLogin } from "./provider-login.js";
import type { Telegram, TelegramUpdate } from "./telegram.js";
import { TaskError } from "./tasks.js";
import { SettingsError } from "./settings.js";
import { webCommandCatalog, CommandError } from "./commands.js";
import { PolicyError, McpError } from "./mcp.js";
import { CuaHandoffError } from "./cua-handoffs.js";
import { chatMessageTextPage, chatSnapshot } from "./chat-snapshot.js";
import { logFailure } from "./log.js";
import { humanControls, humanControlResource } from "./human-controls.js";
import { readAppInfo } from "./app-info.js";
import {
  TelegramConnection,
  TelegramSetupError,
} from "./telegram-connection.js";
export interface ServerOptions {
  password: string;
  origin: string;
  secureCookie: boolean;
  /** Key login attempts on the address appended by the nearest reverse proxy. */
  trustProxy?: boolean;
  telegram?: Telegram;
  telegramSecret?: string;
  telegramConnection?: TelegramConnection;
  publicDir?: string;
}
const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function body(request: IncomingMessage) {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "Use application/json");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65536) throw new HttpError(413, "Requisição muito grande");
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
}
const text = (value: unknown) => {
  if (typeof value !== "string")
    throw new HttpError(400, "Campo de texto inválido");
  return value;
};
/** Storage failures and programming errors are server faults, unlike plain validation errors. */
const internalError = (error: unknown) =>
  !(error instanceof Error) ||
  error instanceof TypeError ||
  error instanceof ReferenceError ||
  error instanceof RangeError ||
  error instanceof SyntaxError ||
  ("code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_SQLITE"));
const staticFiles = new Map<
  string,
  { mtimeMs: number; size: number; bytes: Buffer; etag: string }
>();
async function staticFile(file: string) {
  const info = await stat(file);
  const cached = staticFiles.get(file);
  if (cached?.mtimeMs === info.mtimeMs && cached.size === info.size)
    return cached;
  const bytes = await readFile(file);
  const entry = {
    mtimeMs: info.mtimeMs,
    size: info.size,
    bytes,
    etag: `"${createHash("sha256").update(bytes).digest("base64url")}"`,
  };
  staticFiles.set(file, entry);
  return entry;
}
const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
};
export function createAppServer(app: Runtime, options: ServerOptions) {
  const telegramConnection =
    options.telegramConnection ?? new TelegramConnection(app);
  void telegramConnection
    .restore()
    .catch(() =>
      console.error("Não foi possível restaurar a conexão Telegram"),
    );
  const login = new ProviderLogin(app.models, app.store, async () => {
    const active = await app.harness.inspect(context);
    if (
      active.tasks.length ||
      app.store.providerAdmissions ||
      app.store.get("SELECT 1 FROM requests WHERE status='pending'")
    )
      throw new SettingsError(
        "Aguarde as conversas e tarefas concluírem antes de alterar credenciais",
      );
  });
  const appInfo = readAppInfo();
  const tasks = app.tasks;
  tasks.start();
  const streams = new Set<ServerResponse>();
  const webConversations = (deleted = false) =>
    app
      .listConversations(deleted)
      .filter((row) => !app.isTelegramConversation(row.id));
  let listVersion: { token: string; value: string } | undefined;
  // Every open stream polls this; the list only changes with an app.sqlite commit.
  const conversationListVersion = () => {
    const token = app.store.changeToken();
    if (token && listVersion?.token === token) return listVersion.value;
    const value = hash(
      JSON.stringify([webConversations(), webConversations(true)]),
    );
    listVersion = token ? { token, value } : undefined;
    return value;
  };
  const webTelegramStatus = (
    status: ReturnType<TelegramConnection["snapshot"]>,
  ) =>
    status.conversationId && app.isTelegramConversation(status.conversationId)
      ? { ...status, conversationId: null, conversationTitle: null }
      : status;
  const attempts = new Map<string, { count: number; until: number }>();
  const timer = options.telegram
    ? setInterval(
        () =>
          void options
            .telegram!.flush()
            .catch(() => console.error("Falha ao processar fila Telegram")),
        1000,
      )
    : undefined;
  timer?.unref();
  const server = createServer((request, response) => {
    let requestPath = "<invalid-url>";
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    response.setHeader("cache-control", "no-store");
    void (async () => {
      const url = new URL(request.url ?? "/", options.origin);
      let path = url.pathname;
      requestPath = path;
      const method = request.method ?? "GET";
      if (path === "/healthz" && method === "GET")
        return json(response, 200, { ok: true });
      if (path === "/api/telegram/webhook" && method === "POST") {
        if (
          !options.telegram ||
          !options.telegramSecret ||
          !equal(
            String(request.headers["x-telegram-bot-api-secret-token"] ?? ""),
            options.telegramSecret,
          )
        )
          throw new HttpError(403, "Webhook não autorizado");
        await options.telegram.receive(
          (await body(request)) as unknown as TelegramUpdate,
        );
        return json(response, 200, { ok: true });
      }
      const token = /pi_session=([a-f0-9]{64})/.exec(
        request.headers.cookie ?? "",
      )?.[1];
      const owner = token ? hash(token) : "";
      const authenticated =
        owner &&
        app.store.get(
          "SELECT token FROM sessions WHERE token=? AND expires>?",
          owner,
          Date.now(),
        );
      if (method !== "GET" && method !== "HEAD") {
        if (request.headers.origin !== options.origin)
          throw new HttpError(403, "Origem inválida");
      }
      if (path === "/api/login" && method === "POST") {
        const forwarded = options.trustProxy
          ? String(request.headers["x-forwarded-for"] ?? "")
              .split(",")
              .at(-1)
              ?.trim()
          : undefined;
        const ip = forwarded || request.socket.remoteAddress || "unknown";
        const prior = attempts.get(ip);
        const attempt =
          prior && prior.until > Date.now()
            ? prior
            : { count: 0, until: Date.now() + 60000 };
        if (attempt.count >= 10)
          throw new HttpError(
            429,
            "Aguarde um minuto antes de tentar novamente",
          );
        attempt.count++;
        attempts.set(ip, attempt);
        if (attempts.size > 1000)
          for (const [key, value] of attempts)
            if (value.until < Date.now()) attempts.delete(key);
        const input = await body(request);
        if (!equal(text(input.password), options.password))
          throw new HttpError(401, "Senha inválida");
        const session = randomBytes(32).toString("hex");
        app.store.run("DELETE FROM sessions WHERE expires<=?", Date.now());
        app.store.run(
          "INSERT INTO sessions VALUES (?,?)",
          hash(session),
          Date.now() + 86400000,
        );
        response.setHeader(
          "set-cookie",
          `pi_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${options.secureCookie ? "; Secure" : ""}`,
        );
        return json(response, 200, { ok: true });
      }
      if (path.startsWith("/api/")) {
        if (!authenticated) throw new HttpError(401, "Faça login na interface");
        const conversationAccess =
          /^\/api\/conversations\/([0-9]+)(?:\/|$)/.exec(path);
        if (conversationAccess) {
          app.assertWebWritable(conversationAccess[1]);
          if (path.endsWith("/telegram/topic"))
            throw new HttpError(
              403,
              "Crie tópicos pelo Telegram. Os canais são separados.",
            );
        }
        const isolated = /^\/api\/human-controls\/([0-9]+)(.*)$/.exec(path);
        if (path.startsWith("/api/human-controls")) {
          if (!isolated) throw new HttpError(404, "Endpoint não encontrado");
          const [, id, resource] = isolated;
          if (!app.store.get("SELECT 1 FROM conversations WHERE id=?", id))
            throw new HttpError(404, "Conversa não encontrada");
          if (!app.isTelegramConversation(id))
            throw new HttpError(
              403,
              "Controles disponíveis apenas para conversas Telegram.",
            );
          app.assertConversationAvailable(id);
          if (!resource && method === "GET")
            return json(response, 200, humanControls(app, id));
          if (method !== "POST" || !humanControlResource(resource))
            throw new HttpError(404, "Endpoint não encontrado");
          // Explicit aliases reach the existing validated control handlers only.
          path = `/api/conversations/${id}${resource}`;
        }
        const controlReply = (value: unknown) =>
          isolated ? { ok: true } : value;
        if (path === "/api/conversations/events" && method === "GET") {
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          streams.add(response);
          response.write("retry: 1500\n\n");
          let closed = false;
          let previousVersion: string | undefined;
          const send = () => {
            if (closed) return;
            try {
              if (
                !app.store.get(
                  "SELECT token FROM sessions WHERE token=? AND expires>?",
                  owner,
                  Date.now(),
                )
              ) {
                response.end();
                return;
              }
              if (
                response.writableNeedDrain ||
                response.writableLength > 262144
              )
                return;
              // Only list metadata is polled. A chat created on another transport
              // must not depend on a change to the selected transcript watcher.
              const version = conversationListVersion();
              if (version !== previousVersion) {
                response.write(
                  `event: conversations\ndata: ${JSON.stringify({ version })}\n\n`,
                );
                previousVersion = version;
              }
            } catch {
              response.end();
            }
          };
          const poll = setInterval(send, 1000);
          const ping = setInterval(() => {
            if (response.writableLength > 1048576) response.end();
            else if (!response.writableNeedDrain) response.write(": ping\n\n");
          }, 15000);
          response.on("close", () => {
            closed = true;
            clearInterval(poll);
            clearInterval(ping);
            streams.delete(response);
          });
          send();
          return;
        }
        if (path === "/api/telegram" && method === "GET") {
          return json(
            response,
            200,
            webTelegramStatus(telegramConnection.snapshot()),
          );
        }
        if (path === "/api/telegram/connect" && method === "POST") {
          const input = await body(request);
          if (input.conversationId !== undefined)
            app.assertWebWritable(text(input.conversationId));
          return json(
            response,
            200,
            webTelegramStatus(await telegramConnection.connect(input)),
          );
        }
        if (path === "/api/telegram/disconnect" && method === "POST")
          return json(
            response,
            200,
            webTelegramStatus(
              await telegramConnection.disconnect(await body(request)),
            ),
          );
        if (path === "/api/logout" && method === "POST") {
          app.store.run("DELETE FROM sessions WHERE token=?", owner);
          response.setHeader(
            "set-cookie",
            `pi_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${options.secureCookie ? "; Secure" : ""}`,
          );
          return json(response, 200, { ok: true });
        }
        if (path === "/api/status" && method === "GET")
          return json(response, 200, {
            mode: app.options.mode ?? "demo",
            provider: app.settings.provider,
            model: app.settings.defaults().modelId,
            effort: app.settings.defaults().effort,
            credentials:
              app.settings
                .providers()
                .find((provider) => provider.id === app.settings.provider)
                ?.credentialType ?? null,
            providers: app.settings.providers(),
          });
        if (path === "/api/settings") {
          if (method === "GET")
            return json(response, 200, { ...app.settings.snapshot(), appInfo });
          if (method === "PUT")
            return json(
              response,
              200,
              app.settings.saveDefaults(await body(request)),
            );
        }
        if (path === "/api/mcp") {
          if (method === "GET") return json(response, 200, app.settings.mcp());
          if (method === "PUT")
            return json(
              response,
              200,
              await app.settings.saveMcp((await body(request)).servers),
            );
        }
        const mcp = /^\/api\/mcp\/([\w-]+)\/tools$/.exec(path);
        if (mcp && method === "GET")
          return json(response, 200, await app.settings.discover(mcp[1]));
        if (path === "/api/tasks") {
          if (method === "GET")
            return json(
              response,
              200,
              tasks
                .list()
                .filter(
                  (task) => !app.isTelegramConversation(task.conversationId),
                ),
            );
          if (method === "POST") {
            const input = await body(request);
            if (input.conversationId !== undefined)
              app.assertWebWritable(text(input.conversationId));
            return json(response, 201, await tasks.create(input));
          }
        }
        if (path === "/api/tasks/telegram-availability" && method === "GET") {
          const conversationId = url.searchParams.get("conversationId");
          if (!conversationId)
            throw new HttpError(400, "Informe a conversa da tarefa");
          app.assertWebWritable(conversationId);
          return json(response, 200, {
            available: tasks.telegramAvailability(conversationId),
          });
        }
        const taskRoute = /^\/api\/tasks\/([a-f0-9-]+)(?:\/(run|runs))?$/.exec(
          path,
        );
        if (taskRoute) {
          const [, id, resource] = taskRoute;
          if (!tasks.get(id)) throw new HttpError(404, "Tarefa não encontrada");
          app.assertWebWritable(tasks.get(id)!.conversationId);
          if (resource === "runs" && method === "GET")
            return json(response, 200, tasks.runs(id));
          if (method !== "GET")
            app.assertWebWritable(tasks.get(id)!.conversationId);
          if (resource === "run" && method === "POST") {
            const input = await body(request);
            return json(
              response,
              202,
              await tasks.runNow(id, text(input.requestId)),
            );
          }
          if (!resource && method === "PUT") {
            const input = await body(request);
            if (input.conversationId !== undefined)
              app.assertWebWritable(text(input.conversationId));
            return json(response, 200, tasks.update(id, input));
          }
          if (!resource && method === "DELETE") {
            tasks.remove(id);
            return json(response, 200, { ok: true });
          }
        }
        if (path === "/api/conversations") {
          if (method === "GET")
            return json(
              response,
              200,
              webConversations(url.searchParams.get("deleted") === "1"),
            );
          if (method === "POST") {
            const input = await body(request);
            const id = await app.createWebConversation(
              input.title === undefined ? "Nova conversa" : text(input.title),
              input.requestId,
            );
            return json(response, 201, { id });
          }
        }
        if (path === "/api/provider/connections" && method === "GET")
          return json(response, 200, app.providerConnections.list());
        if (
          (path === "/api/provider/connections" ||
            path === "/api/provider/connections/models") &&
          method === "POST"
        ) {
          if (app.options.mode !== "live")
            throw new HttpError(
              409,
              "Ative APP_MODE=live para conectar o provider",
            );
          const input = await body(request);
          return path.endsWith("/models")
            ? json(response, 200, await app.providerConnections.discover(input))
            : json(response, 201, {
                connection: await app.providerConnections.create(input),
              });
        }
        if (path === "/api/provider/login" && method === "POST") {
          if (app.options.mode !== "live")
            throw new HttpError(
              409,
              "Ative APP_MODE=live para conectar o provider",
            );
          const input = request.headers["content-type"]?.startsWith(
            "application/json",
          )
            ? await body(request)
            : {};
          const provider =
            input.provider === undefined ? "openai" : text(input.provider);
          if (input.type !== undefined && input.type !== "oauth")
            throw new SettingsError(
              "Use o formulário de chave de API para este método",
            );
          return json(response, 202, {
            id: login.start(owner, provider, "oauth", input.replace === true),
          });
        }
        const apiKeyRoute = /^\/api\/provider\/([\w-]+)\/api-key$/.exec(path);
        if (apiKeyRoute && method === "PUT") {
          if (app.options.mode !== "live")
            throw new HttpError(
              409,
              "Ative APP_MODE=live para conectar o provider",
            );
          const input = await body(request);
          return json(
            response,
            200,
            await login.saveApiKey(
              apiKeyRoute[1],
              input.apiKey,
              input.replace === true,
            ),
          );
        }
        const flow = /^\/api\/provider\/login\/([\w-]+)$/.exec(path);
        if (flow) {
          if (method === "GET")
            return json(response, 200, login.get(owner, flow[1]));
          if (method === "POST") {
            const input = await body(request);
            login.answer(
              owner,
              flow[1],
              text(input.promptId),
              text(input.value),
            );
            return json(response, 200, { ok: true });
          }
          if (method === "DELETE") {
            login.cancel(owner, flow[1]);
            return json(response, 200, { ok: true });
          }
        }
        const handoffRoute =
          /^\/api\/conversations\/([0-9]+)\/cua-handoffs\/([a-f0-9-]+)\/(create|end)$/.exec(
            path,
          );
        if (handoffRoute && method === "POST") {
          const [, id, handoffId, operation] = handoffRoute;
          await app.conversation(id);
          if (!app.cuaHandoffs)
            throw new HttpError(400, "Viewer CUA indisponível neste ambiente.");
          const input = await body(request);
          return json(
            response,
            200,
            controlReply(
              operation === "create"
                ? await app.cuaHandoffs.create(id, handoffId, input)
                : app.cuaHandoffs.end(id, handoffId, input),
            ),
          );
        }
        const interactionRoute =
          /^\/api\/conversations\/([0-9]+)\/mcp-interactions\/([a-f0-9-]+)$/.exec(
            path,
          );
        if (interactionRoute && method === "POST") {
          const [, id, interactionId] = interactionRoute;
          await app.conversation(id);
          const input = await body(request);
          const decision = text(input.action);
          if (!["accept", "decline", "cancel"].includes(decision))
            throw new HttpError(400, "Decisão MCP inválida");
          if (
            input.content !== undefined &&
            (!input.content ||
              typeof input.content !== "object" ||
              Array.isArray(input.content))
          )
            throw new HttpError(400, "Resposta MCP inválida");
          const interaction = await app.mcpCalls.decide(
            id,
            interactionId,
            decision as "accept" | "decline" | "cancel",
            input.content as Record<string, unknown> | undefined,
          );
          if (interaction.kind === "resume") {
            const call = app.mcpCalls
              .list(id)
              .find((c) => c.id === interaction.callId);
            if (call) await app.recordMcpOutcome(call);
          }
          return json(response, 200, controlReply(interaction));
        }
        const reconcileMcp =
          /^\/api\/conversations\/([0-9]+)\/mcp-calls\/([a-f0-9]{24})\/reconcile$/.exec(
            path,
          );
        if (reconcileMcp && method === "POST") {
          await app.conversation(reconcileMcp[1]);
          const call = app.mcpCalls.reconcile(
            reconcileMcp[1],
            reconcileMcp[2],
            text((await body(request)).note),
          );
          if (call) await app.recordMcpOutcome(call);
          return json(response, 200, controlReply(call));
        }
        if (path === "/api/commands" && method === "GET")
          return json(response, 200, { commands: webCommandCatalog });
        if (path === "/api/commands/tasks" && method === "GET")
          return json(
            response,
            200,
            await app.commands.active({ source: "web" }),
          );
        const commandStatus =
          /^\/api\/conversations\/([0-9]+)\/commands\/([\w:.-]{1,160})$/.exec(
            path,
          );
        if (commandStatus && method === "GET") {
          const receipt = await app.commands.receipt(
            commandStatus[1],
            commandStatus[2],
            { source: "web" },
          );
          if (!receipt)
            throw new HttpError(404, "Recibo de comando não encontrado");
          return json(response, 200, receipt);
        }
        const purgeRoute = /^\/api\/conversations\/([0-9]+)\/purge$/.exec(path);
        if (purgeRoute && method === "POST") {
          const input = await body(request);
          return json(
            response,
            200,
            await app.purgeConversation(
              purgeRoute[1],
              input.confirm,
              input.expectedDeletedAt,
            ),
          );
        }
        const restoreRoute = /^\/api\/conversations\/([0-9]+)\/restore$/.exec(
          path,
        );
        if (restoreRoute && method === "POST")
          return json(response, 200, app.restoreConversation(restoreRoute[1]));
        const messageRoute =
          /^\/api\/conversations\/([0-9]+)\/history\/([1-9][0-9]{0,15})\/([0-9]{1,6})$/.exec(
            path,
          );
        if (messageRoute && method === "GET") {
          const [, id, entryId, index] = messageRoute;
          const number = Number(entryId);
          if (!Number.isSafeInteger(number))
            throw new HttpError(400, "Mensagem inválida");
          const message = await app.historyMessage(id, number, Number(index));
          if (url.searchParams.get("view") === "text") {
            const rawOffset = url.searchParams.get("offset") ?? "0";
            const offset = Number(rawOffset);
            if (
              !/^(0|[1-9][0-9]*)$/.test(rawOffset) ||
              !Number.isSafeInteger(offset)
            )
              throw new HttpError(400, "Mensagem inválida");
            return json(response, 200, chatMessageTextPage(message, offset));
          }
          return json(response, 200, message);
        }
        const deliveryRoute =
          /^\/api\/conversations\/([0-9]+)\/deliveries\/([^/]+)\/reconcile$/.exec(
            path,
          );
        if (deliveryRoute && method === "POST") {
          const [, id, encodedDeliveryId] = deliveryRoute;
          const input = await body(request);
          if (input.confirm !== true)
            throw new HttpError(400, "Confirme a resolução sem reenvio.");
          return json(
            response,
            200,
            app.reconcileDelivery(
              id,
              decodeURIComponent(encodedDeliveryId),
              input.note,
            ),
          );
        }
        const route =
          /^\/api\/conversations\/([0-9]+)(?:\/(messages|events|link|actions|settings)(?:\/([a-f0-9]{24}))?)?$/.exec(
            path,
          );
        if (route) {
          const [, id, resource, actionId] = route;
          const compact = url.searchParams.get("view") === "chat";
          const rawPage = url.searchParams.get("page") ?? "0";
          if (compact && !/^\d{1,9}$/.test(rawPage))
            throw new HttpError(400, "Página inválida");
          const page = Number(rawPage);
          const snapshot = async () => {
            const value = await app.snapshot(id, compact);
            return compact ? chatSnapshot(value, page) : value;
          };
          if (!resource && method === "PUT")
            return json(
              response,
              200,
              await app.renameConversation(
                id,
                (await body(request)).title,
                options.telegramConnection?.renameTopic.bind(
                  options.telegramConnection,
                ),
              ),
            );
          if (!resource && method === "DELETE") {
            if ((await body(request)).confirm !== true)
              throw new HttpError(
                400,
                "Confirme explicitamente a exclusão da conversa.",
              );
            return json(response, 200, await app.deleteConversation(id));
          }
          await app.conversation(id);
          if (!resource && method === "GET")
            return json(response, 200, await snapshot());
          if (resource === "settings" && method === "PUT")
            return json(
              response,
              200,
              await app.settings.saveConversation(id, await body(request)),
            );
          if (resource === "messages" && method === "POST") {
            const input = await body(request);
            return json(
              response,
              202,
              await app.admit(id, text(input.requestId), text(input.text), {
                source: "web",
              }),
            );
          }
          if (resource === "link" && method === "POST") {
            app.commands.authorize(id, { source: "web" });
            const code = app.store.link(id);
            return json(response, 201, {
              code,
              command: `/link ${code}`,
              expiresIn: 600,
              ...(options.telegram?.botUsername
                ? {
                    url: `https://t.me/${options.telegram.botUsername}?start=${code}`,
                  }
                : {}),
            });
          }
          if (resource === "actions" && method === "POST" && actionId) {
            const input = await body(request);
            const decision = text(input.decision);
            if (!["approve", "deny", "reconcile"].includes(decision))
              throw new HttpError(400, "Decisão inválida");
            const action =
              decision === "reconcile"
                ? app.actions.reconcile(id, actionId, text(input.note))
                : await app.actions.decide(
                    id,
                    actionId,
                    decision as "approve" | "deny",
                  );
            await app.recordAction(action);
            return json(response, 200, controlReply(action));
          }
          if (resource === "actions" && method === "GET" && actionId) {
            const action = app.store.get(
              "SELECT * FROM actions WHERE id=? AND conversationId=?",
              actionId,
              id,
            );
            if (!action) throw new HttpError(404, "Ação não encontrada");
            return json(response, 200, controlReply(action));
          }
          if (resource === "events" && method === "GET") {
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
              "x-accel-buffering": "no",
            });
            streams.add(response);
            response.write("retry: 1500\n\n");
            let dirty = true;
            let sending = false;
            let closed = false;
            let lastSnapshotHash: string | undefined;
            let lastHistoryVersion: string | undefined;
            let lastListVersion: string | undefined;
            let detach: (() => void) | undefined;
            let poll: ReturnType<typeof setInterval> | undefined;
            let ping: ReturnType<typeof setInterval> | undefined;
            const cleanup = () => {
              if (closed) return;
              closed = true;
              if (poll) clearInterval(poll);
              poll = undefined;
              if (ping) clearInterval(ping);
              ping = undefined;
              const attached = detach;
              detach = undefined;
              streams.delete(response);
              attached?.();
            };
            // A client can leave while Durable is still attaching the watcher.
            // Install cleanup before that await and release a late subscription.
            response.once("close", cleanup);
            if (response.destroyed) {
              cleanup();
              return;
            }
            const attached = await app.watch(id, () => {
              dirty = true;
            });
            if (closed || response.destroyed) {
              cleanup();
              attached();
              return;
            }
            detach = attached;
            const send = async () => {
              if (
                !closed &&
                !response.writableNeedDrain &&
                response.writableLength <= 262144
              ) {
                try {
                  if (
                    !app.store.get(
                      "SELECT token FROM sessions WHERE token=? AND expires>?",
                      owner,
                      Date.now(),
                    )
                  ) {
                    response.end();
                    return;
                  }
                  const version = conversationListVersion();
                  if (version !== lastListVersion) {
                    response.write(
                      `event: conversations\ndata: ${JSON.stringify({ version })}\n\n`,
                    );
                    lastListVersion = version;
                  }
                } catch {
                  response.end();
                  return;
                }
              }
              if (
                !dirty ||
                sending ||
                closed ||
                response.writableNeedDrain ||
                response.writableLength > 262144
              )
                return;
              sending = true;
              dirty = false;
              try {
                if (
                  !app.store.get(
                    "SELECT token FROM sessions WHERE token=? AND expires>?",
                    owner,
                    Date.now(),
                  )
                ) {
                  response.end();
                  return;
                }
                const current = await snapshot();
                const history =
                  "history" in current ? current.history : undefined;
                const state = history
                  ? {
                      ...current,
                      history: undefined,
                      historyVersion: history.version,
                    }
                  : current;
                const encodedState = JSON.stringify(state);
                const snapshotHash = hash(encodedState);
                // Keep polling for SQLite-only transitions (approvals, MCP,
                // deliveries). Deduplicate before the browser parses SSE/JSON,
                // and keep only a digest rather than another history in memory.
                if (!closed && snapshotHash !== lastSnapshotHash) {
                  // Existing clients still receive full snapshots. Compact
                  // streams send a page only when its immutable message keys
                  // change; live/control transitions carry no history bodies.
                  const includeHistory =
                    !history || history.version !== lastHistoryVersion;
                  const encoded = includeHistory
                    ? JSON.stringify(current)
                    : encodedState;
                  response.write(
                    `event: ${includeHistory ? "snapshot" : "state"}\ndata: ${encoded}\n\n`,
                  );
                  // A false write result is already queued by Node. Do not
                  // retransmit it; resume with the latest state after drain.
                  lastSnapshotHash = snapshotHash;
                  lastHistoryVersion = history?.version;
                }
              } catch {
                response.end();
              } finally {
                sending = false;
              }
            };
            poll = setInterval(() => {
              dirty = true;
              void send();
            }, 500);
            ping = setInterval(() => {
              if (response.writableLength > 1048576) response.end();
              else if (!response.writableNeedDrain)
                response.write(": ping\n\n");
            }, 15000);
            await send();
            return;
          }
        }
        throw new HttpError(404, "Endpoint não encontrado");
      }
      if (method !== "GET") throw new HttpError(405, "Método não permitido");
      const assets: Record<string, [string, string]> = {
        "/": ["index.html", "text/html"],
        "/human-controls": ["human-controls.html", "text/html"],
        "/human-controls.js": ["human-controls.js", "text/javascript"],
        "/human-controls-page.js": [
          "human-controls-page.js",
          "text/javascript",
        ],
        "/app.js": ["app.js", "text/javascript"],
        "/commands.js": ["commands.js", "text/javascript"],
        "/conversations.js": ["conversations.js", "text/javascript"],
        "/conversation-events.js": [
          "conversation-events.js",
          "text/javascript",
        ],
        "/markdown.js": ["markdown.js", "text/javascript"],
        "/marked.js": [
          fileURLToPath(import.meta.resolve("marked")),
          "text/javascript",
        ],
        "/settings.js": ["settings.js", "text/javascript"],
        "/provider-connections.js": [
          "provider-connections.js",
          "text/javascript",
        ],
        "/telegram.js": ["telegram.js", "text/javascript"],
        "/tools.js": ["tools.js", "text/javascript"],
        "/telegram-deliveries.js": [
          "telegram-deliveries.js",
          "text/javascript",
        ],
        "/cua-handoffs.js": ["cua-handoffs.js", "text/javascript"],
        "/history.js": ["history.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
        "/manifest.webmanifest": [
          "manifest.webmanifest",
          "application/manifest+json",
        ],
        "/sw.js": ["sw.js", "text/javascript"],
        "/icon.svg": ["icon.svg", "image/svg+xml"],
        "/theme.js": ["theme.js", "text/javascript"],
        "/i18n.js": ["i18n.js", "text/javascript"],
        "/i18n-catalog.js": ["i18n-catalog.js", "text/javascript"],
        "/icons.svg": ["icons.svg", "image/svg+xml"],
        "/pi-logo.svg": ["pi-logo.svg", "image/svg+xml"],
        "/fonts/dm-sans-400-normal.ttf": [
          "fonts/dm-sans-400-normal.ttf",
          "font/ttf",
        ],
        "/fonts/dm-sans-500-normal.ttf": [
          "fonts/dm-sans-500-normal.ttf",
          "font/ttf",
        ],
        "/fonts/dm-sans-600-normal.ttf": [
          "fonts/dm-sans-600-normal.ttf",
          "font/ttf",
        ],
        "/fonts/instrument-serif-400-italic.ttf": [
          "fonts/instrument-serif-400-italic.ttf",
          "font/ttf",
        ],
        "/fonts/instrument-serif-400-normal.ttf": [
          "fonts/instrument-serif-400-normal.ttf",
          "font/ttf",
        ],
      };
      const asset = assets[path];
      if (!asset) throw new HttpError(404, "Página não encontrada");
      const file = await staticFile(
        path === "/marked.js"
          ? asset[0]
          : resolve(options.publicDir ?? "public", asset[0]),
      );
      const font = asset[1].startsWith("font/");
      // Code and markup revalidate on every load; vendored fonts never change in place.
      response.setHeader(
        "cache-control",
        font ? "public, max-age=2592000" : "no-cache",
      );
      response.setHeader("etag", file.etag);
      if (
        request.headers["if-none-match"]
          ?.split(",")
          .some((tag) => tag.trim().replace(/^W\//, "") === file.etag)
      ) {
        response.writeHead(304);
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": font ? asset[1] : `${asset[1]}; charset=utf-8`,
      });
      response.end(file.bytes);
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const known =
        error instanceof HttpError ||
        error instanceof SettingsError ||
        error instanceof CommandError ||
        error instanceof TaskError ||
        error instanceof ConversationError ||
        error instanceof PolicyError ||
        error instanceof McpError ||
        error instanceof CuaHandoffError ||
        error instanceof TelegramSetupError;
      const internal = !known && internalError(error);
      if (!known)
        logFailure(
          `Falha ${internal ? "interna" : "não classificada"} em ${request.method} ${requestPath}`,
          error,
        );
      const status =
        error instanceof HttpError || error instanceof ConversationError
          ? error.status
          : internal
            ? 500
            : 400;
      json(response, status, {
        error: known ? error.message : "Não foi possível processar a operação",
      });
    });
  });
  const close = async () => {
    await tasks.close();
    if (timer) clearInterval(timer);
    login.close();
    await options.telegram?.drain();
    await telegramConnection.close();
    for (const stream of streams) stream.end();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  };
  return { server, close };
}
