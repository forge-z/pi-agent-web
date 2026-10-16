export function renderTelegramDeliveries(deliveries, conversationId, ui) {
  const { node, t, text, errorText, api, refresh } = ui;
  const translated = (tag, render) => text(node(tag), render);
  return deliveries
    .filter((d) => ["sending", "uncertain", "failed"].includes(d.state))
    .map((d, index) => {
      const card = node("article", undefined, "action-card");
      const webInput = /:web-input:\d+$/.test(d.id);
      card.append(
        translated("p", () =>
          webInput
            ? t(
                d.state === "sending"
                  ? "Sua mensagem da web está sendo copiada para o Telegram. Aguarde a confirmação."
                  : d.state === "failed"
                    ? "O Telegram recusou a cópia da sua mensagem da web. Ela não foi enviada."
                    : "Não foi possível confirmar a cópia da sua mensagem da web no Telegram. Verifique lá antes de registrar a resolução; não haverá reenvio automático.",
              )
            : d.state === "sending"
              ? t("Entrega {0} em envio. Aguarde a conclusão.", [d.id])
              : d.state === "failed"
                ? t("Entrega {0} recusada pelo Telegram; não foi enviada.", [
                    d.id,
                  ])
                : t(
                    "Entrega {0} incerta. Verifique o Telegram; não será reenviada automaticamente.",
                    [d.id],
                  ),
        ),
      );
      if (d.blocksDeletion)
        card.append(
          translated("p", () =>
            t("Esta entrega bloqueia a exclusão da conversa."),
          ),
        );
      if (ui.readOnly || d.state !== "uncertain" || !d.canReconcile)
        return card;
      const form = node("form");
      const label = translated("label", () =>
        t("Resultado verificado no Telegram (até 2000 caracteres)"),
      );
      const note = node("textarea");
      note.id = `telegram-resolution-${index}`;
      note.required = true;
      note.maxLength = 2000;
      label.htmlFor = note.id;
      const confirmation = node("label");
      const checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.required = true;
      confirmation.append(
        checkbox,
        translated("span", () =>
          t(
            "Verifiquei o resultado e quero encerrar esta entrega sem reenviar.",
          ),
        ),
      );
      const error = node("p", undefined, "error");
      const submit = translated("button", () =>
        t("Registrar resolução sem reenvio"),
      );
      submit.type = "submit";
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (submit.disabled) return;
        if (!checkbox.checked || !note.value.trim()) {
          text(error, () =>
            t("Registre a verificação e confirme a resolução sem reenvio."),
          );
          return;
        }
        submit.disabled = true;
        try {
          await api(
            `/api/conversations/${encodeURIComponent(conversationId)}/deliveries/${encodeURIComponent(d.id)}/reconcile`,
            "POST",
            { note: note.value.trim(), confirm: true },
          );
          await refresh(conversationId);
        } catch (failure) {
          text(error, () => errorText(failure.message));
        } finally {
          submit.disabled = false;
        }
      };
      form.append(label, note, confirmation, error, submit);
      card.append(form);
      return card;
    });
}
