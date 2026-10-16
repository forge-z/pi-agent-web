import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ConversationError,
  ConversationHeldError,
  type Runtime,
} from "./runtime.js";
import {
  telegramConversationRoute,
  telegramRouteAuthorized,
} from "./task-telegram.js";
import { syncTopicTitle } from "./telegram-controls.js";
import { hash } from "./store.js";
import { CommandError } from "./commands.js";
import {
  TelegramTopics,
  type TelegramTopicMirrorResult,
} from "./telegram-topics.js";
import {
  TelegramCommandMenu,
  type TelegramCommandMenuStatus,
} from "./telegram-commands.js";
import {
  Telegram,
  TelegramInputError,
  TelegramSendRefused,
  type TelegramUpdate,
} from "./telegram.js";

type Method =
  | "getMe"
  | "getWebhookInfo"
  | "getUpdates"
  | "deleteWebhook"
  | "sendMessage"
  | "sendChatAction"
  | "getMyCommands"
  | "setMyCommands"
  | "answerCallbackQuery"
  | "editForumTopic"
  | "editMessageText"
  | "createForumTopic";
export interface TelegramApi {
  call(
    method: Method,
    payload?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
export class TelegramSetupError extends Error {}
export class TelegramApiError extends Error {
  constructor(
    readonly kind: "invalid_token" | "conflict" | "rate_limit" | "unavailable",
    readonly retryAfter = 0,
    /** Set only when Telegram itself answered with a 4xx refusal. */
    readonly refusedCode?: number,
  ) {
    super(
      {
        invalid_token: "Token Telegram inválido. Atualize a conexão.",
        conflict:
          "Outro processo ou webhook está recebendo atualizações deste bot. Desconecte-o antes de continuar.",
        rate_limit:
          "Limite do Telegram atingido. A conexão será retomada após a espera.",
        unavailable: "Telegram indisponível. A conexão será tentada novamente.",
      }[kind],
    );
  }
}
export class TelegramBotApi implements TelegramApi {
  constructor(private token: string) {}
  async call(
    method: Method,
    payload: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.any([
            AbortSignal.timeout(method === "getUpdates" ? 35000 : 15000),
            ...(signal ? [signal] : []),
          ]),
        },
      );
      const data = (await response.json()) as {
        ok?: boolean;
        result?: unknown;
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      const code = data.error_code ?? response.status;
      if (!response.ok || data.ok !== true) {
        const refused =
          data.ok === false && code >= 400 && code < 500 ? code : undefined;
        if (code === 401 || code === 404)
          throw new TelegramApiError("invalid_token", 0, refused);
        if (code === 409) throw new TelegramApiError("conflict", 0, refused);
        if (code === 429)
          throw new TelegramApiError(
            "rate_limit",
            Number(data.parameters?.retry_after) || 1,
            refused,
          );
        throw new TelegramApiError("unavailable", 0, refused);
      }
      return data.result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // Raw fetch failures and Telegram descriptions may contain the credential URL.
      if (error instanceof TelegramApiError) throw error;
      throw new TelegramApiError("unavailable");
    }
  }
}
interface Bot {
  id: number;
  username?: string;
  firstName?: string;
}
interface Config {
  enabled: boolean;
  bot: Bot;
  userId: string;
  conversationId: string;
  chatId: string | null;
  languageCode?: string;
}
export interface TelegramSnapshot {
  state:
    | "unconfigured"
    | "migration_required"
    | "disconnected"
    | "connecting"
    | "connected"
    | "retrying"
    | "blocked"
    | "webhook_conflict";
  configured: boolean;
  hasToken: boolean;
  awaitingFirstMessage: boolean;
  userId: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  bot: Bot | null;
  lastSuccessAt: number | null;
  error: string | null;
  webhookUrl: string | null;
  webhookVersion: string | null;
  commandMenu: TelegramCommandMenuStatus;
}
export interface TelegramConnectionOptions {
  apiFactory?: (token: string) => TelegramApi;
  legacy?: {
    hasToken?: boolean;
    userIds?: string[];
    readToken?: () => string | undefined;
  };
  retryBaseMs?: number;
}
interface Receipt {
  fingerprint: string;
  state: "pending" | "done" | "uncertain";
}
const configKey = "telegram:connection";
const credentialKey = "telegram:bot";
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });

