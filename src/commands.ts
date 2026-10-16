import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import type { TaskId, CompactionResult } from "@earendil-works/pi-durable";
import type { Runtime } from "./runtime.js";
import { SettingsError } from "./settings.js";

export type CommandAccess =
  | { source: "web" }
  | {
      source: "telegram";
      user: string;
      chat: string;
      messageThreadId?: number;
    };
export class CommandError extends Error {}
export const commandCatalog = [
  {
    name: "default",
    usage: "/default [PROVIDER MODELO ESFORÇO]",
    description: "Consultar ou salvar o padrão para novas conversas",
  },
  {
    name: "topics",
    usage: "/topics [new TÍTULO|ID]",
    description: "Listar tópicos conhecidos e gerenciar conversas Telegram",
  },
  {
    name: "agents",
    usage: "/agents [id]",
    description: "Listar ou selecionar conversas existentes",
  },
  {
    name: "model",
    usage: "/model [id]",
    description: "Escolher provedor e modelo da conversa",
  },
  {
    name: "thinking",
    usage: "/thinking [esforço]",
    description: "Consultar ou mudar o esforço de raciocínio",
  },
  {
    name: "compact",
    usage: "/compact [instruções]",
    description: "Compactar o contexto preservando o histórico",
  },
  {
    name: "tasks",
    usage: "/tasks",
    description: "Acompanhar execuções ativas do Pi",
  },
  { name: "crons", usage: "/crons", description: "Gerenciar agendamentos" },
  {
    name: "stop",
    usage: "/stop",
    description: "Interromper a execução e a fila atuais",
  },
  {
    name: "help",
    usage: "/help",
    description: "Consultar os comandos disponíveis",
  },
] as const;
export const webCommandCatalog = commandCatalog.filter(
  (entry) => entry.name !== "topics",
);
export interface CommandResult {
  kind: "command";
  command: string;
  conversationId: string;
  text: string;
  data?: unknown;
  status?: string;
  taskId?: TaskId<CompactionResult>;
}
type Receipt = {
  key: string;
  conversationId: string;
  requestId: string;
  text: string;
  state: string;
  result: string | null;
};

export function parseCommand(text: string) {
  const value = text.trim();
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(value);
  const definition = commandCatalog.find(
    (entry) => entry.name === (match?.[1] === "chats" ? "topics" : match?.[1]),
  );
  if (!definition)
    throw new CommandError(
      "Comando desconhecido. Use /help ou // para enviar uma barra literal.",
    );
  const argument = match?.[2]?.trim() ?? "";
  if (
    (["tasks", "crons", "stop", "help"].includes(definition.name) &&
      argument) ||
    (["agents", "model", "thinking"].includes(definition.name) &&
      /\s/.test(argument))
  )
    throw new CommandError(`Uso: ${definition.usage}`);
  return { name: definition.name, argument };
}

/** Commands without effects can always be answered again; they never need a pending receipt. */
function readOnlyCommand(
  command: { name: string; argument: string },
  source: CommandAccess["source"],
) {
  switch (command.name) {
    case "help":
    case "tasks":
    case "crons":
      return true;
    case "model":
    case "thinking":
    case "default":
    case "topics":
      return !command.argument;
    case "agents":
      return !command.argument || source === "web";
    default:
      return false;
  }
}

