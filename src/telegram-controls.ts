import { randomBytes } from "node:crypto";
import type { Runtime } from "./runtime.js";
import type { TelegramOwner } from "./telegram-chats.js";
import type { CuaHandoff } from "./cua-handoffs.js";
import type { CronMenuAction } from "./telegram-crons.js";
import type { ModelMenuAction } from "./telegram-models.js";
import { childIds, hash, type Store } from "./store.js";
import { telegramConversationRoute } from "./task-telegram.js";

export interface TelegramReplyMarkup {
  inline_keyboard: { text: string; callback_data?: string; url?: string }[][];
}
export interface TelegramButton {
  kind:
    | "topic"
    | "model"
    | "cron"
    | "cua-create"
    | "cua-cancel"
    | "cua-confirm"
    | "cua-end";
  owner: TelegramOwner;
  originThreadId: number | null;
  conversationId: string;
  handoffId?: string;
  modelMenu?: ModelMenuAction;
  cronMenu?: CronMenuAction;
  credentialBinding: string;
  expiresAt: number;
  used?: boolean;
}
export function button(
  app: Runtime,
  data: Omit<TelegramButton, "credentialBinding" | "expiresAt">,
) {
  const key = `pi:${randomBytes(16).toString("hex")}`;
  app.store.run(
    "INSERT INTO meta VALUES (?,?)",
    `telegram:button:${key}`,
    JSON.stringify({
      ...data,
      credentialBinding: credentialBinding(app),
      expiresAt: Date.now() + 86400000,
    }),
  );
  return key;
}
export function credentialBinding(app: Runtime) {
  return hash(
    app.store.get<{ value: string }>(
      "SELECT value FROM credentials WHERE provider='telegram:bot'",
    )?.value ?? "",
  );
}
export function topicRouteKey(owner: TelegramOwner) {
  return `topic:${JSON.stringify([owner.chat, owner.user, owner.messageThreadId ?? null])}`;
}
export function queueControl(
  app: Runtime,
  prefix: string,
  owner: TelegramOwner,
  conversationId: string,
  text: string,
  markup?: TelegramReplyMarkup,
) {
  app.store.savepoint("telegram_native_control", () => {
    app.store.queueTelegram(
      prefix,
      owner.chat,
      text,
      3500,
      conversationId,
      owner.messageThreadId,
    );
    // Attach controls only to the last message if formatting splits the text.
    const parts = app.store.all<{ id: string }>(
      "SELECT id FROM deliveries WHERE id>=? AND id<? ORDER BY rowid",
      ...childIds(prefix),
    );
    const last = parts.at(-1);
    if (last && markup) {
      app.store.run(
        "INSERT OR IGNORE INTO meta VALUES (?,?)",
        `telegram:markup:${last.id}`,
        JSON.stringify(markup),
      );
      for (const control of markup.inline_keyboard.flat()) {
        if (!control.callback_data) continue;
        const saved = app.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key=?",
          `telegram:button:${control.callback_data}`,
        );
        const route = saved
          ? (JSON.parse(saved.value) as TelegramButton)
          : undefined;
        const target = route?.conversationId;
        for (const part of parts) {
          if (target)
            app.store.run(
              "INSERT OR IGNORE INTO telegram_control_parts VALUES (?,?)",
              part.id,
              target,
            );
          if (route)
            app.store.run(
              "INSERT OR IGNORE INTO telegram_control_parts VALUES (?,?)",
              part.id,
              topicRouteKey(route.owner),
            );
        }
      }
    }
  });
}
export function cuaWebLink(app: Runtime, id: string) {
  try {
    const url = new URL(app.options.webOrigin ?? "");
    if (
      url.origin !== app.options.webOrigin ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        ))
    )
      return;
    url.pathname = "/human-controls";
    url.searchParams.set("c", id);
    return url.href;
  } catch {
    return;
  }
}
export function queueCuaControl(
  app: Runtime,
  row: CuaHandoff,
  prefix = `${row.conversationId}:cua:${row.id}:${row.state}`,
  confirmReturn = false,
) {
  const route = telegramConversationRoute(app.store, row.conversationId);
  if (!route) return;
  const owner = {
    chat: route.chat,
    user: route.user,
    ...(route.messageThreadId === null
      ? {}
      : { messageThreadId: route.messageThreadId }),
  };
  const existing = app.store.get(
    "SELECT 1 FROM deliveries WHERE id>=? AND id<?",
    ...childIds(prefix),
  );
  if (existing) return;
  app.store.savepoint("telegram_cua_control", () => {
    const controls: TelegramReplyMarkup["inline_keyboard"] = [];
    const add = (text: string, kind: TelegramButton["kind"]) =>
      controls.push([
        {
          text,
          callback_data: button(app, {
            kind,
            owner,
            originThreadId: route.messageThreadId,
            conversationId: row.conversationId,
            handoffId: row.id,
          }),
        },
      ]);
    const link = cuaWebLink(app, row.conversationId);
    let text = `Intervenção CUA · ${row.server}. `;
    if (confirmReturn) {
      text +=
        "Feche TODAS as abas do viewer antes de confirmar que quer devolver o controle ao Pi. A confirmação não revoga remotamente o ticket.";
      add("Fechei todas as abas; devolver controle", "cua-end");
    } else if (row.state === "pending") {
      text +=
        "O Pi está pausado. Assumir cria um acesso privado de 30 minutos, com clipboard desabilitado. Abra o desktop pela interface Pi após fazer login.";
      add("Assumir controle (sem clipboard)", "cua-create");
      add("Cancelar intervenção pendente", "cua-cancel");
    } else if (row.state === "active") {
      text +=
        "Controle humano ativo. Abra o desktop na interface Pi autenticada. Para devolver, feche todas as abas do viewer e confirme explicitamente. O prazo do ticket não fecha conexões já abertas.";
      add("Devolver controle…", "cua-confirm");
    } else if (row.state === "ended") {
      text +=
        "Intervenção encerrada. Envie sua próxima instrução neste tópico para continuar; nenhuma execução foi iniciada automaticamente.";
    } else
      text +=
        "Criação em andamento ou incerta. O Pi continua pausado; verifique a interface sem repetir a criação.";
    if (link) {
      text += `\nInterface Pi (login obrigatório): ${link}`;
      controls.push([{ text: "Abrir intervenção na interface Pi", url: link }]);
    } else
      text +=
        "\nAbra esta conversa na interface Pi autenticada. O endereço público da aplicação não está configurado para este ambiente.";
    queueControl(app, prefix, owner, row.conversationId, text, {
      inline_keyboard: controls,
    });
  });
}

