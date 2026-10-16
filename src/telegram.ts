import {
  credentialBinding,
  cuaWebLink,
  observeTopic,
  syncTopicTitle,
  queueControl,
  queueCuaControl,
  queueTopicsControl,
  type TelegramButton,
  type TelegramReplyMarkup,
} from "./telegram-controls.js";
import {
  TelegramTyping,
  type TelegramTypingOptions,
} from "./telegram-typing.js";
import {
  ConversationBusyError,
  ConversationError,
  type Runtime,
} from "./runtime.js";
import { childIds, hash, type Delivery } from "./store.js";
import { CommandError } from "./commands.js";
import { SettingsError } from "./settings.js";
import { TaskError } from "./tasks.js";
import {
  openCronMenu,
  handleCronMenu,
  acceptCronReply,
  cronReplyReceipt,
  assertCronDelivery,
} from "./telegram-crons.js";
import { openModelMenu, handleModelMenu } from "./telegram-models.js";
import { taskTelegramAuthorized } from "./task-telegram.js";
import {
  TELEGRAM_RELINK_GUIDANCE,
  TELEGRAM_SELECTION_GUIDANCE,
  type TelegramOwner,
} from "./telegram-chats.js";
interface ControlRoute extends TelegramOwner {
  botId: number;
  credentialBinding: string;
}
type TopicTitleReceipt =
  | {
      route: ControlRoute;
      name: string;
      state: "pending" | "done" | "cancelled" | "uncertain";
    }
  | { state: "cancelled" };