/** Transport commands around the public Durable API; no Coding Agent registry is inherited. */
export class Commands {
  private work = new Map<string, Promise<CommandResult>>();
  private inputs = new Map<string, { id: string; text: string }>();
  private tails = new Map<string, Promise<unknown>>();
  constructor(private app: Runtime) {
    // Earlier versions left read-only receipts uncertain after a failure or
    // restart, which blocked deleting the conversation with nothing to verify.
    for (const row of app.store.all<{ key: string; text: string }>(
      "SELECT key,text FROM command_receipts WHERE state='uncertain'",
    )) {
      let parsed: ReturnType<typeof parseCommand>;
      try {
        parsed = parseCommand(row.text);
      } catch {
        continue;
      }
      if (
        parsed &&
        readOnlyCommand(parsed, row.key.startsWith("web:") ? "web" : "telegram")
      )
        app.store.run(
          "UPDATE command_receipts SET state='done' WHERE key=? AND state='uncertain'",
          row.key,
        );
    }
  }
  key(id: string, requestId: string, access: CommandAccess) {
    return access.source === "web"
      ? `web:${id}:${requestId}`
      : `telegram:${access.chat}:${access.user}:${access.messageThreadId === undefined ? "" : `topic:${access.messageThreadId}:`}${requestId}`;
  }
  allowed(access: CommandAccess) {
    const rows = this.app.store.all<{ id: string; title: string }>(
      access.source === "web"
        ? "SELECT id,title FROM conversations WHERE id NOT IN (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL) ORDER BY rowid DESC"
        : "SELECT c.id,c.title FROM conversations c JOIN telegram_grants g ON g.conversationId=c.id WHERE g.chat=? AND g.user=? AND c.id NOT IN (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL) ORDER BY c.rowid DESC",
      ...(access.source === "web" ? [] : [access.chat, access.user]),
    );
    return rows.filter((row) => {
      if (access.source === "web")
        return !this.app.isTelegramConversation(row.id);
      if (!this.app.telegramChats.dedicated(row.id))
        return access.messageThreadId === undefined;
      if (!this.app.telegramChats.owns(row.id, access)) return false;
      try {
        this.app.telegramChats.authorize(row.id, access);
        return true;
      } catch {
        return false;
      }
    });
  }
  authorize(id: string, access: CommandAccess) {
    if (access.source === "web") this.app.assertWebWritable(id);
    if (
      access.source === "telegram" &&
      this.app.telegramChats.dedicated(id) &&
      this.app.telegramChats.owns(id, access)
    )
      // A listing may omit temporarily unavailable rows. An admission must
      // preserve the actual error so polling can retry rather than reject it.
      this.app.telegramChats.authorize(id, access);
    if (!this.allowed(access).some((item) => item.id === id))
      throw new CommandError(
        "Conversa não autorizada. Vincule-a pela web com /link CODIGO.",
      );
    this.app.assertConversationAvailable(id);
  }
  busy(id: string) {
    return [...this.inputs.values()].some((input) => input.id === id);
  }
  authorizeInput(id: string, access: CommandAccess, text: string) {
    // Empty topics may manage selection through the existing binding, without
    // authorizing its history or settings.
    if (
      access.source === "telegram" &&
      /^\/(?:topics|chats)(?:\s|$)/.test(text.trim()) &&
      this.app.telegramChats.creationAuthority(access) === id
    )
      return;
    this.authorize(id, access);
  }
  async active(access: CommandAccess) {
    const ids = new Set(this.allowed(access).map((item) => item.id));
    const inspection = await this.app.harness.inspect(context);
    return inspection.tasks
      .filter(({ record }) => ids.has(String(record.conversationId)))
      .map(({ record, state }) => ({
        id: String(record.id),
        kind: record.kind,
        conversationId: String(record.conversationId),
        background: record.background,
        abortRequested: record.abortRequested,
        status: record.state.status,
        phase: state.kind,
      }));
  }
  private row(key: string) {
    return this.app.store.get<Receipt>(
      "SELECT * FROM command_receipts WHERE key=?",
      key,
    );
  }
  private result(row: Receipt): CommandResult {
    return row.result
      ? (JSON.parse(row.result) as CommandResult)
      : {
          kind: "command",
          command: parseCommand(row.text)!.name,
          conversationId: row.conversationId,
          status: "uncertain",
          text: "Resultado incerto após interrupção. Verifique a conversa; este comando não será repetido automaticamente.",
        };
  }
  async receipt(id: string, requestId: string, access: CommandAccess) {
    this.authorize(id, access);
    const row = this.row(this.key(id, requestId, access));
    if (!row || row.conversationId !== id) return undefined;
    const result = this.result(row);
    if (result.command !== "compact" || !result.taskId) return result;
    const task = await this.app.harness.getTask(result.taskId, context);
    if (!task || String(task.conversationId) !== id)
      return {
        ...result,
        status: "uncertain",
        text: "A tarefa de compactação não pôde ser verificada. Não foi repetida.",
      };
    const status =
      task.state.status === "terminal"
        ? task.state.outcome.status
        : task.state.status;
    if (
      task.state.status === "terminal" &&
      task.state.outcome.status === "completed" &&
      !task.state.outcome.result.entryId
    )
      return {
        ...result,
        status: "noop",
        text: "Não havia contexto suficiente para compactar. Nenhum resumo foi criado; o histórico foi preservado.",
      };
    return {
      ...result,
      status,
      text: `Compactação ${status} · tarefa ${result.taskId}. O histórico da conversa permanece disponível.`,
    };
  }
  execute(
    id: string,
    requestId: string,
    text: string,
    access: CommandAccess,
  ): Promise<CommandResult> {
    this.authorizeInput(id, access, text);
    const parsed = parseCommand(text)!;
    if (parsed.name === "topics" && access.source !== "telegram")
      throw new CommandError(
        "Use /topics no Telegram para gerenciar suas conversas exclusivas.",
      );
    const key = this.key(id, requestId, access);
    const existing = this.row(key);
    if (existing) {
      this.authorizeInput(existing.conversationId, access, text);
      if (
        existing.text !== text ||
        (access.source === "web" && existing.conversationId !== id)
      )
        throw new CommandError("requestId já utilizado com conteúdo diferente");
      const result = this.result(existing);
      this.authorizeInput(result.conversationId, access, text);
      const pending = this.work.get(key);
      if (!pending && access.source === "telegram")
        this.deliver(
          requestId,
          access.chat,
          result.text,
          result.conversationId,
          access.messageThreadId,
        );
      return pending ?? Promise.resolve(result);
    }
    const running = this.inputs.get(key);
    if (running) {
      if (running.text !== text || running.id !== id)
        throw new CommandError("requestId já utilizado com conteúdo diferente");
      return this.work.get(key)!;
    }
    if (
      this.app.store.get(
        "SELECT 1 FROM command_receipts WHERE conversationId=? AND requestId=?",
        id,
        requestId,
      )
    )
      throw new CommandError("requestId já utilizado por outro comando");
    if (
      this.app.store.get(
        "SELECT 1 FROM requests WHERE conversationId=? AND requestId=?",
        id,
        requestId,
      )
    )
      throw new CommandError("requestId já utilizado por uma mensagem");
    const operation = async () => {
      const receipt = this.row(key);
      if (receipt) return this.result(receipt);
      const base: CommandResult = {
        kind: "command",
        command: parsed.name,
        conversationId: id,
        text: "",
      };
      const current =
        parsed.name === "model" ||
        parsed.name === "thinking" ||
        parsed.name === "compact"
          ? await this.app.settings.conversation(id)
          : undefined;
      let setting:
        { provider: string; modelId: string; effort: string } | undefined;
      if (parsed.name === "model" && parsed.argument) {
        const model = this.app.models.getModel(
          current!.provider,
          parsed.argument,
        );
        if (!model)
          throw new SettingsError("Modelo não disponível no catálogo do Pi");
        setting = {
          provider: current!.provider,
          modelId: model.id,
          effort: clampThinkingLevel(model, current!.effort),
        };
      }
      if (parsed.name === "thinking" && parsed.argument)
        setting = {
          provider: current!.provider,
          modelId: current!.modelId,
          effort: parsed.argument,
        };
      if (setting) this.app.settings.validate(setting);
      if (
        parsed.name === "compact" &&
        this.app.options.mode === "live" &&
        !this.app.options.models &&
        !(await this.app.models.checkAuth(current!.provider))
      )
        throw new SettingsError(
          "Conecte o provider desta conversa antes de compactar o contexto",
        );
      if (parsed.name === "agents" && parsed.argument) {
        if (
          access.source === "telegram" &&
          !this.app.isTelegramConversation(parsed.argument)
        )
          throw new CommandError(
            "Selecione uma conversa Telegram. Use /topics.",
          );
        this.authorize(parsed.argument, access);
        await this.app.conversation(parsed.argument);
        // The target can be archived while Durable resolves its conversation.
        // Recheck before writing a receipt or admitting any selection effect.
        this.authorize(parsed.argument, access);
      }
      let chatTitle: string | undefined;
      let chatTarget: string | undefined;
      if (parsed.name === "topics") {
        if (access.source !== "telegram")
          throw new CommandError("Use /topics no Telegram.");
        this.app.telegramChats.creationAuthority(access);
        const newChat = /^new(?:\s+([\s\S]+))?$/.exec(parsed.argument);
        if (newChat) {
          chatTitle = newChat[1]?.trim() || "Conversa Telegram";
          if (
            chatTitle.length > 100 ||
            /[\u0000-\u001f\u007f-\u009f]/.test(chatTitle)
          )
            throw new CommandError(
              "Título inválido: use de 1 a 100 caracteres, sem quebras de linha.",
            );
        } else if (parsed.argument) {
          if (!/^[1-9][0-9]{0,15}$/.test(parsed.argument))
            throw new CommandError("Uso: /topics [new TÍTULO|ID]");
          this.app.telegramChats.authorize(parsed.argument, access);
          await this.app.conversation(parsed.argument);
          this.app.telegramChats.authorize(parsed.argument, access);
          chatTarget = parsed.argument;
        }
      }
      let selection: string | undefined;
      const readOnly = readOnlyCommand(parsed, access.source);
      if (!readOnly)
        this.app.store.run(
          "INSERT INTO command_receipts(key,conversationId,requestId,text,state) VALUES (?,?,?,?,'pending')",
          key,
          id,
          requestId,
          text,
        );
      try {
        if (parsed.name === "default") {
          const parts = parsed.argument.split(/\s+/);
          if (parsed.argument && parts.length !== 3)
            throw new SettingsError("Uso: /default [PROVIDER MODELO ESFORÇO]");
          const saved = parsed.argument
            ? this.app.settings.saveDefaults({
                provider: parts[0],
                modelId: parts[1],
                effort: parts[2],
              })
            : this.app.settings.defaults();
          base.data = saved;
          base.text = `Padrão para novas conversas (web e Telegram): ${saved.provider} ${saved.modelId} ${saved.effort}. Conversas existentes mantêm seus modelos. Use /default PROVIDER MODELO ESFORÇO para salvar; /model e /thinking alteram apenas esta conversa.`;
        } else if (setting) {
          const saved = await this.app.settings.saveConversation(id, setting);
          base.data = saved;
          base.text = `Modelo: ${saved.modelId}. Esforço: ${saved.effort}.`;
        } else
          switch (parsed.name) {
            case "help":
              base.data =
                access.source === "telegram"
                  ? commandCatalog
                  : webCommandCatalog;
              base.text =
                (access.source === "telegram"
                  ? commandCatalog
                  : webCommandCatalog
                )
                  .map((entry) => `${entry.usage} — ${entry.description}`)
                  .join("\n") +
                "\n//texto envia uma barra literal. /agents não cria agentes; /stop preserva os agendamentos futuros." +
                (access.source === "telegram"
                  ? "\n/new [TÍTULO] cria e seleciona uma nova conversa Telegram; também pode usar /topics new [TÍTULO]. /topics lista tópicos conhecidos deste chat. /cua mostra os controles humanos CUA, inclusive durante a pausa. /chats permanece como alias local compatível, fora do menu."
                  : "");
              break;
            case "topics": {
              if (access.source !== "telegram")
                throw new CommandError("Use /topics no Telegram.");
              if (chatTitle)
                chatTarget = await this.app.create(chatTitle, access);
              if (chatTarget) {
                this.app.assertHandoffAvailable(id);
                this.app.telegramChats.authorize(chatTarget, access);
                selection = chatTarget;
                base.conversationId = chatTarget;
              }
              const conversations = this.app.telegramChats.list(access);
              base.data = conversations;
              const current =
                chatTarget ?? this.app.telegramChats.selection(access);
              base.text =
                (chatTarget
                  ? `Conversa Telegram selecionada: ${chatTarget}.\n`
                  : "Conversas Telegram:\n") +
                (conversations
                  .map(
                    (c) =>
                      `${c.id === current ? "→ " : ""}${c.id} · ${c.title}`,
                  )
                  .join("\n") || "Nenhuma conversa Telegram criada.") +
                "\n/new [TÍTULO] ou /topics new [TÍTULO] cria uma conversa; /topics ID seleciona. O histórico anterior permanece no canal de origem. As próximas mensagens usam contexto exclusivo do Telegram.";
              break;
            }
            case "agents": {
              const conversations = this.allowed(access).filter(
                (conversation) =>
                  access.source === "web" ||
                  this.app.isTelegramConversation(conversation.id),
              );
              base.data = conversations;
              if (parsed.argument) {
                if (access.source === "telegram") {
                  this.app.store.savepoint("agent_selection", () => {
                    this.authorize(parsed.argument, access);
                    if (this.app.telegramChats.dedicated(parsed.argument)) {
                      this.app.telegramChats.authorize(parsed.argument, access);
                      selection = parsed.argument;
                    } else
                      this.app.store.run(
                        "UPDATE telegram SET conversationId=? WHERE chat=? AND user=?",
                        parsed.argument,
                        access.chat,
                        access.user,
                      );
                  });
                }
                base.conversationId = parsed.argument;
                base.text = `Conversa selecionada: ${parsed.argument} · ${conversations.find((entry) => entry.id === parsed.argument)!.title}`;
              } else
                base.text =
                  conversations
                    .map((entry) => `${entry.id} · ${entry.title}`)
                    .join("\n") +
                  "\nSelecione com /agents ID. Outras conversas precisam ser vinculadas com /link pela web.";
              break;
            }
            case "model":
            case "thinking": {
              const models = this.app.settings.catalog(current!.provider);
              base.data = { current, models };
              base.text =
                parsed.name === "model"
                  ? `Atual: ${current!.modelId}.\n` +
                    models
                      .map((model) => `${model.id} · ${model.name}`)
                      .join("\n") +
                    "\nUse /model ID."
                  : `Atual: ${current!.effort}. Suportados: ${models.find((model) => model.id === current!.modelId)?.efforts.join(", ") ?? "nenhum"}. Use /thinking ESFORÇO.`;
              break;
            }
            case "tasks": {
              const tasks = await this.active(access);
              base.data = tasks;
              base.text = tasks.length
                ? tasks
                    .map(
                      (task) =>
                        `${task.id} · ${task.kind} · ${task.status} · conversa ${task.conversationId}`,
                    )
                    .join("\n")
                : "Nenhuma execução ativa no Pi.";
              break;
            }
            case "crons": {
              const ids = new Set(this.allowed(access).map((item) => item.id));
              const tasks = this.app.tasks
                .list()
                .filter((task) => ids.has(task.conversationId));
              base.data = tasks;
              base.text = tasks.length
                ? tasks
                    .map(
                      (task) =>
                        `${task.title} · ${task.schedule} (${task.timezone}) · ${task.enabled ? "ativa" : "pausada"} · conversa ${task.conversationId}`,
                    )
                    .join("\n")
                : "Nenhum agendamento. Crie uma rotina pela conversa ou pelo painel Tarefas na web.";
              break;
            }
            case "compact": {
              const conversation = await this.app.conversation(id);
              base.taskId = await conversation.compact(
                parsed.argument || undefined,
                context,
              );
              base.status = "accepted";
              base.text = `Compactação admitida · tarefa ${base.taskId}. Consulte o estado; o histórico será preservado.`;
              break;
            }
            case "stop":
              await (await this.app.conversation(id)).abort(context);
              base.status = "completed";
              base.text =
                "Execução atual interrompida e entradas em fila retiradas. Agendamentos futuros preservados. Efeitos externos em andamento precisam ser verificados; não serão repetidos automaticamente.";
          }
        // Reply and acknowledgement commit together, before HTTP acknowledgement.
        this.app.store.db.exec("BEGIN IMMEDIATE");
        try {
          if (selection && access.source === "telegram") {
            this.app.assertHandoffAvailable(id);
            this.app.telegramChats.select(selection, access);
          }
          if (readOnly)
            this.app.store.run(
              "INSERT INTO command_receipts(key,conversationId,requestId,text,state,result) VALUES (?,?,?,?,'done',?)",
              key,
              id,
              requestId,
              text,
              JSON.stringify(base),
            );
          else
            this.app.store.run(
              "UPDATE command_receipts SET state='done',result=? WHERE key=?",
              JSON.stringify(base),
              key,
            );
          if (access.source === "telegram")
            this.deliver(
              requestId,
              access.chat,
              base.text,
              base.conversationId,
              access.messageThreadId,
            );
          this.app.store.db.exec("COMMIT");
        } catch (error) {
          this.app.store.db.exec("ROLLBACK");
          throw error;
        }
        return base;
      } catch (error) {
        if (readOnly) throw error;
        if (error instanceof SettingsError) {
          this.app.store.run("DELETE FROM command_receipts WHERE key=?", key);
          throw error;
        }
        this.app.store.run(
          "UPDATE command_receipts SET state='uncertain' WHERE key=?",
          key,
        );
        const result = this.result(this.row(key)!);
        if (access.source === "telegram")
          this.deliver(
            requestId,
            access.chat,
            result.text,
            result.conversationId,
            access.messageThreadId,
          );
        return result;
      }
    };
    const serial =
      parsed.name === "model" ||
      parsed.name === "thinking" ||
      parsed.name === "compact" ||
      parsed.name === "topics";
    const serialKey =
      parsed.name === "topics" && access.source === "telegram"
        ? `chats:${access.chat}:${access.user}:${access.messageThreadId ?? "legacy"}`
        : id;
    this.inputs.set(key, { id, text });
    const work = (
      serial
        ? (this.tails.get(serialKey) ?? Promise.resolve()).catch(() => {})
        : Promise.resolve()
    ).then(() =>
      parsed.name === "compact"
        ? this.app.withProviderAdmission(operation)
        : operation(),
    );
    if (serial) this.tails.set(serialKey, work);
    this.work.set(key, work);
    void work
      .finally(() => {
        this.work.delete(key);
        this.inputs.delete(key);
        if (this.tails.get(serialKey) === work) this.tails.delete(serialKey);
      })
      .catch(() => {});
    return work;
  }
  private deliver(
    requestId: string,
    chat: string,
    text: string,
    conversationId: string,
    messageThreadId?: number,
  ) {
    this.app.store.queueTelegram(
      `command:${requestId}`,
      chat,
      text,
      4000,
      conversationId,
      messageThreadId,
    );
  }
  async close() {
    await Promise.allSettled(this.work.values());
  }
}