/** Bot API has no topic enumeration. Names and closed state are observations only. */
export function observeTopic(
  app: Runtime,
  owner: TelegramOwner,
  event: {
    forum_topic_created?: { name: string };
    forum_topic_edited?: { name?: string };
    forum_topic_closed?: object;
    forum_topic_reopened?: object;
  },
  updateId: number,
  botId: string,
  messageDate: number,
) {
  if (owner.messageThreadId === undefined) return;
  const name =
    event.forum_topic_created?.name ?? event.forum_topic_edited?.name;
  const safeName =
    typeof name === "string" &&
    Array.from(name).length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(name)
      ? name
      : undefined;
  const closed = event.forum_topic_closed
    ? 1
    : event.forum_topic_reopened || event.forum_topic_created
      ? 0
      : null;
  const date =
    Number.isSafeInteger(messageDate) && messageDate >= 0 ? messageDate : 0;
  const newer = (field: "name" | "state") =>
    `(excluded.${field}BotId IS NOT telegram_known_topics.${field}BotId OR excluded.${field}Date>telegram_known_topics.${field}Date OR (excluded.${field}Date=telegram_known_topics.${field}Date AND excluded.${field}UpdateId>telegram_known_topics.${field}UpdateId))`;
  // A delayed creation event cannot undo a name already observed/confirmed for this bot.
  const nameChanged = `excluded.name IS NOT NULL AND ${newer("name")}${event.forum_topic_created ? " AND telegram_known_topics.nameBotId IS NOT excluded.nameBotId" : ""}`;
  const stateChanged = `excluded.closed IS NOT NULL AND ${newer("state")}`;
  // Name edits and ordinary messages do not imply a state transition (or vice versa).
  app.store.run(
    `INSERT INTO telegram_known_topics(chat,user,messageThreadId,name,closed,nameUpdateId,nameBotId,nameDate,stateUpdateId,stateBotId,stateDate) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat,user,messageThreadId) DO UPDATE SET
      name=CASE WHEN ${nameChanged} THEN excluded.name ELSE telegram_known_topics.name END,
      nameUpdateId=CASE WHEN ${nameChanged} THEN excluded.nameUpdateId ELSE telegram_known_topics.nameUpdateId END,
      nameBotId=CASE WHEN ${nameChanged} THEN excluded.nameBotId ELSE telegram_known_topics.nameBotId END,
      nameDate=CASE WHEN ${nameChanged} THEN excluded.nameDate ELSE telegram_known_topics.nameDate END,
      closed=CASE WHEN ${stateChanged} THEN excluded.closed ELSE telegram_known_topics.closed END,
      stateUpdateId=CASE WHEN ${stateChanged} THEN excluded.stateUpdateId ELSE telegram_known_topics.stateUpdateId END,
      stateBotId=CASE WHEN ${stateChanged} THEN excluded.stateBotId ELSE telegram_known_topics.stateBotId END,
      stateDate=CASE WHEN ${stateChanged} THEN excluded.stateDate ELSE telegram_known_topics.stateDate END`,
    owner.chat,
    owner.user,
    owner.messageThreadId,
    safeName ?? null,
    closed,
    safeName === undefined ? -1 : updateId,
    safeName === undefined ? null : botId,
    safeName === undefined ? 0 : date,
    closed === null ? -1 : updateId,
    closed === null ? null : botId,
    closed === null ? 0 : date,
  );
  syncTopicTitle(app, owner);
}