function unavailableConversation(error: unknown) {
  // Settings/deletion inspections are temporary; storage failures must retry too.
  return (
    error instanceof CommandError ||
    (error instanceof ConversationError &&
      !(error instanceof ConversationBusyError))
  );
}
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date?: number;
    message_thread_id?: number;
    reply_to_message?: { message_id: number; from?: { id: number } };
    is_topic_message?: boolean;
    forum_topic_created?: { name: string; is_name_implicit?: boolean };
    forum_topic_edited?: { name?: string };
    forum_topic_closed?: object;
    forum_topic_reopened?: object;
    text?: string;
    from?: { id: number; is_bot?: boolean; language_code?: string };
    chat: { id: number; type: string };
  };
  callback_query?: {
    id: string;
    from: { id: number; is_bot?: boolean };
    data?: string;
    message?: {
      message_id: number;
      date?: number;
      from?: { id: number };
      chat: { id: number; type: string };
      message_thread_id?: number;
    };
  };
}
export interface TelegramTransport {
  settleTopicCreates?(): Promise<void>;
  editTopicName?(chat: string, thread: number, name: string): Promise<unknown>;
  answerCallback?(id: string, text: string): Promise<unknown>;
  editMessage?(
    chat: string,
    messageId: number,
    text: string,
    markup: TelegramReplyMarkup,
  ): Promise<unknown>;
  typing?(chat: string, options?: TelegramTypingOptions): Promise<unknown>;
  send(
    chat: string,
    text: string,
    options?: {
      parseMode?: "HTML";
      messageThreadId?: number;
      replyMarkup?: TelegramReplyMarkup;
      forceReply?: boolean;
    },
  ): Promise<unknown>;
}
export class TelegramInputError extends Error {}
export class TelegramHttp implements TelegramTransport {
  constructor(private token: string) {}
  async editMessage(
    chat: string,
    messageId: number,
    text: string,
    markup: TelegramReplyMarkup,
  ) {
    const response = await fetch(
      `https://api.telegram.org/bot${this.token}/editMessageText`,
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          message_id: messageId,
          text,
          reply_markup: markup,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const result = (await response.json()) as { ok?: boolean };
    if (!response.ok || result.ok !== true)
      throw new Error("Falha ao atualizar menu Telegram");
    return result;
  }
  async answerCallback(id: string, text: string) {
    const response = await fetch(
      `https://api.telegram.org/bot${this.token}/answerCallbackQuery`,
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callback_query_id: id, text }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const result = (await response.json()) as { ok?: boolean };
    if (!response.ok || result.ok !== true)
      throw new Error("Falha ao responder controle Telegram");
    return result;
  }
  async typing(chat: string, options: TelegramTypingOptions = {}) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/sendChatAction`,
        {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chat,
            action: "typing",
            ...(options.messageThreadId === undefined
              ? {}
              : { message_thread_id: options.messageThreadId }),
          }),
          signal: AbortSignal.any([
            AbortSignal.timeout(2000),
            ...(options.signal ? [options.signal] : []),
          ]),
        },
      );
      const result = (await response.json()) as { ok?: boolean };
      if (!response.ok || result.ok !== true) throw new Error();
      return result;
    } catch {
      throw new Error("Falha no indicador Telegram");
    }
  }
  async send(
    chat: string,
    text: string,
    options?: {
      parseMode?: "HTML";
      messageThreadId?: number;
      replyMarkup?: TelegramReplyMarkup;
      forceReply?: boolean;
    },
  ) {
    const response = await fetch(
      `https://api.telegram.org/bot${this.token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text,
          ...(options?.forceReply
            ? { reply_markup: { force_reply: true, selective: true } }
            : {}),
          ...(options?.replyMarkup
            ? { reply_markup: options.replyMarkup }
            : {}),
          ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
          ...(options?.messageThreadId === undefined
            ? {}
            : { message_thread_id: options.messageThreadId }),
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const result = (await response.json()) as { ok?: boolean };
    if (!response.ok || !result.ok)
      throw new Error("Falha na entrega Telegram");
    return result;
  }
}
/** Telegram answered and refused the message, so it was definitely not delivered. */
export class TelegramSendRefused extends Error {
  constructor(
    readonly code: number,
    readonly retryAfter = 0,
  ) {
    super(`Telegram recusou o envio (código ${code}).`);
  }
}
export class Telegram {
  private closing = false;
  private sendAfter = 0;
  private typing: TelegramTyping;
  private flushWork: Promise<void> | undefined;
  private receives = new Map<number, Promise<unknown>>();
  private credentialBinding: string;
  constructor(
    private app: Runtime,
    private transport: TelegramTransport,
    private users: string[],
    private chats: string[],
    readonly botUsername?: string,
    private privateDm = false,
    private botId?: number,
  ) {
    this.typing = new TelegramTyping(transport.typing?.bind(transport));
    const credential = this.app.store.get<{ value: string }>(
      "SELECT value FROM credentials WHERE provider='telegram:bot'",
    );
    this.credentialBinding = hash(credential?.value ?? "");
    this.botUsername = botUsername?.trim().replace(/^@/, "") || undefined;
    if (this.botUsername && !/^[a-zA-Z0-9_]{5,32}$/.test(this.botUsername))
      throw new Error("TELEGRAM_BOT_USERNAME deve ser o username do bot");
  }
  private commandText(raw: string) {
    const start = raw.trimStart();
    if (!start.startsWith("/") || start.startsWith("//")) return raw;
    const text = raw.trim();
    const addressed = /^\/[a-z]+@([a-z0-9_]+)(?=\s|$)/i.exec(text);
    if (!addressed) return this.newAlias(text);
    // Never execute a command intended for another bot or guess our identity.
    if (addressed[1].toLowerCase() !== this.botUsername?.toLowerCase())
      return undefined;
    return this.newAlias(text.replace(/^(\/[a-z]+)@[a-z0-9_]+/i, "$1"));
  }
  private newAlias(text: string) {
    const match = /^\/new(?:\s+([\s\S]*))?$/.exec(text);
    return match
      ? `/topics new${match[1]?.trim() ? ` ${match[1].trim()}` : ""}`
      : text;
  }
  private queueImplicitTopicTitle(
    update: TelegramUpdate,
    owner: TelegramOwner,
    eventBot: string,
  ) {
    const created = update.message?.forum_topic_created;
    if (
      !this.transport.editTopicName ||
      owner.messageThreadId === undefined ||
      created?.is_name_implicit !== true ||
      typeof created.name !== "string" ||
      created.name.length > 128 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(created.name) ||
      !/^\/new(?:@[a-zA-Z0-9_]+)?(?:\s|$)/.test(created.name.trim())
    )
      return;
    const command = this.commandText(created.name);
    const match = /^\/topics new(?:\s+([\s\S]*))?$/.exec(command ?? "");
    if (!match) return;
    // Quotes and punctuation belong to the supplied name, not to this parser.
    const name = match[1]?.trim() || "Conversa Telegram";
    if (name.length > 100) return;
    const route = this.controlRoute(owner);
    if (!route) return;
    this.app.store.run(
      "INSERT OR IGNORE INTO meta VALUES (?,?)",
      `telegram:topic-title:${eventBot}:${update.update_id}`,
      JSON.stringify({
        route,
        name,
        state: "pending",
      } satisfies TopicTitleReceipt),
    );
  }
  private async editImplicitTopicTitle(updateId: number, eventBot: string) {
    const key = `telegram:topic-title:${eventBot}:${updateId}`;
    const saved = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      key,
    );
    if (!saved || !this.transport.editTopicName) return;
    const receipt = JSON.parse(saved.value) as TopicTitleReceipt;
    if (receipt.state !== "pending") return;
    const save = (state: TopicTitleReceipt["state"]) =>
      this.app.store.run(
        "UPDATE meta SET value=? WHERE key=? AND value=?",
        JSON.stringify({ ...receipt, state }),
        key,
        state === "done"
          ? JSON.stringify({ ...receipt, state: "uncertain" })
          : saved.value,
      );
    const route = this.controlRoute(receipt.route);
    const topic = this.app.store.get<{
      closed: number | null;
      nameUpdateId: number;
      nameBotId: string;
    }>(
      "SELECT closed,nameUpdateId,nameBotId FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=?",
      receipt.route.chat,
      receipt.route.user,
      receipt.route.messageThreadId!,
    );
    if (
      this.closing ||
      !route ||
      JSON.stringify(route) !== JSON.stringify(receipt.route) ||
      !topic ||
      topic.closed === 1 ||
      topic.nameUpdateId !== updateId ||
      topic.nameBotId !== eventBot
    ) {
      save("cancelled");
      return;
    }
    try {
      const selected = this.app.telegramChats.selection(receipt.route);
      if (selected) this.app.telegramChats.authorize(selected, receipt.route);
      else this.app.telegramChats.creationAuthority(receipt.route);
    } catch (error) {
      if (!unavailableConversation(error)) throw error;
      save("cancelled");
      return;
    }
    // Commit uncertainty before an external mutation. Replays never repeat a
    // possibly applied title edit over a later name chosen by the user.
    if (!save("uncertain").changes) return;
    let result: unknown;
    try {
      result = await this.transport.editTopicName(
        receipt.route.chat,
        receipt.route.messageThreadId!,
        receipt.name,
      );
    } catch {
      return;
    }
    if (result !== true) return;
    this.app.store.savepoint("telegram_topic_title_result", () => {
      // Permanent purge may scrub this receipt while the API call is in flight.
      if (!save("done").changes) return;
      this.app.store.run(
        "UPDATE telegram_known_topics SET name=? WHERE chat=? AND user=? AND messageThreadId=? AND nameUpdateId=? AND nameBotId=?",
        receipt.name,
        receipt.route.chat,
        receipt.route.user,
        receipt.route.messageThreadId!,
        updateId,
        eventBot,
      );
      syncTopicTitle(this.app, receipt.route);
    });
  }
  /** Control replies identify the configured private owner, never grant history access. */
  private controlRoute(owner: TelegramOwner): ControlRoute | undefined {
    if (
      !this.privateDm ||
      !this.botId ||
      !this.users.includes(owner.user) ||
      !this.chats.includes(owner.chat)
    )
      return;
    const saved = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key='telegram:connection'",
    );
    if (!saved) return;
    try {
      const config = JSON.parse(saved.value);
      if (
        config.enabled !== true ||
        config.bot?.id !== this.botId ||
        config.userId !== owner.user ||
        config.chatId !== owner.chat
      )
        return;
      const credential = this.app.store.get<{ value: string }>(
        "SELECT value FROM credentials WHERE provider='telegram:bot'",
      );
      if (!credential) return;
      const identity = JSON.parse(credential.value);
      if (
        identity.botId !== this.botId ||
        typeof identity.token !== "string" ||
        !identity.token.trim()
      )
        return;
      if (hash(credential?.value ?? "") !== this.credentialBinding) return;
      return {
        ...owner,
        botId: this.botId,
        credentialBinding: hash(credential?.value ?? ""),
      };
    } catch {
      return;
    }
  }
  private recoveryReply(
    updateId: number,
    fingerprint: string,
    route: ControlRoute,
    text: string,
  ) {
    const current = this.controlRoute(route);
    if (!current || JSON.stringify(current) !== JSON.stringify(route))
      return { ignored: true };
    const result = { error: text, control: true };
    const prefix = `telegram:control:${updateId}`;
    this.app.store.db.exec("SAVEPOINT telegram_control_reply");
    try {
      this.app.store.queueTelegram(
        prefix,
        route.chat,
        text,
        3500,
        undefined,
        route.messageThreadId,
      );
      for (const part of this.app.store.all<{ id: string }>(
        "SELECT id FROM deliveries WHERE id>=? AND id<?",
        ...childIds(prefix),
      )) {
        this.app.store.run(
          "INSERT OR IGNORE INTO meta VALUES (?,?)",
          `telegram:control-route:${part.id}`,
          JSON.stringify(route),
        );
        const anchor = this.app.store.get<{ conversationId: string }>(
          "SELECT conversationId FROM telegram WHERE chat=? AND user=?",
          route.chat,
          route.user,
        );
        // Recovery guidance belongs to the main binding only when sent there.
        // A topic route must never block unrelated topics or the main chat.
        const conversationId =
          route.messageThreadId === undefined
            ? anchor?.conversationId
            : undefined;
        this.app.store.run(
          "INSERT OR IGNORE INTO telegram_delivery_scopes VALUES (?,?,?,?,?)",
          part.id,
          route.chat,
          route.user,
          route.messageThreadId ?? null,
          conversationId ?? null,
        );
      }
      this.app.store.run(
        "INSERT OR IGNORE INTO meta VALUES (?,?)",
        `telegram:update:${updateId}`,
        JSON.stringify(result),
      );
      this.app.store.run(
        "INSERT OR IGNORE INTO telegram_updates VALUES (?,?)",
        updateId,
        fingerprint,
      );
      this.app.store.db.exec("RELEASE SAVEPOINT telegram_control_reply");
      return result;
    } catch (error) {
      this.app.store.db.exec("ROLLBACK TO SAVEPOINT telegram_control_reply");
      this.app.store.db.exec("RELEASE SAVEPOINT telegram_control_reply");
      throw error;
    }
  }
  private updateIdentity(update: TelegramUpdate) {
    const bot = String(
      this.botId ?? this.botUsername ?? this.credentialBinding,
    );
    const key = `telegram:update-identity:${bot}:${update.update_id}`;
    const fingerprint = hash(JSON.stringify(update));
    const saved = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      key,
    );
    if (saved && saved.value !== fingerprint)
      throw new TelegramInputError(
        "update_id já utilizado com conteúdo diferente",
      );
    return { key, fingerprint, seen: !!saved };
  }
  private async receiveCallback(update: TelegramUpdate) {
    const query = update.callback_query!;
    const identity = this.updateIdentity(update);
    const updateKey = `telegram:callback-update:${update.update_id}`;
    const fingerprint = hash(JSON.stringify(update));
    const prior = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      updateKey,
    );
    if (prior && prior.value !== fingerprint)
      throw new TelegramInputError(
        "update_id já utilizado com conteúdo diferente",
      );
    const message = query.message;
    const answer = async (text: string) => {
      try {
        await this.transport.answerCallback?.(query.id, text);
      } catch {
        /* expired callback acknowledgement does not repeat a control effect */
      }
    };
    if (
      !Number.isSafeInteger(update.update_id) ||
      update.update_id < 0 ||
      typeof query.id !== "string" ||
      !query.id ||
      !message ||
      !message.chat ||
      !Number.isSafeInteger(message.message_id) ||
      message.message_id <= 0 ||
      !query.from ||
      !Number.isSafeInteger(query.from.id) ||
      query.from.id <= 0 ||
      typeof query.data !== "string" ||
      message.date === 0 ||
      (message.message_thread_id !== undefined &&
        (!Number.isSafeInteger(message.message_thread_id) ||
          message.message_thread_id <= 0)) ||
      message.chat.type !== "private" ||
      query.from.is_bot ||
      !/^pi:[a-f0-9]{32}$/.test(query.data ?? "")
    )
      return { ignored: true };
    const key = `telegram:button:${query.data}`;
    const saved = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      key,
    );
    if (!saved) {
      await answer(
        "Botão indisponível. Use /model, /crons, /topics ou /cua novamente.",
      );
      return { ignored: true };
    }
    const data = JSON.parse(saved.value) as TelegramButton;
    const origin = {
      chat: String(message.chat.id),
      user: String(query.from.id),
      ...(message.message_thread_id === undefined
        ? {}
        : { messageThreadId: message.message_thread_id }),
    };
    if (
      data.expiresAt <= Date.now() ||
      data.credentialBinding !== credentialBinding(this.app) ||
      origin.chat !== data.owner.chat ||
      origin.user !== data.owner.user ||
      (origin.messageThreadId ?? null) !== data.originThreadId ||
      !this.users.includes(origin.user) ||
      !this.chats.includes(origin.chat) ||
      (this.privateDm && !this.controlRoute(origin)) ||
      (this.botId && message.from?.id !== this.botId)
    ) {
      await answer("Botão expirado ou não autorizado.");
      return { ignored: true };
    }
    try {
      if (
        data.kind === "cron" ||
        (data.kind === "topic" && !data.conversationId)
      )
        this.app.telegramChats.creationAuthority(data.owner);
      else
        this.app.commands.authorize(data.conversationId, {
          source: "telegram",
          ...data.owner,
        });
      if (
        this.app.store.get(
          "SELECT 1 FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=? AND closed=1",
          data.owner.chat,
          data.owner.user,
          data.owner.messageThreadId ?? null,
        )
      )
        throw new CommandError("Tópico fechado no estado observado.");
      this.app.store.run(
        "INSERT OR IGNORE INTO meta VALUES (?,?)",
        identity.key,
        identity.fingerprint,
      );
      if (data.used) {
        await answer(
          data.kind === "model"
            ? "Este controle já foi processado. Use /model novamente."
            : "Este controle já foi processado. Use /crons, /cua ou /topics.",
        );
        return { processed: true };
      }
      this.app.store.run(
        "INSERT OR IGNORE INTO meta VALUES (?,?)",
        updateKey,
        fingerprint,
      );
      this.app.store.run(
        "INSERT OR IGNORE INTO meta VALUES (?,?)",
        identity.key,
        identity.fingerprint,
      );
      // Claim before awaiting creation; a lost response or restart never replays the mutation.
      this.app.store.run(
        "UPDATE meta SET value=? WHERE key=?",
        JSON.stringify({ ...data, used: true }),
        key,
      );
      if (data.kind === "cron") {
        await handleCronMenu(
          this.app,
          data,
          message.message_id,
          this.transport,
        );
        await answer("Menu de agendamentos atualizado.");
      } else if (data.kind === "model") {
        await handleModelMenu(
          this.app,
          data,
          message.message_id,
          this.transport,
          () => {
            if (
              this.closing ||
              data.credentialBinding !== credentialBinding(this.app) ||
              (this.privateDm && !this.controlRoute(origin))
            )
              throw new SettingsError(
                "Conexão Telegram mudou. Use /model novamente.",
              );
          },
        );
        await answer("Menu de modelo atualizado.");
      } else if (data.kind === "topic") {
        const validate = () => {
          if (
            this.closing ||
            data.credentialBinding !== credentialBinding(this.app) ||
            (this.privateDm && !this.controlRoute(origin))
          )
            throw new CommandError(
              "Conexão Telegram mudou. Use /topics novamente.",
            );
          this.app.telegramChats.creationAuthority(data.owner);
          if (
            this.app.store.get(
              "SELECT 1 FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=? AND closed=1",
              data.owner.chat,
              data.owner.user,
              data.owner.messageThreadId ?? null,
            )
          )
            throw new CommandError("Tópico fechado no estado observado.");
        };
        if (!data.conversationId)
          data.conversationId = await this.app.telegramChats.ensure(
            data.owner,
            validate,
          );
        validate();
        const selected = this.app.telegramChats.selection(data.owner);
        if (selected) this.app.assertHandoffAvailable(selected);
        this.app.assertHandoffAvailable(data.conversationId);
        this.app.telegramChats.select(data.conversationId, data.owner);
        queueControl(
          this.app,
          `telegram:topic-select:${query.data}`,
          data.owner,
          data.conversationId,
          `Conversa selecionada neste tópico: ${data.conversationId}. As próximas mensagens enviadas aqui usam esta conversa.`,
        );
        await answer(
          "Selecionado no tópico indicado. Abra esse tópico para continuar.",
        );
      } else {
        const service = this.app.cuaHandoffs;
        if (!service) throw new CommandError("Viewer CUA indisponível.");
        const row = service
          .list(data.conversationId)
          .find((r) => r.id === data.handoffId);
        if (!row)
          throw new CommandError("Intervenção indisponível nesta conversa.");
        if (data.kind === "cua-confirm") {
          if (row.state !== "active")
            throw new CommandError(
              "O estado desta intervenção mudou. Consulte /cua.",
            );
          queueCuaControl(
            this.app,
            row,
            `telegram:cua-confirm:${query.data}`,
            true,
          );
        } else {
          if (data.kind === "cua-create")
            await service.create(data.conversationId, row.id, {
              clipboard: false,
            });
          else if (data.kind === "cua-cancel")
            service.end(data.conversationId, row.id, { cancel: true });
          else if (data.kind === "cua-end")
            service.end(data.conversationId, row.id, {
              allTabsClosed: true,
              controlReturned: true,
            });
          // Revalidate after async mint; a revoked owner never receives the link/control reply.
          this.app.commands.authorize(data.conversationId, {
            source: "telegram",
            ...data.owner,
          });
          if (data.credentialBinding !== credentialBinding(this.app))
            throw new CommandError(
              "Conexão Telegram mudou. Consulte a interface Pi.",
            );
          queueCuaControl(
            this.app,
            service.list(data.conversationId).find((r) => r.id === row.id)!,
            `telegram:cua-result:${query.data}`,
          );
        }
        await answer(
          "Controle CUA atualizado. Consulte a mensagem neste tópico.",
        );
      }
      return { control: true, conversationId: data.conversationId };
    } catch (error) {
      const text =
        error instanceof CommandError ||
        error instanceof SettingsError ||
        error instanceof TaskError ||
        error instanceof ConversationError
          ? error.message
          : data.kind === "cron"
            ? "Operação não concluída. Use /crons novamente; este controle não será repetido automaticamente."
            : data.kind === "model"
              ? "Seleção não concluída. Use /model novamente; este controle não será repetido automaticamente."
              : "Controle não concluído. Consulte /cua ou a interface Pi; a criação não será repetida automaticamente.";
      await answer(text);
      return { error: text, control: true };
    }
  }
  async receive(update: TelegramUpdate, signal?: AbortSignal) {
    if (this.closing || signal?.aborted) return { ignored: true };
    if (update.callback_query) return this.receiveCallback(update);
    const message = update.message;
    const eventBot = String(
      this.botId ?? this.botUsername ?? this.credentialBinding,
    );
    if (
      !Number.isSafeInteger(update.update_id) ||
      update.update_id < 0 ||
      !message?.from ||
      message.from.is_bot ||
      !message.chat
    )
      return { ignored: true };
    const user = String(message.from.id),
      chat = String(message.chat.id);
    const messageThreadId = message.message_thread_id;
    if (
      (messageThreadId !== undefined &&
        (!Number.isSafeInteger(messageThreadId) ||
          messageThreadId <= 0 ||
          message.chat.type !== "private")) ||
      (message.is_topic_message && messageThreadId === undefined)
    )
      return { ignored: true };
    const owner: TelegramOwner = {
      chat,
      user,
      ...(messageThreadId === undefined ? {} : { messageThreadId }),
    };
    if (
      !this.users.includes(user) ||
      !this.chats.includes(chat) ||
      (this.privateDm && message.chat.type !== "private")
    )
      return { ignored: true };
    if (this.privateDm && !this.controlRoute({ chat, user }))
      return { ignored: true };
    if (
      this.app.store.get(
        "SELECT 1 FROM telegram_purged_updates WHERE id=?",
        update.update_id,
      )
    )
      return { ignored: true };
    const identity = this.updateIdentity(update);
    if (typeof message.text !== "string" || !message.text) {
      if (message.forum_topic_created)
        await this.transport.settleTopicCreates?.();
      const service =
        message.forum_topic_created ||
        message.forum_topic_edited ||
        message.forum_topic_closed ||
        message.forum_topic_reopened;
      if (!service) return { ignored: true };
      if (identity.seen) {
        if (message.forum_topic_created && messageThreadId !== undefined) {
          try {
            await this.app.telegramChats.ensure(
              owner,
              undefined,
              message.forum_topic_created.name,
            );
          } catch (error) {
            if (!unavailableConversation(error)) throw error;
          }
        }
        await this.editImplicitTopicTitle(update.update_id, eventBot);
        return { observed: true };
      }
      if (
        this.app.store.get(
          "SELECT 1 FROM telegram_updates WHERE id=?",
          update.update_id,
        )
      )
        throw new TelegramInputError(
          "update_id já utilizado com conteúdo diferente",
        );
      try {
        this.app.telegramChats.creationAuthority(owner);
      } catch (error) {
        if (!unavailableConversation(error)) throw error;
        return { ignored: true };
      }
      this.app.store.savepoint("telegram_topic_observation", () => {
        observeTopic(
          this.app,
          owner,
          message,
          update.update_id,
          eventBot,
          message.date ?? 0,
        );
        this.queueImplicitTopicTitle(update, owner, eventBot);
        this.app.store.run(
          "INSERT INTO meta VALUES (?,?)",
          identity.key,
          identity.fingerprint,
        );
      });
      if (message.forum_topic_created && messageThreadId !== undefined) {
        try {
          await this.app.telegramChats.ensure(
            owner,
            undefined,
            message.forum_topic_created.name,
          );
        } catch (error) {
          if (!unavailableConversation(error)) throw error;
        }
      }
      await this.editImplicitTopicTitle(update.update_id, eventBot);
      return { observed: true };
    }
    const command = this.commandText(message.text);
    const text =
      command === "/crons"
        ? command
        : cronReplyReceipt(this.app, owner, message)
          ? message.text
          : command;
    if (text === undefined) return { ignored: true };
    const fingerprint = hash(
      JSON.stringify(
        messageThreadId === undefined
          ? [user, chat, message.text]
          : [user, chat, message.text, messageThreadId],
      ),
    );
    const previous = this.app.store.get<{ fingerprint: string }>(
      "SELECT fingerprint FROM telegram_updates WHERE id=?",
      update.update_id,
    );
    const legacy =
      previous &&
      this.app.store.get<{
        fingerprint: string;
        replayFingerprint: string | null;
      }>(
        "SELECT fingerprint,replayFingerprint FROM telegram_legacy_updates WHERE id=?",
        update.update_id,
      );
    const legacyReplay =
      legacy &&
      legacy.fingerprint === hash(JSON.stringify([user, chat, message.text])) &&
      (legacy.replayFingerprint === null
        ? previous.fingerprint === legacy.fingerprint
        : legacy.replayFingerprint === fingerprint &&
          previous.fingerprint === fingerprint);
    if (previous && previous.fingerprint !== fingerprint && !legacyReplay)
      throw new TelegramInputError(
        "update_id já utilizado com conteúdo diferente",
      );
    if (legacy && legacy.replayFingerprint !== null && !legacyReplay)
      throw new TelegramInputError(
        "update_id já utilizado com conteúdo diferente",
      );
    this.app.store.run(
      "INSERT OR IGNORE INTO meta VALUES (?,?)",
      identity.key,
      identity.fingerprint,
    );
    try {
      this.app.telegramChats.creationAuthority(owner);
      observeTopic(
        this.app,
        owner,
        message,
        update.update_id,
        eventBot,
        message.date ?? 0,
      );
    } catch (error) {
      if (!unavailableConversation(error)) throw error;
    }
    if (
      this.app.store.get(
        "SELECT 1 FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=? AND closed=1",
        chat,
        user,
        messageThreadId ?? null,
      )
    )
      return { ignored: true };
    if (legacyReplay) {
      const recovered =
        messageThreadId !== undefined &&
        this.recoverLegacy(update.update_id, text, { chat, user });
      this.app.store.savepoint("telegram_legacy_replay", () => {
        this.app.store.run(
          "UPDATE telegram_updates SET fingerprint=? WHERE id=?",
          fingerprint,
          update.update_id,
        );
        if (recovered)
          this.app.store.run(
            "UPDATE telegram_legacy_updates SET replayFingerprint=? WHERE id=?",
            fingerprint,
            update.update_id,
          );
        else
          this.app.store.run(
            "DELETE FROM telegram_legacy_updates WHERE id=?",
            update.update_id,
          );
      });
      // Acknowledge previous work without exposing the unthreaded result to a
      // topic, re-executing a command, or moving its history/outbox destination.
      if (recovered) return { recovered: true };
    }
    const linked = this.app.store.get<{ conversationId: string; user: string }>(
      "SELECT * FROM telegram WHERE chat=?",
      chat,
    );
    if (
      !/^\/(link|start)(?:\s|$)/.test(text) &&
      (!linked || linked.user !== user) &&
      !this.controlRoute({ chat, user })
    )
      throw new TelegramInputError(
        "Conversa não vinculada a este usuário; use /link CODIGO pela web",
      );
    const inFlight = this.receives.get(update.update_id);
    if (inFlight) return inFlight;
    const tracked = {
      conversationId: undefined as string | undefined,
      accepting: true,
      normal: false,
    };
    const stopTyping = this.app.store.get(
      "SELECT 1 FROM meta WHERE key=?",
      `telegram:update:${update.update_id}`,
    )
      ? () => {}
      : this.typing.start(
          update.update_id,
          chat,
          () => {
            if (this.closing || signal?.aborted) return false;
            if (this.privateDm && !this.controlRoute({ chat, user }))
              return false;
            this.app.telegramChats.creationAuthority(owner);
            const selected = this.app.telegramChats.selected(owner);
            const id =
              tracked.conversationId ?? selected ?? linked?.conversationId;
            if (!id || (tracked.conversationId && selected && selected !== id))
              return false;
            if (
              messageThreadId !== undefined &&
              !tracked.conversationId &&
              !selected &&
              tracked.accepting
            ) {
              this.app.assertHandoffAvailable(id);
              return true;
            }
            this.app.commands.authorize(id, { source: "telegram", ...owner });
            this.app.assertHandoffAvailable(id);
            if (tracked.accepting) return true;
            return (
              tracked.normal &&
              this.app.store.get<{ status: string }>(
                "SELECT status FROM requests WHERE conversationId=? AND requestId=? AND source='telegram' AND chat=?",
                id,
                `telegram:${update.update_id}`,
                chat,
              )?.status === "pending"
            );
          },
          {
            signal,
            ...(Number.isSafeInteger(message.message_thread_id) &&
            message.message_thread_id! > 0
              ? { messageThreadId: message.message_thread_id }
              : {}),
          },
        );
    const operation = this.accept(
      update,
      user,
      chat,
      fingerprint,
      text,
      signal,
      tracked,
      messageThreadId,
    ).then(
      (response) => {
        tracked.accepting = false;
        tracked.normal =
          !!response &&
          typeof response === "object" &&
          "kind" in response &&
          response.kind === "message";
        if (!tracked.normal) stopTyping();
        else this.typing.check();
        return response;
      },
      (error) => {
        stopTyping();
        throw error;
      },
    );
    this.receives.set(update.update_id, operation);
    void operation
      .finally(() => this.receives.delete(update.update_id))
      .catch(() => {});
    return operation;
  }
  private recoverLegacy(updateId: number, text: string, owner: TelegramOwner) {
    const store = this.app.store;
    const authorize = (id: string) => {
      this.app.telegramChats.creationAuthority(owner);
      this.app.commands.authorizeInput(
        id,
        { source: "telegram", ...owner },
        text,
      );
    };
    const existing = store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      `telegram:update:${updateId}`,
    );
    if (existing) {
      const value = JSON.parse(existing.value) as {
        conversationId?: string;
        linked?: string;
      };
      const id = value.conversationId ?? value.linked;
      if (id) authorize(id);
      return true;
    }
    const requestId = `telegram:${updateId}`;
    const command = store.get<{
      conversationId: string;
      text: string;
      result: string | null;
    }>(
      "SELECT conversationId,text,result FROM command_receipts WHERE key=?",
      this.app.commands.key("", requestId, { source: "telegram", ...owner }),
    );
    if (command) {
      if (command.text !== text)
        throw new TelegramInputError(
          "update_id já utilizado com conteúdo diferente",
        );
      authorize(command.conversationId);
      if (command.result)
        authorize(
          (JSON.parse(command.result) as { conversationId: string })
            .conversationId,
        );
      // Pending commands become uncertain during recovery; neither state may
      // rerun its effects merely to reconstruct the outer Telegram receipt.
      return true;
    }
    const request = store.get<{ conversationId: string; text: string }>(
      "SELECT conversationId,text FROM requests WHERE requestId=? AND source='telegram' AND chat=?",
      requestId,
      owner.chat,
    );
    if (request) {
      const escaped = text.trimStart().startsWith("//")
        ? text.replace("/", "")
        : text;
      if (request.text !== escaped)
        throw new TelegramInputError(
          "update_id já utilizado com conteúdo diferente",
        );
      authorize(request.conversationId);
      // Runtime.open reattaches/submits durable requests using their original
      // owner and native requestId; the update must not admit a topic copy.
      return true;
    }
    const decision = /^\/(approve|deny)\s+([a-f0-9]{24})$/.exec(text);
    const action =
      decision &&
      store.get<{ conversationId: string }>(
        "SELECT conversationId FROM actions WHERE id=? AND state!='pending'",
        decision[2],
      );
    if (action) {
      authorize(action.conversationId);
      return true;
    }
    return false;
  }
  private async accept(
    update: TelegramUpdate,
    user: string,
    chat: string,
    fingerprint: string,
    text: string,
    signal?: AbortSignal,
    tracked?: { conversationId?: string },
    messageThreadId?: number,
  ) {
    const owner: TelegramOwner = {
      chat,
      user,
      ...(messageThreadId === undefined ? {} : { messageThreadId }),
    };
    // Re-delivered commands reuse the update key; never consume a link or approve twice.
    const commandKey = `telegram:update:${update.update_id}`;
    const existing = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      commandKey,
    );
    if (existing) {
      const value = JSON.parse(existing.value) as {
        conversationId?: string;
        linked?: string;
      };
      const conversationId = value.conversationId ?? value.linked;
      if (conversationId && text === "/crons")
        this.app.telegramChats.assertCreationAuthority(conversationId, owner);
      else if (conversationId && (text === "/cua" || text === "/controls"))
        this.app.commands.authorize(conversationId, {
          source: "telegram",
          ...owner,
        });
      else if (conversationId)
        this.app.commands.authorizeInput(
          conversationId,
          {
            source: "telegram",
            chat,
            user,
            messageThreadId,
          },
          text,
        );
      this.app.store.run(
        "INSERT OR IGNORE INTO telegram_updates VALUES (?,?)",
        update.update_id,
        fingerprint,
      );
      return value;
    }
    this.app.store.run(
      "INSERT OR IGNORE INTO telegram_updates VALUES (?,?)",
      update.update_id,
      fingerprint,
    );
    if (
      text !== "/crons" &&
      acceptCronReply(this.app, owner, update.message!, update.update_id)
    ) {
      const result = { control: true, command: "crons" };
      this.app.store.run(
        "INSERT OR IGNORE INTO meta VALUES (?,?)",
        commandKey,
        JSON.stringify(result),
      );
      return result;
    }
    const linked = this.app.store.get<{ conversationId: string; user: string }>(
      "SELECT * FROM telegram WHERE chat=?",
      chat,
    );
    let response: unknown;
    let conversationId = linked?.conversationId;
    let errorReply: string | undefined;
    const pairing = /^\/(link|start)(?:\s+([\s\S]*))?$/.exec(text);
    if (messageThreadId !== undefined && pairing?.[2]) {
      const control = this.controlRoute(owner);
      if (control)
        return this.recoveryReply(
          update.update_id,
          fingerprint,
          control,
          "Vincule o bot na conversa sem tópico. Os tópicos mantêm históricos próprios e não importam conversas existentes.",
        );
      throw new TelegramInputError("Vincule o bot na conversa sem tópico");
    }
    if (pairing?.[1] === "start" && !pairing[2]) {
      const control = this.controlRoute(owner);
      try {
        this.app.telegramChats.creationAuthority({ chat, user });
      } catch (error) {
        if (!unavailableConversation(error)) throw error;
        if (control)
          return this.recoveryReply(
            update.update_id,
            fingerprint,
            control,
            TELEGRAM_RELINK_GUIDANCE,
          );
      }
      errorReply =
        linked?.user === user
          ? this.privateDm
            ? "Conectado. As mensagens usam conversas exclusivas do Telegram; o histórico anterior foi preservado sem misturar os canais. Use /topics para gerenciar as conversas."
            : "Conversa vinculada. Use /help para consultar os comandos. Para vincular outra conversa, gere um código na interface web."
          : "Abra a conversa na interface web, escolha Vincular Telegram e envie /link CODIGO aqui. O código é de uso único e expira em 10 minutos.";
      response = { info: errorReply };
    } else if (pairing) {
      if (!/^[a-f0-9]{32}$/.test(pairing[2] ?? ""))
        throw new CommandError(
          "Uso: /link CODIGO ou /start CODIGO, com o código gerado na interface web.",
        );
      let conversationId: string;
      try {
        conversationId = this.app.store.consumeLink(
          pairing[2],
          chat,
          user,
          commandKey,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Código de vínculo inválido ou expirado"
        )
          throw new TelegramInputError(error.message);
        throw error;
      }
      response = { linked: conversationId };
      // Re-link command is durably marked in the same synchronous turn as code consumption.
    } else {
      const control = this.controlRoute(owner);
      if ((!linked || linked.user !== user) && !control) {
        if (control)
          return this.recoveryReply(
            update.update_id,
            fingerprint,
            control,
            TELEGRAM_RELINK_GUIDANCE,
          );
        throw new TelegramInputError(
          "Vincule esta conversa na interface web com /link CODIGO",
        );
      }
      let authority: string;
      try {
        authority = this.app.telegramChats.creationAuthority(owner);
      } catch (error) {
        if (!unavailableConversation(error)) throw error;
        if (control)
          return this.recoveryReply(
            update.update_id,
            fingerprint,
            control,
            TELEGRAM_RELINK_GUIDANCE,
          );
        throw error;
      }
      const selected = this.app.telegramChats.selection(owner);
      if (
        text === "/topics" ||
        text === "/cua" ||
        text === "/crons" ||
        text === "/controls"
      ) {
        const available =
          selected &&
          this.app.telegramChats.owns(selected, owner) &&
          !this.app.store.conversationDeleted(selected)
            ? selected
            : undefined;
        if (text === "/cua" || text === "/controls") {
          if (selected) this.app.telegramChats.authorize(selected, owner);
          if (!selected && owner.messageThreadId !== undefined)
            return control
              ? this.recoveryReply(
                  update.update_id,
                  fingerprint,
                  control,
                  "Nenhuma conversa ou intervenção CUA selecionada neste tópico. Use /new ou envie uma mensagem aqui.",
                )
              : { ignored: true };
        }
        const current = available ?? authority;
        if (text === "/cua" || text === "/controls")
          this.app.commands.authorize(current, {
            source: "telegram",
            ...owner,
          });
        let data: unknown;
        if (text === "/topics")
          data = queueTopicsControl(
            this.app,
            owner,
            current,
            `telegram:topics:${update.update_id}`,
          );
        else if (text === "/controls") {
          const link = this.app.isTelegramConversation(current)
            ? cuaWebLink(this.app, current)
            : undefined;
          queueControl(
            this.app,
            `telegram:controls:${update.update_id}`,
            owner,
            current,
            link
              ? "Abra os controles humanos na página autenticada. Continue a conversa neste tópico."
              : "Nenhum controle Telegram disponível. Envie sua próxima mensagem neste tópico para iniciar sua conversa Telegram.",
            link
              ? {
                  inline_keyboard: [
                    [{ text: "Abrir controles humanos", url: link }],
                  ],
                }
              : undefined,
          );
        } else if (text === "/crons")
          openCronMenu(this.app, owner, current, update.update_id);
        else {
          const rows = this.app.cuaHandoffs?.list(current) ?? [];
          const held = rows.filter((row) => row.state !== "ended");
          for (const row of held)
            queueCuaControl(
              this.app,
              row,
              `telegram:cua:${update.update_id}:${row.id}`,
            );
          if (!held.length)
            queueControl(
              this.app,
              `telegram:cua:${update.update_id}`,
              owner,
              current,
              "Nenhuma intervenção CUA pendente nesta conversa. Peça ao Pi uma intervenção na sua mensagem; o controle exige uma solicitação válida nesta conversa.",
            );
          data = held.map(({ id, server, state }) => ({ id, server, state }));
        }
        const result = {
          kind: "command",
          command: text.slice(1),
          conversationId: current,
          control: true,
          data,
        };
        this.app.store.run(
          "INSERT OR IGNORE INTO meta VALUES (?,?)",
          commandKey,
          JSON.stringify({ ...result, data: undefined }),
        );
        return result;
      }
      if (selected) this.app.assertHandoffAvailable(selected);
      const management = /^\/(topics|chats)(?:\s|$)/.test(text);
      if (management) {
        // A revoked/archived selection may be replaced explicitly with /chats.
        conversationId =
          selected &&
          this.app.telegramChats.owns(selected, owner) &&
          !this.app.store.conversationDeleted(selected)
            ? selected
            : authority;
      } else {
        const prior = this.app.store.get<{ conversationId: string }>(
          "SELECT conversationId FROM requests WHERE requestId=? AND source='telegram' AND chat=?",
          `telegram:${update.update_id}`,
          chat,
        );
        try {
          conversationId =
            prior?.conversationId ?? this.app.telegramChats.selected(owner);
        } catch (error) {
          if (!unavailableConversation(error)) throw error;
          if (control)
            return this.recoveryReply(
              update.update_id,
              fingerprint,
              control,
              TELEGRAM_SELECTION_GUIDANCE,
            );
          throw error;
        }
        if (!conversationId) {
          // Migrate normal messages on first use; command-only operations retain
          // access to the old binding until a dedicated conversation exists.
          conversationId =
            messageThreadId !== undefined ||
            !text.trimStart().startsWith("/") ||
            text.trimStart().startsWith("//") ||
            /^\/(model|thinking|compact|stop|agents)(?:\s|$)/.test(text)
              ? await this.app.telegramChats.ensure(owner)
              : authority;
        }
        this.app.commands.authorize(conversationId, {
          source: "telegram",
          ...owner,
        });
      }
      if (tracked) tracked.conversationId = conversationId;
      const decision = /^\/(approve|deny)\s+([a-f0-9]{24})$/.exec(text);
      if (text === "/model") {
        try {
          await openModelMenu(
            this.app,
            owner,
            conversationId!,
            update.update_id,
          );
          response = {
            kind: "command",
            command: "model",
            conversationId,
            control: true,
          };
        } catch (error) {
          if (!(error instanceof SettingsError)) throw error;
          errorReply = error.message;
          response = { error: errorReply };
        }
      } else if (decision) {
        if (
          !this.app.store.get(
            "SELECT id FROM actions WHERE id=? AND conversationId=?",
            decision[2],
            conversationId!,
          )
        )
          throw new TelegramInputError("Ação não encontrada nesta conversa");
        const action = await this.app.actions.decide(
          conversationId!,
          decision[2],
          decision[1] === "approve" ? "approve" : "deny",
          signal,
        );
        if (action.state === "running") return { processing: true };
        await this.app.recordAction(action);
        this.app.store.savepoint("decision_delivery", () => {
          this.app.store.run(
            "INSERT OR IGNORE INTO deliveries(id,chat,text,messageThreadId) VALUES (?,?,?,?)",
            `decision:${update.update_id}`,
            chat,
            `Ação ${action.id}: ${action.state}. ${action.state === "uncertain" ? "Verifique o serviço externo; a ação não será repetida automaticamente." : ""}`,
            messageThreadId ?? null,
          );
          this.app.store.run(
            "INSERT OR IGNORE INTO delivery_conversations VALUES (?,?)",
            `decision:${update.update_id}`,
            conversationId!,
          );
        });
        response = action;
      } else {
        try {
          response = await this.app.admit(
            conversationId!,
            `telegram:${update.update_id}`,
            text,
            { source: "telegram", ...owner },
          );
        } catch (error) {
          if (!(
            error instanceof SettingsError ||
            (error instanceof CommandError &&
              !error.message.includes("não autorizada"))
          ))
            throw error;
          errorReply = error.message;
          response = { error: errorReply };
        }
      }
    }
    this.app.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (errorReply) {
        this.app.store.run(
          "INSERT OR IGNORE INTO deliveries(id,chat,text,messageThreadId) VALUES (?,?,?,?)",
          `command:telegram:${update.update_id}:0`,
          chat,
          errorReply,
          messageThreadId ?? null,
        );
        if (linked)
          this.app.store.run(
            "INSERT OR IGNORE INTO delivery_conversations VALUES (?,?)",
            `command:telegram:${update.update_id}:0`,
            conversationId!,
          );
      }
      this.app.store.run(
        "INSERT OR IGNORE INTO meta VALUES (?,?)",
        commandKey,
        JSON.stringify(response),
      );
      this.app.store.db.exec("COMMIT");
    } catch (error) {
      this.app.store.db.exec("ROLLBACK");
      throw error;
    }
    return response;
  }
  flush() {
    if (this.closing) return Promise.resolve();
    if (this.flushWork) return this.flushWork;
    this.flushWork = this.sendPending().finally(() => {
      this.flushWork = undefined;
    });
    return this.flushWork;
  }
  async drain() {
    this.closing = true;
    this.typing.close();
    await Promise.allSettled(this.receives.values());
    await this.flushWork;
  }
  setDmChat(chat: string) {
    if (this.privateDm) {
      if (!this.chats.includes(chat)) this.typing.close();
      this.chats = [chat];
    }
  }
  private async sendPending() {
    this.typing.check();
    if (Date.now() < this.sendAfter) return;
    for (const delivery of this.app.store.all<Delivery>(
      "SELECT * FROM deliveries WHERE state='pending' ORDER BY rowid",
    )) {
      if (this.closing) break;
      const control = this.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        `telegram:control-route:${delivery.id}`,
      );
      let authorizedControl = false;
      if (control) {
        try {
          const route = JSON.parse(control.value) as ControlRoute;
          const current = this.controlRoute(route);
          authorizedControl =
            !!current &&
            current.chat === delivery.chat &&
            (current.messageThreadId ?? null) === delivery.messageThreadId &&
            JSON.stringify(current) === JSON.stringify(route);
        } catch {
          /* Malformed control receipts never authorize a send. */
        }
      }
      // Revoked owned receipts are terminal even when this engine now serves
      // another chat. Unowned legacy rows outside its allowlist stay untouched.
      if (
        control
          ? !authorizedControl
          : !taskTelegramAuthorized(
              this.app.store,
              delivery.id,
              this.users,
              this.chats,
              this.botId,
            )
      ) {
        this.app.store.run(
          "UPDATE deliveries SET state='cancelled',result=? WHERE id=? AND state='pending'",
          "Vínculo Telegram revogado antes do envio.",
          delivery.id,
        );
        continue;
      }
      if (this.privateDm && !this.chats.includes(delivery.chat)) continue;
      if (
        this.privateDm &&
        !this.users.some((user) =>
          this.controlRoute({ chat: delivery.chat, user }),
        )
      ) {
        this.app.store.run(
          "UPDATE deliveries SET state='cancelled',result=? WHERE id=? AND state='pending'",
          "Conexão Telegram revogada antes do envio.",
          delivery.id,
        );
        continue;
      }
      if (!control) {
        const owner = this.app.store.get<{ conversationId: string }>(
          `SELECT conversationId FROM delivery_conversations WHERE deliveryId=?
           UNION SELECT n.conversationId FROM task_notification_parts p JOIN task_notifications n ON n.id=p.notificationId WHERE p.deliveryId=? LIMIT 1`,
          delivery.id,
          delivery.id,
        );
        try {
          if (owner) this.app.assertConversationAvailable(owner.conversationId);
          else if (this.privateDm) {
            const user = this.users.find((user) =>
              this.controlRoute({ chat: delivery.chat, user }),
            );
            if (!user)
              throw new CommandError("Conexão Telegram não autorizada.");
            // Only an unowned legacy row still depends on the legacy binding.
            this.app.telegramChats.binding({ chat: delivery.chat, user });
          }
        } catch (error) {
          if (error instanceof ConversationBusyError) continue;
          if (!unavailableConversation(error)) throw error;
          this.app.store.run(
            "UPDATE deliveries SET state='cancelled',result=? WHERE id=? AND state='pending'",
            "Conversa Telegram indisponível antes do envio.",
            delivery.id,
          );
          continue;
        }
      }
      try {
        assertCronDelivery(this.app, delivery.id);
      } catch (error) {
        if (!(error instanceof TaskError) && !unavailableConversation(error))
          throw error;
        this.app.store.run(
          "UPDATE deliveries SET state='cancelled',result='Autorização ou menu de crons mudou antes do envio.' WHERE id=? AND state='pending'",
          delivery.id,
        );
        continue;
      }
      const changed = this.app.store.run(
        "UPDATE deliveries SET state='sending' WHERE id=? AND state='pending'",
        delivery.id,
      ).changes;
      if (!changed) continue;
      try {
        const savedMarkup = this.app.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key=?",
          `telegram:markup:${delivery.id}`,
        );
        const replyMarkup = savedMarkup
          ? (JSON.parse(savedMarkup.value) as TelegramReplyMarkup)
          : undefined;
        const forceReply = !!this.app.store.get(
          "SELECT 1 FROM meta WHERE key=?",
          `telegram:force-reply:${delivery.id}`,
        );
        const result = await this.transport.send(
          delivery.chat,
          delivery.text,
          delivery.messageThreadId == null &&
            delivery.parseMode !== "HTML" &&
            !replyMarkup &&
            !forceReply
            ? undefined
            : {
                ...(replyMarkup ? { replyMarkup } : {}),
                ...(forceReply ? { forceReply } : {}),
                ...(delivery.parseMode === "HTML"
                  ? { parseMode: "HTML" as const }
                  : {}),
                ...(delivery.messageThreadId == null
                  ? {}
                  : { messageThreadId: delivery.messageThreadId }),
              },
        );
        this.app.store.run(
          "UPDATE deliveries SET state='sent',result=? WHERE id=?",
          JSON.stringify(result),
          delivery.id,
        );
      } catch (error) {
        if (error instanceof TelegramSendRefused && error.code === 429) {
          // Later parts would hit the same limit; keep order and wait.
          this.app.store.run(
            "UPDATE deliveries SET state='pending' WHERE id=? AND state='sending'",
            delivery.id,
          );
          this.sendAfter = Date.now() + Math.max(1, error.retryAfter) * 1000;
          break;
        }
        this.app.store.run(
          "UPDATE deliveries SET state=?,result=? WHERE id=?",
          error instanceof TelegramSendRefused ? "failed" : "uncertain",
          error instanceof TelegramSendRefused
            ? `${error.message} Não foi entregue nem será reenviada.`
            : "Verifique no Telegram. Não reenviado automaticamente.",
          delivery.id,
        );
      }
    }
  }
}
