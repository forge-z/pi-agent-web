import { ConversationBusyError, type Runtime } from "./runtime.js";
import { TelegramApiError } from "./telegram-connection.js";
import type { Store } from "./store.js";
import type { TelegramOwner } from "./telegram-chats.js";

export interface TelegramTopicRoute extends TelegramOwner {
  botId: number;
  credentialBinding: string;
}
export interface TelegramTopicMirrorResult {
  state:
    | "pending"
    | "created"
    | "existing"
    | "unavailable"
    | "uncertain"
    | "cancelled"
    | "failed";
  messageThreadId?: number;
  reason?: string;
  canComplete?: boolean;
}
export interface TelegramTopicMirrorOptions {
  ready?: boolean;
  explicitCompletion?: boolean;
}
interface TopicReceipt {
  state: "pending" | "uncertain" | "created" | "cancelled" | "failed";
  route: TelegramTopicRoute;
  authorityId: string;
  authorizationVersion?: string;
  targetAuthorizationVersion?: string;
  requestedName: string;
  messageThreadId?: number;
  retryAt?: number;
}
export type CreateTelegramTopic = (
  chat: string,
  name: string,
) => Promise<unknown>;

export function installTopicReceiptInvalidation(store: Store) {
  // Revocation while the API is in flight stays terminal even after a later regrant.
  store.db.exec(`
      DROP TRIGGER IF EXISTS telegram_topic_create_revoke;
      CREATE TRIGGER telegram_topic_create_revoke AFTER DELETE ON telegram_grants BEGIN
        UPDATE meta SET value=json_set(value,'$.state','cancelled')
        WHERE (key GLOB 'telegram:topic-create:*' OR key GLOB 'telegram:native-topic-create:*') AND json_valid(value)
        AND json_extract(value,'$.route.chat')=OLD.chat AND json_extract(value,'$.route.user')=OLD.user
        AND ((json_extract(value,'$.state') IN ('pending','uncertain') AND json_extract(value,'$.authorityId')=OLD.conversationId)
          OR substr(key,length('telegram:topic-create:')+1)=OLD.conversationId OR json_extract(value,'$.conversationId')=OLD.conversationId);
      END;
      DROP TRIGGER IF EXISTS telegram_topic_create_grant_update;
      CREATE TRIGGER telegram_topic_create_grant_update AFTER UPDATE ON telegram_grants
      WHEN OLD.chat IS NOT NEW.chat OR OLD.user IS NOT NEW.user OR OLD.conversationId IS NOT NEW.conversationId BEGIN
        UPDATE meta SET value=json_set(value,'$.state','cancelled')
        WHERE (key GLOB 'telegram:topic-create:*' OR key GLOB 'telegram:native-topic-create:*') AND json_valid(value)
        AND json_extract(value,'$.route.chat')=OLD.chat AND json_extract(value,'$.route.user')=OLD.user
        AND ((json_extract(value,'$.state') IN ('pending','uncertain') AND json_extract(value,'$.authorityId')=OLD.conversationId)
          OR substr(key,length('telegram:topic-create:')+1)=OLD.conversationId OR json_extract(value,'$.conversationId')=OLD.conversationId);
      END;
      DROP TRIGGER IF EXISTS telegram_topic_create_config_update;
      CREATE TRIGGER telegram_topic_create_config_update AFTER UPDATE OF value ON meta
      WHEN NEW.key='telegram:connection' AND OLD.value IS NOT NEW.value BEGIN
        UPDATE meta SET value=json_set(value,'$.state','cancelled')
        WHERE (key GLOB 'telegram:topic-create:*' OR key GLOB 'telegram:native-topic-create:*') AND json_valid(value) AND json_extract(value,'$.state') IN ('pending','uncertain')
        AND CASE WHEN json_valid(NEW.value) THEN json_extract(NEW.value,'$.enabled') IS NOT 1
          OR json_extract(NEW.value,'$.bot.id') IS NOT json_extract(value,'$.route.botId')
          OR json_extract(NEW.value,'$.chatId') IS NOT json_extract(value,'$.route.chat')
          OR json_extract(NEW.value,'$.userId') IS NOT json_extract(value,'$.route.user') ELSE 1 END;
      END;
      DROP TRIGGER IF EXISTS telegram_topic_create_config_delete;
      CREATE TRIGGER telegram_topic_create_config_delete AFTER DELETE ON meta
      WHEN OLD.key='telegram:connection' BEGIN
        UPDATE meta SET value=json_set(value,'$.state','cancelled')
        WHERE (key GLOB 'telegram:topic-create:*' OR key GLOB 'telegram:native-topic-create:*') AND json_valid(value) AND json_extract(value,'$.state') IN ('pending','uncertain');
      END;
      DROP TRIGGER IF EXISTS telegram_topic_create_credential_update;
      CREATE TRIGGER telegram_topic_create_credential_update AFTER UPDATE OF value ON credentials
      WHEN OLD.provider='telegram:bot' AND OLD.value IS NOT NEW.value BEGIN
        UPDATE meta SET value=json_set(value,'$.state','cancelled')
        WHERE (key GLOB 'telegram:topic-create:*' OR key GLOB 'telegram:native-topic-create:*') AND json_valid(value) AND json_extract(value,'$.state') IN ('pending','uncertain');
      END;
      DROP TRIGGER IF EXISTS telegram_topic_create_credential_delete;
      CREATE TRIGGER telegram_topic_create_credential_delete AFTER DELETE ON credentials
      WHEN OLD.provider='telegram:bot' BEGIN
        UPDATE meta SET value=json_set(value,'$.state','cancelled')
        WHERE (key GLOB 'telegram:topic-create:*' OR key GLOB 'telegram:native-topic-create:*') AND json_valid(value) AND json_extract(value,'$.state') IN ('pending','uncertain');
      END;
    `);
}