/** Persist the observed canonical name without making another external edit. */
export function syncTopicTitle(app: Runtime, owner: TelegramOwner) {
  const name = app.store.get<{ name: string | null }>(
    "SELECT name FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=?",
    owner.chat,
    owner.user,
    owner.messageThreadId ?? null,
  )?.name;
  if (!name) return;
  const ids = app.store.all<{ conversationId: string }>(
    "SELECT d.conversationId FROM telegram_conversations d JOIN telegram_topic_conversations p ON p.conversationId=d.conversationId WHERE d.chat=? AND d.user=? AND p.messageThreadId=?",
    owner.chat,
    owner.user,
    owner.messageThreadId!,
  );
  for (const { conversationId } of ids) {
    app.store.run(
      "UPDATE conversations SET title=? WHERE id=?",
      name,
      conversationId,
    );
    app.store.run(
      "INSERT OR IGNORE INTO conversation_titles VALUES (?)",
      conversationId,
    );
  }
}
export function knownTopics(app: Runtime, owner: TelegramOwner) {
  app.telegramChats.binding(owner);
  const rows = app.store.all<{
    id: string;
    title: string;
    messageThreadId: number | null;
    name: string | null;
    closed: number | null;
  }>(
    `SELECT c.id,c.title,p.messageThreadId,k.name,k.closed FROM conversations c JOIN telegram_conversations d ON d.conversationId=c.id JOIN telegram_grants g ON g.conversationId=c.id AND g.chat=d.chat AND g.user=d.user LEFT JOIN telegram_topic_conversations p ON p.conversationId=c.id LEFT JOIN telegram_known_topics k ON k.chat=d.chat AND k.user=d.user AND k.messageThreadId=p.messageThreadId WHERE d.chat=? AND d.user=? AND COALESCE(k.closed,0)=0 AND c.id NOT IN (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL) ORDER BY c.rowid DESC`,
    owner.chat,
    owner.user,
  );
  const topics = new Map<number | string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = row.messageThreadId ?? row.id;
    const selected = app.telegramChats.selection({
      ...owner,
      messageThreadId: row.messageThreadId ?? undefined,
    });
    if (!topics.has(key) || row.id === selected) topics.set(key, row);
  }
  const result = [...topics.values()].map((row) => ({
    id: row.id,
    title: row.title,
    messageThreadId: row.messageThreadId,
    name: row.name,
    state: row.closed === null ? "observado" : "aberto observado",
  }));
  const empty = app.store.all<{
    messageThreadId: number;
    name: string | null;
    closed: number | null;
  }>(
    `SELECT k.messageThreadId,k.name,k.closed FROM telegram_known_topics k WHERE k.chat=? AND k.user=? AND COALESCE(k.closed,0)=0 AND NOT EXISTS (SELECT 1 FROM telegram_topic_conversations p JOIN telegram_conversations d ON d.conversationId=p.conversationId WHERE d.chat=k.chat AND d.user=k.user AND p.messageThreadId=k.messageThreadId) AND NOT EXISTS (SELECT 1 FROM telegram_topic_selection s WHERE s.chat=k.chat AND s.user=k.user AND s.messageThreadId=k.messageThreadId) ORDER BY k.rowid DESC`,
    owner.chat,
    owner.user,
  );
  return [
    ...result,
    ...empty.map((row) => ({
      id: "",
      title: "Sem conversa Pi",
      messageThreadId: row.messageThreadId,
      name: row.name,
      state: row.closed === null ? "observado" : "aberto observado",
    })),
  ];
}
export function queueTopicsControl(
  app: Runtime,
  owner: TelegramOwner,
  id: string,
  prefix: string,
) {
  const rows = knownTopics(app, owner);
  if (
    app.store.get(
      "SELECT 1 FROM deliveries WHERE id>=? AND id<?",
      ...childIds(prefix),
    )
  )
    return rows;
  const controls: TelegramReplyMarkup["inline_keyboard"] = [];
  const shown = rows.slice(0, 50);
  app.store.savepoint("telegram_topics_menu", () => {
    for (const row of shown) {
      const targetOwner = {
        chat: owner.chat,
        user: owner.user,
        ...(row.messageThreadId === null
          ? {}
          : { messageThreadId: row.messageThreadId }),
      };
      controls.push([
        {
          text: `${row.messageThreadId === null ? "Sem tópico" : (row.name ?? `Tópico ${row.messageThreadId}`)} · ${row.title}`.slice(
            0,
            120,
          ),
          callback_data: button(app, {
            kind: "topic",
            owner: targetOwner,
            originThreadId: owner.messageThreadId ?? null,
            conversationId: row.id,
          }),
        },
      ]);
    }
    const text =
      "Tópicos Telegram conhecidos neste chat (registros locais; não é um inventário completo):\n" +
      (shown
        .map(
          (r) =>
            `${r.messageThreadId === null ? "Sem tópico" : (r.name ?? `Tópico ${r.messageThreadId}`)} · ${r.title} · ${r.state}`,
        )
        .join("\n") || "Nenhum tópico ou conversa Telegram disponível.") +
      (rows.length > shown.length
        ? "\nMostrando os 50 mais recentes. Use /topics ID dentro do tópico para escolher outra conversa."
        : "") +
      "\nO botão seleciona a conversa dentro do tópico indicado. Abra esse tópico no Telegram para continuar. /topics new TÍTULO ou /new cria uma conversa Pi no tópico atual; não cria um tópico nativo.";
    queueControl(app, prefix, owner, id, text, { inline_keyboard: controls });
  });
  return rows;
}