/** One owner, one polling loop. Setup receipts never contain tokens or webhook URLs. */
export class TelegramConnection {
  private commandMenu: TelegramCommandMenu;
  private topics: TelegramTopics;
  private topicRenames = new Map<string, Promise<string>>();
  private config: Config | undefined;
  private candidate:
    Pick<Config, "bot" | "userId" | "conversationId"> | undefined;
  private state: TelegramSnapshot["state"] = "unconfigured";
  private error: string | null = null;
  private lastSuccessAt: number | null = null;
  private webhookUrl: string | null = null;
  private webhookVersion: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private controller: AbortController | undefined;
  private polling: Promise<void> | undefined;
  private engine: Telegram | undefined;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private closing = false;
  private lifetime = new AbortController();
  private restoreWork: Promise<void> | undefined;
  constructor(
    private app: Runtime,
    private options: TelegramConnectionOptions = {},
  ) {
    this.topics = new TelegramTopics(app);
    this.commandMenu = new TelegramCommandMenu(
      app.store,
      this.options.retryBaseMs ?? 30000,
    );
    app.store.db.exec(
      "CREATE TABLE IF NOT EXISTS telegram_poll_receipts(botId INTEGER, id INTEGER, fingerprint TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(botId,id))",
    );
    this.config = this.meta<Config>(configKey);
    const legacy = this.legacyMappings();
    this.state = this.config
      ? "disconnected"
      : this.options.legacy?.hasToken || legacy.length
        ? "migration_required"
        : "unconfigured";
    const interrupted = this.app.store
      .all<{ value: string }>(
        "SELECT value FROM meta WHERE key LIKE 'telegram:setup:connect:%'",
      )
      .map((row) => JSON.parse(row.value) as Receipt)
      .some((receipt) => receipt.state !== "done");
    if (interrupted && !this.config?.enabled) {
      this.state = "blocked";
      this.error =
        "Uma conexão anterior teve resultado incerto. Inicie uma nova conexão explícita para consultar o webhook antes de continuar.";
    }
    chmodSync(app.options.dir, 0o700);
    for (const name of ["app.sqlite", "app.sqlite-wal", "app.sqlite-shm"]) {
      const path = join(app.options.dir, name);
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }
  /** Mirror a new web conversation without changing its canonical id or retrying uncertain effects. */
  async mirrorConversation(
    id: string,
    explicitCompletion = false,
  ): Promise<TelegramTopicMirrorResult> {
    const usable =
      !this.closing &&
      ["connected", "connecting", "retrying"].includes(this.state);
    if (!usable)
      return {
        state: "unavailable",
        canComplete: false,
        ...(!this.closing &&
        this.config?.enabled &&
        !["disconnected", "unconfigured"].includes(this.state)
          ? {
              reason:
                "Resolva o bloqueio da conexão Telegram antes de concluir o tópico.",
            }
          : {}),
      };
    const route = () => {
      if (
        this.closing ||
        !["connected", "connecting", "retrying"].includes(this.state) ||
        this.controller?.signal.aborted
      )
        return;
      return this.app.telegramChats.configuredOwner();
    };
    const credential = this.credential();
    if (!route() || !credential)
      return {
        state: "unavailable",
        canComplete: false,
        reason:
          "A conexão Telegram não tem um bot, usuário e chat autorizados. Configure a conexão antes de concluir o tópico.",
      };
    return this.topics.mirror(
      id,
      (chat, name) =>
        this.api(credential.token).call(
          "createForumTopic",
          { chat_id: chat, name },
          this.controller?.signal,
        ),
      route,
      { ready: this.state === "connected", explicitCompletion },
    );
  }
  /** A confirmed API response or a newer native observation is the only title authority. */
  renameTopic(id: string, name: string): Promise<string> {
    const route = telegramConversationRoute(this.app.store, id);
    const key =
      route &&
      `${route.botId}:${route.chat}:${route.user}:${route.messageThreadId}`;
    if (key && this.topicRenames.has(key))
      return Promise.reject(
        new ConversationError("Tópico em atualização. Tente novamente.", 409),
      );
    const work = this.renameTopicChange(id, name);
    if (key) {
      this.topicRenames.set(key, work);
      void work.finally(() => this.topicRenames.delete(key)).catch(() => {});
    }
    return work;
  }
  private async renameTopicChange(id: string, name: string): Promise<string> {
    const store = this.app.store;
    const route = telegramConversationRoute(store, id);
    const identity = this.app.telegramChats.configuredOwner();
    const credential = this.credential();
    if (
      this.closing ||
      this.state !== "connected" ||
      !route ||
      route.messageThreadId === null ||
      !identity ||
      !credential
    )
      throw new ConversationError(
        "Telegram não está conectado e autorizado para renomear este tópico.",
        409,
      );
    const version = store.authorizationVersion(route, id);
    const observed = () =>
      store.get<{
        name: string | null;
        nameUpdateId: number;
        nameBotId: string | null;
        nameDate: number;
      }>(
        "SELECT name,nameUpdateId,nameBotId,nameDate FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=?",
        route.chat,
        route.user,
        route.messageThreadId,
      );
    const before = observed();
    const observation = hash(JSON.stringify(before ?? null));
    const key = `telegram:topic-rename:${route.botId}:${route.chat}:${route.user}:${route.messageThreadId}`;
    const prior = this.meta<{
      state: string;
      observation: string;
      retryAt?: number;
    }>(key);
    const implicit =
      before &&
      this.meta<{ state: string }>(
        `telegram:topic-title:${route.botId}:${before.nameUpdateId}`,
      );
    if (implicit && ["pending", "uncertain"].includes(implicit.state))
      throw new ConversationError(
        "A edição inicial deste tópico está pendente ou incerta. Aguarde uma nova observação no Telegram.",
        409,
      );
    // A lost response may have applied. Neither repeated clicks nor restart may replay it.
    if (prior?.state === "uncertain" && prior.observation === observation)
      throw new ConversationError(
        "Renomeação com resultado incerto. Verifique o nome no Telegram; ela não será repetida até uma nova observação do tópico.",
        409,
      );
    if (prior?.retryAt && prior.retryAt > Date.now())
      throw new ConversationError(
        "Aguarde o limite de requisições do Telegram antes de tentar novamente.",
        409,
      );
    if (before?.name === name) return name;
    this.save(key, { state: "uncertain", observation });
    const requestedAt = Math.floor(Date.now() / 1000);
    let result: unknown;
    try {
      result = await this.api(credential.token).call(
        "editForumTopic",
        {
          chat_id: route.chat,
          message_thread_id: route.messageThreadId,
          name,
        },
        this.controller?.signal,
      );
    } catch (error) {
      if (error instanceof TelegramApiError && error.refusedCode) {
        this.save(key, {
          state: "failed",
          observation,
          ...(error.refusedCode === 429
            ? { retryAt: Date.now() + Math.max(1, error.retryAfter) * 1000 }
            : {}),
        });
        throw new ConversationError(
          "Telegram recusou a renomeação. O nome anterior foi mantido; tente novamente após resolver a recusa.",
          409,
        );
      }
      throw new ConversationError(
        "Renomeação com resultado incerto. Verifique no Telegram antes de continuar.",
        409,
      );
    }
    if (result !== true)
      throw new ConversationError(
        "Renomeação com resultado incerto. Verifique no Telegram antes de continuar.",
        409,
      );
    if (
      this.closing ||
      !telegramRouteAuthorized(store, route) ||
      store.authorizationVersion(route, id) !== version ||
      this.app.telegramChats.configuredOwner()?.credentialBinding !==
        identity.credentialBinding
    )
      throw new ConversationError(
        "O Telegram confirmou a edição, mas a autorização mudou. O vínculo não foi reativado.",
        409,
      );
    // An event received during the call is newer authority; never overwrite it with a late response.
    if (hash(JSON.stringify(observed() ?? null)) === observation) {
      store.run(
        `INSERT INTO telegram_known_topics(chat,user,messageThreadId,name,nameDate,nameBotId,nameUpdateId) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(chat,user,messageThreadId) DO UPDATE SET name=excluded.name,nameDate=excluded.nameDate,nameBotId=excluded.nameBotId,nameUpdateId=excluded.nameUpdateId`,
        route.chat,
        route.user,
        route.messageThreadId,
        name,
        Math.max(requestedAt, before?.nameDate ?? 0),
        route.botId,
        Math.max(
          before?.nameUpdateId ?? -1,
          (this.meta<number>(`telegram:offset:${route.botId}`) ?? 0) - 1,
        ),
      );
    }
    syncTopicTitle(this.app, {
      ...route,
      messageThreadId: route.messageThreadId,
    });
    this.save(key, {
      state: "done",
      observation: hash(JSON.stringify(observed() ?? null)),
    });
    return observed()?.name ?? name;
  }
  private meta<T>(key: string): T | undefined {
    const row = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      key,
    );
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  private save(key: string, value: unknown) {
    this.app.store.run(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  private credential() {
    const row = this.app.store.get<{ value: string }>(
      "SELECT value FROM credentials WHERE provider=?",
      credentialKey,
    );
    return row
      ? (JSON.parse(row.value) as { token: string; botId: number })
      : undefined;
  }
  private legacyMappings() {
    return this.app.store.all<{ user: string; conversationId: string }>(
      "SELECT DISTINCT user,conversationId FROM telegram",
    );
  }
  snapshot(): TelegramSnapshot {
    const metadata = this.candidate ?? this.config;
    const legacy = this.legacyMappings();
    const users = this.options.legacy?.userIds ?? [
      ...new Set(legacy.map((row) => row.user)),
    ];
    const mapped =
      this.config?.chatId && !this.candidate
        ? this.app.store.get<{ conversationId: string }>(
            "SELECT conversationId FROM telegram WHERE chat=? AND user=?",
            this.config.chatId,
            this.config.userId,
          )
        : undefined;
    const candidateConversationId =
      mapped?.conversationId ??
      metadata?.conversationId ??
      (legacy.length === 1 ? legacy[0].conversationId : null);
    const conversationId =
      candidateConversationId &&
      !this.app.store.conversationDeleted(candidateConversationId) &&
      (mapped ||
        !this.app.store.get(
          "SELECT 1 FROM telegram_initial_revocations WHERE conversationId=?",
          candidateConversationId,
        ))
        ? candidateConversationId
        : null;
    return {
      state: this.state,
      configured: !!this.config,
      hasToken: !!this.credential() || !!this.options.legacy?.hasToken,
      awaitingFirstMessage: !!this.config?.enabled && !this.config.chatId,
      userId: metadata?.userId ?? (users.length === 1 ? users[0] : null),
      conversationId,
      conversationTitle: conversationId
        ? (this.app.store.get<{ title: string }>(
            "SELECT title FROM conversations WHERE id=?",
            conversationId,
          )?.title ?? null)
        : null,
      bot: metadata?.bot ?? null,
      lastSuccessAt: this.lastSuccessAt,
      error: this.error,
      webhookUrl: this.webhookUrl,
      webhookVersion: this.webhookVersion,
      commandMenu: this.commandMenu.status,
    };
  }
  restore() {
    this.restoreWork ??= this.serialize(async () => {
      const credential = this.credential();
      if (this.config?.enabled && credential)
        await this.start(credential.token);
    });
    return this.restoreWork;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.tail.catch(() => {}).then(operation);
    this.tail = work;
    return work;
  }
  private requestKey(input: Record<string, unknown>, operation: string) {
    if (
      typeof input.requestId !== "string" ||
      !/^[\w-]{8,128}$/.test(input.requestId)
    )
      throw new TelegramSetupError(
        "Informe um requestId válido para esta operação",
      );
    return `telegram:setup:${operation}:${input.requestId}`;
  }
  connect(input: Record<string, unknown>) {
    const key = this.requestKey(input, "connect");
    const fingerprint = hash(
      JSON.stringify([
        input.token ?? "",
        input.userId,
        input.conversationId,
        input.replaceWebhook === true,
        input.expectedWebhook ?? null,
        input.expectedBotId ?? null,
      ]),
    );
    return this.serialize(async () => {
      if (this.closing)
        throw new TelegramSetupError("A aplicação está encerrando");
      const prior = this.meta<Receipt>(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new TelegramSetupError(
            "requestId já utilizado com outros dados",
          );
        if (prior.state !== "done") {
          this.state = "blocked";
          this.error =
            "Resultado da conexão anterior incerto. Consulte o estado do webhook antes de uma nova conexão explícita.";
        }
        return this.snapshot();
      }
      if (
        typeof input.userId !== "string" ||
        !/^[1-9]\d{0,15}$/.test(input.userId) ||
        !Number.isSafeInteger(Number(input.userId))
      )
        throw new TelegramSetupError(
          "Informe seu user ID numérico do Telegram",
        );
      if (
        typeof input.conversationId !== "string" ||
        !this.app.store.get(
          "SELECT id FROM conversations WHERE id=? AND id NOT IN (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL)",
          input.conversationId,
        )
      )
        throw new TelegramSetupError("Escolha uma conversa existente na web");
      if (input.token !== undefined && typeof input.token !== "string")
        throw new TelegramSetupError("Token Telegram inválido");
      let token = typeof input.token === "string" ? input.token.trim() : "";
      if (!token) {
        token = this.credential()?.token ?? "";
        if (!token) {
          try {
            token = this.options.legacy?.readToken?.()?.trim() ?? "";
          } catch {
            throw new TelegramSetupError(
              "Não foi possível ler o token legado. Informe o token no painel.",
            );
          }
        }
      }
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || token.length > 512)
        throw new TelegramSetupError("Informe um token de bot Telegram válido");
      await this.stop();
      if (this.config) {
        this.config.enabled = false;
        this.save(configKey, this.config);
      }
      this.candidate = undefined;
      this.state = "connecting";
      this.error = null;
      this.webhookUrl = null;
      this.webhookVersion = null;
      this.save(key, { fingerprint, state: "pending" });
      let deleting = false;
      try {
        const api = this.api(token);
        const bot = this.parseBot(
          await api.call("getMe", {}, this.lifetime.signal),
        );
        if (this.config && this.config.bot.id !== bot.id)
          throw new TelegramSetupError(
            "Este volume já pertence a outro bot. Use o token do mesmo bot para preservar os vínculos e evitar colisões de mensagens.",
          );
        this.candidate = {
          bot,
          userId: input.userId,
          conversationId: input.conversationId,
        };
        const webhook = this.parseWebhook(
          await api.call("getWebhookInfo", {}, this.lifetime.signal),
        );
        if (webhook) {
          this.showWebhook(webhook);
          if (
            input.replaceWebhook !== true ||
            input.expectedBotId !== bot.id ||
            input.expectedWebhook !== hash(webhook)
          ) {
            this.save(key, { fingerprint, state: "done" });
            return this.snapshot();
          }
          // Persisted pending receipt precedes delete. An unknown delete is never retried.
          deleting = true;
          const removed = await api.call(
            "deleteWebhook",
            { drop_pending_updates: false },
            this.lifetime.signal,
          );
          if (removed !== true) throw new TelegramApiError("unavailable");
          deleting = false;
          const remaining = this.parseWebhook(
            await api.call("getWebhookInfo", {}, this.lifetime.signal),
          );
          if (remaining) {
            this.showWebhook(remaining);
            this.save(key, { fingerprint, state: "done" });
            return this.snapshot();
          }
        }
        this.app.assertConversationAvailable(input.conversationId);
        this.config = { ...this.candidate, enabled: true, chatId: null };
        this.app.store.db.exec("BEGIN IMMEDIATE");
        try {
          this.app.store.run(
            "INSERT INTO credentials VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
            credentialKey,
            JSON.stringify({ token, botId: bot.id }),
          );
          this.save(configKey, this.config);
          this.app.store.run(
            "DELETE FROM telegram_initial_revocations WHERE conversationId=?",
            input.conversationId,
          );
          this.save(key, { fingerprint, state: "done" });
          this.app.store.db.exec("COMMIT");
        } catch (error) {
          this.app.store.db.exec("ROLLBACK");
          throw error;
        }
        this.candidate = undefined;
        this.webhookUrl = null;
        this.webhookVersion = null;
        this.commandMenu.newConnection();
        await this.start(token);
      } catch (error) {
        this.config = this.meta<Config>(configKey);
        this.state = "blocked";
        this.error = deleting
          ? "Troca do webhook com resultado incerto. Confira o estado antes de tentar novamente; a troca não será repetida automaticamente."
          : error instanceof TelegramSetupError ||
              error instanceof TelegramApiError
            ? error.message
            : "Não foi possível persistir ou validar a conexão Telegram. Tente uma nova conexão explícita.";
        this.save(key, { fingerprint, state: deleting ? "uncertain" : "done" });
      }
      return this.snapshot();
    });
  }
  disconnect(input: Record<string, unknown>) {
    const key = this.requestKey(input, "disconnect");
    return this.serialize(async () => {
      if (this.closing)
        throw new TelegramSetupError("A aplicação está encerrando");
      if (this.meta<Receipt>(key)) return this.snapshot();
      await this.stop();
      if (this.config) {
        this.config.enabled = false;
        this.save(configKey, this.config);
      }
      this.candidate = undefined;
      this.state = this.config ? "disconnected" : "unconfigured";
      this.error = null;
      this.webhookUrl = null;
      this.webhookVersion = null;
      this.save(key, { fingerprint: hash("disconnect"), state: "done" });
      return this.snapshot();
    });
  }
  private api(token: string) {
    return this.options.apiFactory?.(token) ?? new TelegramBotApi(token);
  }
  private parseBot(value: unknown): Bot {
    if (!value || typeof value !== "object")
      throw new TelegramApiError("unavailable");
    const bot = value as {
      id?: number;
      is_bot?: boolean;
      username?: unknown;
      first_name?: unknown;
    };
    if (
      !Number.isSafeInteger(bot.id) ||
      Number(bot.id) <= 0 ||
      bot.is_bot !== true
    )
      throw new TelegramApiError("invalid_token");
    return {
      id: bot.id!,
      ...(typeof bot.username === "string" &&
      /^[a-zA-Z0-9_]{5,32}$/.test(bot.username)
        ? { username: bot.username }
        : {}),
      ...(typeof bot.first_name === "string"
        ? { firstName: bot.first_name.slice(0, 128) }
        : {}),
    };
  }
  private parseWebhook(value: unknown) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { url?: unknown }).url !== "string"
    )
      throw new TelegramApiError("unavailable");
    return (value as { url: string }).url;
  }
  private showWebhook(url: string) {
    this.state = "webhook_conflict";
    this.webhookVersion = hash(url);
    try {
      this.webhookUrl = new URL(url).origin;
    } catch {
      this.webhookUrl = "Webhook configurado";
    }
    this.error =
      "Este bot tem um webhook. Confirme a troca para receber mensagens por polling.";
  }
  private async start(token: string) {
    const controller = new AbortController();
    this.controller = controller;
    this.state = "connecting";
    let ready!: () => void;
    const readiness = new Promise<void>((resolve) => {
      ready = resolve;
    });
    this.polling = this.run(token, controller.signal, ready).finally(ready);
    await readiness;
  }
  private async run(token: string, signal: AbortSignal, ready: () => void) {
    const api = this.api(token);
    let failures = 0;
    while (!signal.aborted) {
      try {
        const config = this.config!;
        const bot = this.parseBot(await api.call("getMe", {}, signal));
        if (bot.id !== config.bot.id)
          throw new TelegramSetupError(
            "A identidade do bot mudou. Atualize o token do mesmo bot.",
          );
        const webhook = this.parseWebhook(
          await api.call("getWebhookInfo", {}, signal),
        );
        if (webhook) {
          this.showWebhook(webhook);
          return;
        }
        const engine = new Telegram(
          this.app,
          {
            settleTopicCreates: () => this.topics.settle(),
            editTopicName: (chat, thread, name) =>
              api.call(
                "editForumTopic",
                { chat_id: chat, message_thread_id: thread, name },
                signal,
              ),
            answerCallback: (id, text) =>
              api.call(
                "answerCallbackQuery",
                { callback_query_id: id, text },
                signal,
              ),
            editMessage: (chat, messageId, text, markup) =>
              api.call(
                "editMessageText",
                {
                  chat_id: chat,
                  message_id: messageId,
                  text,
                  reply_markup: markup,
                },
                signal,
              ),
            typing: (chat, options) =>
              api.call(
                "sendChatAction",
                {
                  chat_id: chat,
                  action: "typing",
                  ...(options?.messageThreadId === undefined
                    ? {}
                    : { message_thread_id: options.messageThreadId }),
                },
                AbortSignal.any([
                  signal,
                  ...(options?.signal ? [options.signal] : []),
                ]),
              ),
            send: (chat, text, options) =>
              api
                .call(
                  "sendMessage",
                  {
                    chat_id: chat,
                    text,
                    ...(options?.forceReply
                      ? { reply_markup: { force_reply: true, selective: true } }
                      : {}),
                    ...(options?.replyMarkup
                      ? { reply_markup: options.replyMarkup }
                      : {}),
                    ...(options?.parseMode
                      ? { parse_mode: options.parseMode }
                      : {}),
                    ...(options?.messageThreadId === undefined
                      ? {}
                      : { message_thread_id: options.messageThreadId }),
                  },
                  signal,
                )
                .catch((error: unknown) => {
                  if (
                    error instanceof TelegramApiError &&
                    error.refusedCode !== undefined
                  )
                    throw new TelegramSendRefused(
                      error.refusedCode,
                      error.retryAfter,
                    );
                  throw error;
                }),
          },
          [config.userId],
          config.chatId ? [config.chatId] : [],
          bot.username,
          true,
          bot.id,
        );
        this.engine = engine;
        this.flushTimer = setInterval(() => {
          void engine.flush().catch(() => {
            this.state = "retrying";
            this.error = "Falha ao persistir a fila de entrega Telegram.";
          });
        }, 1000);
        this.flushTimer.unref();
        let first = true;
        while (!signal.aborted) {
          const offset = this.meta<number>(`telegram:offset:${bot.id}`);
          const updates = await api.call(
            "getUpdates",
            {
              ...(offset === undefined ? {} : { offset }),
              limit: 100,
              timeout: first ? 0 : 25,
              allowed_updates: ["message", "callback_query"],
            },
            signal,
          );
          if (!Array.isArray(updates))
            throw new TelegramApiError("unavailable");
          // A successful real getUpdates is the readiness boundary.
          this.lastSuccessAt = Date.now();
          this.state = "connected";
          this.error = null;
          ready();
          first = false;
          for (const value of updates) {
            signal.throwIfAborted();
            await this.consume(value, engine, signal);
          }
          await this.commandMenu.sync(
            api,
            {
              botId: bot.id,
              chatId: this.config!.chatId,
              languageCode: this.config!.languageCode,
            },
            signal,
          );
          await engine.flush();
          failures = 0;
          // Avoid a tight loop if a server/proxy returns empty long polls immediately.
          if (!updates.length) await pause(100, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        // Retire the old engine before retry backoff so its ephemeral status
        // cannot continue while the connection is unavailable.
        await this.engine?.drain();
        if (
          error instanceof TelegramSetupError ||
          (error instanceof TelegramApiError &&
            ["invalid_token", "conflict"].includes(error.kind))
        ) {
          this.state = "blocked";
          this.error = error.message;
          ready();
          return;
        }
        this.state = "retrying";
        this.error =
          error instanceof TelegramApiError
            ? error.message
            : "Não foi possível persistir as mensagens. O offset foi preservado para retomar com segurança.";
        ready();
        const delay =
          error instanceof TelegramApiError && error.kind === "rate_limit"
            ? Math.min(3600, Math.max(1, error.retryAfter)) * 1000
            : Math.min(
                30000,
                (this.options.retryBaseMs ?? 1000) *
                  2 ** Math.min(failures++, 5),
              );
        await pause(delay, signal);
      } finally {
        if (this.flushTimer) {
          clearInterval(this.flushTimer);
          this.flushTimer = undefined;
        }
        await this.engine?.drain();
        this.engine = undefined;
      }
    }
  }
  private async consume(value: unknown, engine: Telegram, signal: AbortSignal) {
    if (
      !value ||
      typeof value !== "object" ||
      !Number.isSafeInteger((value as TelegramUpdate).update_id) ||
      (value as TelegramUpdate).update_id < 0
    )
      throw new TelegramApiError("unavailable");
    const update = value as TelegramUpdate;
    const config = this.config!;
    const fingerprint = hash(JSON.stringify(value));
    const prior = this.app.store.get<{ fingerprint: string }>(
      "SELECT fingerprint FROM telegram_poll_receipts WHERE botId=? AND id=?",
      config.bot.id,
      update.update_id,
    );
    if (prior && prior.fingerprint !== fingerprint)
      throw new TelegramSetupError(
        "Telegram reutilizou um update_id com outro conteúdo. Conexão pausada para verificação.",
      );
    if (prior) return;
    const offset = this.meta<number>(`telegram:offset:${config.bot.id}`);
    if (offset !== undefined && update.update_id < offset) return;
    if (update.callback_query) {
      if (
        config.chatId &&
        String(update.callback_query.message?.chat?.id) === config.chatId &&
        String(update.callback_query.from?.id) === config.userId
      )
        await engine.receive(update, signal);
      this.app.store.savepoint("telegram_callback_poll", () => {
        this.app.store.run(
          "INSERT INTO telegram_poll_receipts VALUES (?,?,?,?)",
          config.bot.id,
          update.update_id,
          fingerprint,
          "accepted",
        );
        this.save(`telegram:offset:${config.bot.id}`, update.update_id + 1);
      });
      return;
    }
    const message = update.message;
    const initialRevoked = !!this.app.store.get(
      "SELECT 1 FROM telegram_initial_revocations WHERE conversationId=?",
      config.conversationId,
    );
    const activeMapping =
      config.chatId &&
      this.app.store.get(
        "SELECT 1 FROM telegram WHERE chat=? AND user=? AND conversationId NOT IN (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL)",
        config.chatId,
        config.userId,
      );
    let state = "ignored";
    let rejection =
      "Comando Telegram inválido ou não autorizado. Use /help para consultar os comandos.";
    if (
      message?.chat?.type === "private" &&
      message.from &&
      !message.from.is_bot &&
      String(message.from.id) === config.userId &&
      ((typeof message.text === "string" && message.text.trim()) ||
        message.forum_topic_created ||
        message.forum_topic_edited ||
        message.forum_topic_closed ||
        message.forum_topic_reopened) &&
      Number.isSafeInteger(message.chat.id) &&
      message.chat.id > 0 &&
      (message.message_thread_id === undefined ||
        (Number.isSafeInteger(message.message_thread_id) &&
          message.message_thread_id > 0)) &&
      !(message.is_topic_message && message.message_thread_id === undefined) &&
      // The configured private owner may receive control guidance after a
      // revoked history binding. The engine still authorizes every history
      // admission and outbox send; this never regrants an old conversation.
      (!initialRevoked || activeMapping || config.chatId)
    ) {
      const chat = String(message.chat.id);
      const languageCode = /^([a-z]{2})(?:[-_]|$)/i
        .exec(message.from.language_code ?? "")?.[1]
        ?.toLowerCase();
      if (!config.chatId) {
        const bound = {
          ...config,
          chatId: chat,
          ...(languageCode ? { languageCode } : {}),
        };
        this.app.store.db.exec("BEGIN IMMEDIATE");
        try {
          this.app.store.run(
            "INSERT INTO telegram VALUES (?,?,?) ON CONFLICT(chat) DO UPDATE SET conversationId=excluded.conversationId,user=excluded.user",
            chat,
            config.conversationId,
            config.userId,
          );
          this.app.store.run(
            "INSERT OR IGNORE INTO telegram_grants VALUES (?,?,?)",
            chat,
            config.userId,
            config.conversationId,
          );
          this.save(configKey, bound);
          this.app.store.db.exec("COMMIT");
          this.config = bound;
          engine.setDmChat(chat);
        } catch (error) {
          this.app.store.db.exec("ROLLBACK");
          throw error;
        }
      }
      if (
        this.config!.chatId === chat &&
        languageCode &&
        languageCode !== this.config!.languageCode
      ) {
        this.config = { ...this.config!, languageCode };
        this.save(configKey, this.config);
      }
      if (this.config!.chatId === chat) {
        try {
          const result = await engine.receive(update, signal);
          if (
            result &&
            typeof result === "object" &&
            "processing" in result &&
            result.processing
          )
            throw new Error("Aprovação ainda em processamento");
          state = "accepted";
        } catch (error) {
          // A CUA hold lasts until the operator returns control on the web, so
          // retrying the update would stall every later update behind it.
          if (error instanceof ConversationHeldError) rejection = error.message;
          else if (!(
            error instanceof TelegramInputError || error instanceof CommandError
          ))
            throw error;
          state = "rejected";
        }
      }
    }
    this.app.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (state === "rejected")
        this.app.store.run(
          "INSERT OR IGNORE INTO deliveries(id,chat,text,messageThreadId) VALUES (?,?,?,?)",
          `telegram:rejected:${update.update_id}`,
          String(message!.chat.id),
          rejection,
          Number.isSafeInteger(message?.message_thread_id) &&
            message!.message_thread_id! > 0
            ? message!.message_thread_id!
            : null,
        );
      this.app.store.run(
        "INSERT INTO telegram_poll_receipts VALUES (?,?,?,?)",
        config.bot.id,
        update.update_id,
        fingerprint,
        state,
      );
      this.save(`telegram:offset:${config.bot.id}`, update.update_id + 1);
      this.app.store.db.exec("COMMIT");
    } catch (error) {
      this.app.store.db.exec("ROLLBACK");
      throw error;
    }
  }
  private async stop() {
    this.controller?.abort();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.polling;
    this.polling = undefined;
    this.controller = undefined;
    await this.engine?.drain();
    this.engine = undefined;
  }
  async close() {
    this.closing = true;
    this.lifetime.abort();
    this.controller?.abort();
    await this.tail.catch(() => {});
    await this.stop();
    await Promise.allSettled(this.topicRenames.values());
  }
}
