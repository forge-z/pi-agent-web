import { renderCuaHandoffs } from "/cua-handoffs.js";

// Receives only the isolated operational projection, never a conversation snapshot.
export function renderHumanControls(snapshot, conversation, ui) {
  const { node, t, api, refresh } = ui;
  const base = `/api/human-controls/${encodeURIComponent(conversation)}`;
  const cards = [];
  const label = (tag, source) => node(tag, t(source));
  function card(title) {
    const element = node("article", undefined, "action-card");
    element.append(node("h2", title));
    cards.push(element);
    return element;
  }
  function controls(element) {
    const error = node("p", "", "form-error");
    element.append(error);
    const buttons = [];
    let busy = false;
    const run = async (path, body) => {
      if (busy) return;
      busy = true;
      buttons.forEach((b) => (b.disabled = true));
      error.textContent = "";
      ui.busy?.(true);
      try {
        await api(
          base + path,
          "POST",
          typeof body === "function" ? body() : body,
        );
      } catch (failure) {
        error.textContent = failure.message;
      } finally {
        // A lost response may follow a committed decision; inspect, never retry it.
        try {
          await refresh();
        } catch (failure) {
          error.textContent = failure.message;
        }
        busy = false;
        ui.busy?.(false);
        buttons.forEach((b) => (b.disabled = false));
      }
    };
    return {
      run,
      button(source, path, body) {
        const button = label("button", source);
        button.type = "button";
        button.onclick = () => run(path, body);
        buttons.push(button);
        element.append(button);
        return button;
      },
    };
  }
  function reconcile(element, path, legacy = false) {
    const form = node("form", undefined, "management-form");
    const input = node("textarea");
    input.required = true;
    input.id = `human-note-${path.replaceAll("/", "-")}`;
    const title = label("label", "Resultado verificado no serviço externo");
    title.htmlFor = input.id;
    form.append(title, input);
    const actions = controls(form);
    const submit = actions.button("Registrar resultado", path, () => ({
      ...(legacy ? { decision: "reconcile" } : {}),
      note: input.value,
    }));
    submit.type = "submit";
    submit.onclick = undefined;
    form.onsubmit = (event) => {
      event.preventDefault();
      return actions.run(path, () => ({
        ...(legacy ? { decision: "reconcile" } : {}),
        note: input.value,
      }));
    };
    element.append(form);
  }
  for (const action of snapshot.actions) {
    const element = card(`${action.server} / ${action.tool}`);
    if (action.state === "pending") {
      element.append(
        label(
          "p",
          "Revise os detalhes. Esta ação só acontece com sua confirmação.",
        ),
        node("pre", action.args),
      );
      const actions = controls(element);
      actions.button("Confirmar ação", `/actions/${action.id}`, {
        decision: "approve",
      });
      actions.button("Recusar", `/actions/${action.id}`, { decision: "deny" });
    } else reconcile(element, `/actions/${action.id}`, true);
  }
  cards.push(
    ...renderCuaHandoffs(snapshot.cuaHandoffs, conversation, {
      ...ui,
      api: async (path, method, body) => {
        ui.busy?.(true);
        try {
          return await api(
            path.replace("/api/conversations/", "/api/human-controls/"),
            method,
            body,
          );
        } finally {
          ui.busy?.(false);
        }
      },
      refresh,
    }),
  );
  for (const interaction of snapshot.mcpInteractions) {
    const payload = JSON.parse(interaction.payload);
    const element = card(`${interaction.server} · ${t("Solicitação humana")}`);
    element.append(
      node("p", payload.message || t("O servidor MCP aguarda sua decisão.")),
    );
    if (interaction.kind === "url") {
      try {
        const url = new URL(payload.url);
        if (url.protocol === "https:" && !url.username && !url.password) {
          const link = label("a", "Abrir solicitação no serviço");
          link.href = url.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          element.append(link);
        }
      } catch {
        /* Unsafe links remain unavailable. */
      }
      if (payload.source === "url_required_error")
        element.append(
          label(
            "p",
            "Concluir esta etapa externa não confirma o resultado da ação. Confira o serviço e registre o resultado antes de continuar.",
          ),
        );
    }
    const form = node("form", undefined, "management-form");
    const inputs = [];
    const schema = payload.requestedSchema;
    if (interaction.kind === "form" && schema?.properties) {
      for (const [name, property] of Object.entries(schema.properties)) {
        const title = node("label", property.title || name);
        const input = node(
          Array.isArray(property.enum)
            ? "select"
            : ["array", "object"].includes(property.type)
              ? "textarea"
              : "input",
        );
        input.id = `human-mcp-${interaction.id}-${name}`;
        title.htmlFor = input.id;
        if (Array.isArray(property.enum)) {
          for (const value of property.enum) {
            const option = node("option", String(value));
            option.value = JSON.stringify(value);
            input.append(option);
            if (value === property.default) option.selected = true;
          }
        } else {
          if (!["array", "object"].includes(property.type))
            input.type =
              property.type === "boolean"
                ? "checkbox"
                : ["number", "integer"].includes(property.type)
                  ? "number"
                  : "text";
          if (property.type === "integer") input.step = "1";
          if (property.type === "number") input.step = "any";
          if (property.default !== undefined) {
            if (input.type === "checkbox") input.checked = property.default;
            else
              input.value = ["array", "object"].includes(property.type)
                ? JSON.stringify(property.default)
                : String(property.default);
          }
        }
        if (schema.required?.includes(name) && input.type !== "checkbox")
          input.required = true;
        form.append(title, input);
        if (property.description)
          form.append(node("small", property.description));
        inputs.push({ name, property, input });
      }
    }
    let custom;
    if (interaction.kind === "resume") {
      const title = label(
        "label",
        "Resposta ao formulário, se solicitada (JSON)",
      );
      custom = node("textarea");
      custom.id = `human-resume-${interaction.id}`;
      custom.value = "{}";
      title.htmlFor = custom.id;
      form.append(title, custom);
    }
    const actions = controls(form);
    const path = `/mcp-interactions/${interaction.id}`;
    const response = (action) => {
      let content;
      if (action === "accept") {
        if (custom) content = JSON.parse(custom.value || "{}");
        else if (inputs.length) {
          content = {};
          for (const { name, property, input } of inputs) {
            if (input.type === "checkbox") content[name] = input.checked;
            else if (input.value !== "")
              content[name] =
                Array.isArray(property.enum) ||
                ["array", "object"].includes(property.type)
                  ? JSON.parse(input.value)
                  : ["number", "integer"].includes(property.type)
                    ? Number(input.value)
                    : input.value;
          }
        }
      }
      return { action, ...(content ? { content } : {}) };
    };
    const submit = actions.button(
      payload.source === "url_required_error"
        ? "Concluí a etapa externa"
        : "Aceitar",
      path,
      () => response("accept"),
    );
    submit.type = "submit";
    submit.onclick = undefined;
    form.onsubmit = (event) => {
      event.preventDefault();
      return actions.run(path, () => response("accept"));
    };
    actions.button("Recusar", path, { action: "decline" });
    actions.button("Cancelar", path, { action: "cancel" });
    element.append(form);
  }
  for (const call of snapshot.mcpCalls) {
    const element = card(`${call.server} / ${call.tool}`);
    element.append(
      label(
        "p",
        "A chamada foi enviada, mas o efeito e o resultado não foram confirmados. Ela não será reenviada automaticamente. Verifique no serviço externo antes de registrar o resultado.",
      ),
    );
    reconcile(element, `/mcp-calls/${call.id}/reconcile`);
  }
  return cards;
}