/** Controls and menu snapshots are application-owned; deletion never retains their titles/routes. */
export function discardTelegramControls(
  store: Store,
  id: string,
  permanent = false,
) {
  const route = store.get<TelegramOwner>(
    "SELECT d.chat,d.user,p.messageThreadId FROM telegram_conversations d LEFT JOIN telegram_topic_conversations p ON p.conversationId=d.conversationId WHERE d.conversationId=?",
    id,
  );
  const routeKey = route
    ? topicRouteKey({
        ...route,
        messageThreadId: route.messageThreadId ?? undefined,
      })
    : "";
  const rows = store.all<{ deliveryId: string }>(
    "SELECT deliveryId FROM telegram_control_parts WHERE conversationId IN (?,?) UNION SELECT deliveryId FROM delivery_conversations WHERE conversationId=?",
    id,
    routeKey,
    id,
  );

  for (const row of rows) {
    store.run(
      "UPDATE deliveries SET state='cancelled',result='Conversa excluída antes do envio.' WHERE id=? AND state='pending'",
      row.deliveryId,
    );
    if (!permanent) continue;
    const cron = store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      `telegram:cron-delivery:${row.deliveryId}`,
    );
    if (cron) {
      const menuId = (JSON.parse(cron.value) as { menuId: string }).menuId;
      store.run(
        "DELETE FROM meta WHERE key=? OR (key GLOB 'telegram:button:*' AND json_extract(value,'$.cronMenu.id')=?) OR (key GLOB 'telegram:cron-prompt:*' AND json_extract(value,'$.menuId')=?)",
        `telegram:cron-menu:${menuId}`,
        menuId,
        menuId,
      );
    }
    for (const prefix of [
      "telegram:cron-delivery:",
      "telegram:cron-prompt:",
      "telegram:force-reply:",
    ])
      store.run("DELETE FROM meta WHERE key=?", `${prefix}${row.deliveryId}`);
    const markup = store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      `telegram:markup:${row.deliveryId}`,
    );
    if (markup)
      for (const control of (
        JSON.parse(markup.value) as TelegramReplyMarkup
      ).inline_keyboard.flat())
        if (control.callback_data)
          store.run(
            "DELETE FROM meta WHERE key=?",
            `telegram:button:${control.callback_data}`,
          );
    store.run(
      "DELETE FROM meta WHERE key=?",
      `telegram:markup:${row.deliveryId}`,
    );
    const update = /^telegram:topics:(\d+):/.exec(row.deliveryId);
    if (update) {
      store.run(
        "INSERT OR IGNORE INTO telegram_purged_updates VALUES (?)",
        Number(update[1]),
      );
      store.run("DELETE FROM meta WHERE key=?", `telegram:update:${update[1]}`);
    }
    store.run("DELETE FROM deliveries WHERE id=?", row.deliveryId);
    store.run(
      "DELETE FROM telegram_delivery_scopes WHERE deliveryId=?",
      row.deliveryId,
    );
    store.run(
      "DELETE FROM telegram_delivery_resolutions WHERE deliveryId=?",
      row.deliveryId,
    );
    store.run(
      "DELETE FROM meta WHERE key=?",
      `telegram:control-route:${row.deliveryId}`,
    );
    store.run(
      "DELETE FROM delivery_conversations WHERE deliveryId=?",
      row.deliveryId,
    );
    store.run(
      "DELETE FROM telegram_control_parts WHERE deliveryId=?",
      row.deliveryId,
    );
  }
  if (permanent) {
    store.run(
      "DELETE FROM meta WHERE (key GLOB 'telegram:model-menu:*' OR key GLOB 'telegram:cron-menu:*' OR key GLOB 'telegram:cron-prompt:*') AND CASE WHEN json_valid(value) THEN json_extract(value,'$.conversationId')=? ELSE 0 END",
      id,
    );
    store.run(
      "DELETE FROM meta WHERE key GLOB 'telegram:button:*' AND CASE WHEN json_valid(value) THEN json_extract(value,'$.conversationId')=? ELSE 0 END",
      id,
    );
    if (route)
      store.run(
        "DELETE FROM meta WHERE key GLOB 'telegram:button:*' AND CASE WHEN json_valid(value) THEN json_extract(value,'$.owner.chat')=? AND json_extract(value,'$.owner.user')=? AND json_extract(value,'$.owner.messageThreadId') IS ? ELSE 0 END",
        route.chat,
        route.user,
        route.messageThreadId ?? null,
      );
    store.run(
      `DELETE FROM telegram_known_topics WHERE (chat,user,messageThreadId) IN (SELECT d.chat,d.user,p.messageThreadId FROM telegram_conversations d JOIN telegram_topic_conversations p ON p.conversationId=d.conversationId WHERE d.conversationId=?) AND NOT EXISTS (SELECT 1 FROM telegram_conversations d JOIN telegram_topic_conversations p ON p.conversationId=d.conversationId WHERE d.chat=telegram_known_topics.chat AND d.user=telegram_known_topics.user AND p.messageThreadId=telegram_known_topics.messageThreadId AND d.conversationId!=?)`,
      id,
      id,
    );
    if (
      route?.messageThreadId != null &&
      !store.get(
        `SELECT 1 FROM telegram_conversations d JOIN telegram_topic_conversations p ON p.conversationId=d.conversationId WHERE d.chat=? AND d.user=? AND p.messageThreadId=? AND d.conversationId!=?`,
        route.chat,
        route.user,
        route.messageThreadId,
        id,
      )
    )
      // Retain only a terminal marker: old creation events cannot reapply an
      // edit, but the last purged history must leave no title or destination.
      store.run(
        `UPDATE meta SET value='{"state":"cancelled"}' WHERE key GLOB 'telegram:topic-title:*' AND CASE WHEN json_valid(value) THEN json_extract(value,'$.route.chat')=? AND json_extract(value,'$.route.user')=? AND json_extract(value,'$.route.messageThreadId')=? ELSE 0 END`,
        route.chat,
        route.user,
        route.messageThreadId,
      );
  }
}