/** Never repeats an external create whose outcome cannot be proven. */
export class TelegramTopics {
  private creating = new Map<string, Promise<TelegramTopicMirrorResult>>();
  constructor(private app: Runtime) {
    installTopicReceiptInvalidation(app.store);
  }
  async settle() {
    await Promise.allSettled(this.creating.values());
  }
  mirror(
    id: string,
    create: CreateTelegramTopic,
    currentRoute: () => TelegramTopicRoute | undefined,
    options: TelegramTopicMirrorOptions = {},
  ) {
    const running = this.creating.get(id);
    if (running) return running;
    const work = this.create(id, create, currentRoute, options);
    this.creating.set(id, work);
    void work.finally(() => this.creating.delete(id)).catch(() => {});
    return work;
  }
  private async create(
    id: string,
    create: CreateTelegramTopic,
    currentRoute: () => TelegramTopicRoute | undefined,
    options: TelegramTopicMirrorOptions,
  ): Promise<TelegramTopicMirrorResult> {
    const store = this.app.store;
    const key = `telegram:topic-create:${id}`;
    const saved = store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      key,
    );
    const terminal = (
      state: "uncertain" | "cancelled" | "failed",
    ): TelegramTopicMirrorResult => ({
      state,
      canComplete: false,
      reason:
        state === "uncertain"
          ? "A criação do tópico teve resultado incerto. Verifique no Telegram; ela não será repetida."
          : state === "cancelled"
            ? "A autorização deste tópico foi revogada. Nenhum vínculo será reativado."
            : "A criação do tópico não foi concluída.",
    });
    const unavailable = (): TelegramTopicMirrorResult => ({
      state: "unavailable",
      canComplete: false,
      reason:
        "Nenhum destino Telegram autorizado está disponível para esta conversa.",
    });
    const pending = (): TelegramTopicMirrorResult => ({
      state: "pending",
      canComplete: true,
      reason: !ready
        ? "Telegram está reconectando. Conclua o tópico explicitamente quando a conexão estiver pronta."
        : "A conversa aguarda a conclusão explícita do tópico Telegram.",
    });
    const previous = saved
      ? (JSON.parse(saved.value) as TopicReceipt)
      : undefined;
    if (
      previous &&
      ["uncertain", "cancelled", "failed"].includes(previous.state)
    )
      return terminal(previous.state as "uncertain" | "cancelled" | "failed");
    if (
      previous?.state === "pending" &&
      previous.retryAt &&
      previous.retryAt > Date.now()
    )
      return {
        state: "pending",
        canComplete: true,
        reason:
          "Telegram recusou a criação por limite de requisições. Aguarde antes de concluir o tópico.",
      };
    const availableRoute = currentRoute();
    const ready = options.ready !== false && !!availableRoute;
    const configured = this.app.telegramChats.configuredOwner();
    const route =
      availableRoute ??
      (previous?.state === "pending" ? configured : undefined);
    if (!route) {
      if (previous?.state === "pending") {
        store.run(
          "UPDATE meta SET value=json_set(value,'$.state','cancelled') WHERE key=? AND value=?",
          key,
          saved!.value,
        );
        return terminal("cancelled");
      }
      return { state: "unavailable", canComplete: false };
    }
    if (!configured || JSON.stringify(configured) !== JSON.stringify(route))
      return unavailable();
    if (previous?.state === "created") {
      const owner = {
        ...previous.route,
        messageThreadId: previous.messageThreadId,
      };
      try {
        if (JSON.stringify(previous.route) !== JSON.stringify(route))
          return terminal("cancelled");
        this.app.telegramChats.authorize(id, owner);
        return {
          state: "existing",
          messageThreadId: previous.messageThreadId,
          canComplete: false,
        };
      } catch {
        return terminal("cancelled");
      }
    }
    if (this.app.telegramChats.dedicated(id)) {
      const topic = store.get<{ messageThreadId: number }>(
        "SELECT messageThreadId FROM telegram_topic_conversations WHERE conversationId=?",
        id,
      );
      try {
        this.app.telegramChats.authorize(id, {
          ...route,
          messageThreadId: topic?.messageThreadId,
        });
        return {
          state: "existing",
          ...(topic ? { messageThreadId: topic.messageThreadId } : {}),
          canComplete: false,
        };
      } catch {
        return terminal("cancelled");
      }
    }
    let authorityId: string;
    let title: string;
    let authorizationVersion: string;
    let targetAuthorizationVersion: string;
    const targetRevoked = () =>
      !!store.get(
        `SELECT 1 FROM telegram_grant_versions WHERE conversationId=? AND NOT EXISTS
       (SELECT 1 FROM telegram_grants WHERE chat=? AND user=? AND conversationId=?) LIMIT 1`,
        id,
        route.chat,
        route.user,
        id,
      );
    try {
      this.app.assertConversationAvailable(id);
      if (
        store.get(
          "SELECT 1 FROM telegram_initial_revocations WHERE conversationId=?",
          id,
        ) ||
        targetRevoked()
      ) {
        if (previous?.state === "pending")
          store.run(
            "UPDATE meta SET value=json_set(value,'$.state','cancelled') WHERE key=? AND value=?",
            key,
            saved!.value,
          );
        return terminal("cancelled");
      }
      targetAuthorizationVersion = store.authorizationVersion(route, id);
      if (previous?.state === "pending") {
        authorityId = previous.authorityId;
        this.app.telegramChats.assertCreationAuthority(
          authorityId,
          previous.route,
        );
        authorizationVersion = store.authorizationVersion(
          previous.route,
          authorityId,
        );
        if (
          JSON.stringify(previous.route) !== JSON.stringify(route) ||
          previous.authorizationVersion !== authorizationVersion ||
          previous.targetAuthorizationVersion !== targetAuthorizationVersion
        ) {
          store.run(
            "UPDATE meta SET value=json_set(value,'$.state','cancelled') WHERE key=? AND value=?",
            key,
            saved!.value,
          );
          return terminal("cancelled");
        }
      } else {
        authorityId = this.app.telegramChats.creationAuthority(route);
        authorizationVersion = store.authorizationVersion(route, authorityId);
      }
      // A pending intent has never applied externally; use the latest human title.
      const conversation = store.get<{ title: string }>(
        "SELECT title FROM conversations WHERE id=?",
        id,
      );
      if (!conversation) return terminal("cancelled");
      title =
        Array.from(conversation.title).slice(0, 128).join("") ||
        "Nova conversa";
    } catch (error) {
      if (
        previous?.state === "pending" &&
        error instanceof ConversationBusyError &&
        JSON.stringify(previous.route) === JSON.stringify(route) &&
        store.authorizationVersion(route, previous.authorityId) ===
          previous.authorizationVersion &&
        store.authorizationVersion(route, id) ===
          previous.targetAuthorizationVersion &&
        store.get(
          "SELECT 1 FROM telegram_grants WHERE chat=? AND user=? AND conversationId=?",
          route.chat,
          route.user,
          previous.authorityId,
        ) &&
        !targetRevoked() &&
        !store.get(
          "SELECT 1 FROM telegram_initial_revocations WHERE conversationId=?",
          id,
        ) &&
        store.get<{ value: string }>("SELECT value FROM meta WHERE key=?", key)
          ?.value === saved!.value
      )
        return {
          ...pending(),
          reason:
            "A conversa está sendo atualizada. Conclua o tópico explicitamente quando ela estiver disponível.",
        };
      if (previous?.state === "pending") {
        store.run(
          "UPDATE meta SET value=json_set(value,'$.state','cancelled') WHERE key=? AND value=?",
          key,
          saved!.value,
        );
        return terminal("cancelled");
      }
      return unavailable();
    }
    if (
      previous?.state === "pending" &&
      (!options.explicitCompletion || !ready)
    )
      return pending();
    const receipt: TopicReceipt = {
      state: !ready ? "pending" : "uncertain",
      route,
      authorityId,
      authorizationVersion,
      targetAuthorizationVersion,
      requestedName: title,
    };
    // Pending has never called Telegram; uncertainty is committed before its first external call.
    const claimed =
      previous?.state === "pending"
        ? store.run(
            "UPDATE meta SET value=? WHERE key=? AND value=?",
            JSON.stringify(receipt),
            key,
            saved!.value,
          ).changes
        : store.run(
            "INSERT OR IGNORE INTO meta VALUES (?,?)",
            key,
            JSON.stringify(receipt),
          ).changes;
    if (!claimed) return terminal("uncertain");
    if (receipt.state === "pending") return pending();
    let result: unknown;
    try {
      result = await create(route.chat, title);
    } catch (error) {
      if (error instanceof TelegramApiError && error.refusedCode) {
        const retry = error.refusedCode === 429;
        store.run(
          "UPDATE meta SET value=? WHERE key=? AND value=?",
          JSON.stringify({
            ...receipt,
            state: retry ? "pending" : "failed",
            ...(retry
              ? { retryAt: Date.now() + Math.max(1, error.retryAfter) * 1000 }
              : {}),
          }),
          key,
          JSON.stringify(receipt),
        );
      }
      const final = store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        key,
      );
      const state = final && (JSON.parse(final.value) as TopicReceipt).state;
      return state === "pending"
        ? pending()
        : terminal(
            state === "cancelled" || state === "failed" ? state : "uncertain",
          );
    }
    const thread =
      result && typeof result === "object"
        ? (result as { message_thread_id?: number }).message_thread_id
        : undefined;
    if (!Number.isSafeInteger(thread) || thread! <= 0)
      return terminal("uncertain");
    return store.savepoint("telegram_topic_create_result", () => {
      const cancel = (): TelegramTopicMirrorResult => {
        store.run(
          "UPDATE meta SET value=? WHERE key=? AND value=?",
          JSON.stringify({
            ...receipt,
            state: "cancelled",
            messageThreadId: thread,
          }),
          key,
          JSON.stringify(receipt),
        );
        store.run(
          "UPDATE meta SET value=json_set(value,'$.messageThreadId',?) WHERE key=? AND json_valid(value) AND json_extract(value,'$.state')='cancelled'",
          thread!,
          key,
        );
        return terminal("cancelled");
      };
      const current = currentRoute();
      if (!current || JSON.stringify(current) !== JSON.stringify(route))
        return cancel();
      try {
        this.app.telegramChats.assertCreationAuthority(authorityId, route);
        if (
          store.authorizationVersion(route, authorityId) !==
            authorizationVersion ||
          store.authorizationVersion(route, id) !==
            targetAuthorizationVersion ||
          targetRevoked()
        )
          return cancel();
        this.app.assertConversationAvailable(id);
      } catch {
        return cancel();
      }
      if (
        this.app.telegramChats.dedicated(id) ||
        store.get(
          "SELECT 1 FROM telegram_initial_revocations WHERE conversationId=?",
          id,
        )
      )
        return cancel();
      if (
        !store.run(
          "UPDATE meta SET value=? WHERE key=? AND value=?",
          JSON.stringify({
            ...receipt,
            state: "created",
            messageThreadId: thread,
          }),
          key,
          JSON.stringify(receipt),
        ).changes
      )
        return cancel();
      store.run(
        "INSERT INTO telegram_conversations VALUES (?,?,?)",
        id,
        route.chat,
        route.user,
      );
      store.run(
        "INSERT INTO telegram_topic_conversations VALUES (?,?)",
        id,
        thread!,
      );
      store.run(
        "INSERT OR IGNORE INTO telegram_grants VALUES (?,?,?)",
        route.chat,
        route.user,
        id,
      );
      store.run(
        "INSERT INTO telegram_topic_selection VALUES (?,?,?,?) ON CONFLICT(chat,user,messageThreadId) DO NOTHING",
        route.chat,
        route.user,
        thread!,
        id,
      );
      store.run(
        "INSERT INTO telegram_known_topics(chat,user,messageThreadId,name,closed) VALUES (?,?,?,?,0) ON CONFLICT(chat,user,messageThreadId) DO NOTHING",
        route.chat,
        route.user,
        thread!,
        title,
      );
      return { state: "created", messageThreadId: thread, canComplete: false };
    });
  }
}
