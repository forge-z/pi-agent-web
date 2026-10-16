# Gerenciar crons no Telegram / Manage crons in Telegram

## PT-BR

Envie `/crons` no chat privado do bot, com ou sem tópico. O menu lista os agendamentos das conversas Telegram autorizadas deste usuário/chat, inclusive de outros tópicos e execuções únicas. Agendas de conversas web não aparecem. Agendas legadas classificadas como Telegram continuam disponíveis, mesmo com origem antiga nula; nenhum histórico, binding ou grant é recriado.

- Abra um agendamento para consultar instrução, agenda, fuso, estado, próxima ocorrência e entrega salva. Instruções longas têm prévia abreviada.
- **Pausar** e **Retomar** alteram somente a ativação. Retomar permite as próximas ocorrências normais do agendador; o menu não oferece “executar agora”.
- **Editar…** permite título, instrução, agenda e fuso. Responda diretamente à mensagem específica do bot, confira a prévia e toque **Confirmar alteração**. Respostas antigas, respostas em outro tópico e mensagens comuns não preenchem o formulário. `/crons` encerra a edição anterior daquele tópico e abre outro menu, inclusive quando enviado como resposta ao pedido de edição. Esse comando de saída tem precedência; outros textos iniciados com `/` permanecem dados da edição. A instrução não pode ser alterada enquanto houver ocorrência pendente, preservando a instrução já reclamada.
- **Excluir…** exige uma segunda confirmação. A exclusão é lógica: preserva conversa, histórico e ocorrências já admitidas. **Cancelar** mantém o agendamento.

As edições não mudam conversa, tipo, origem, bot, chat, usuário, tópico nem política de entrega. O destino é o salvo na tarefa, independentemente do tópico onde o menu foi aberto. Uma agenda pausada permanece pausada ao editar. Agenda usa cron de cinco campos ou data ISO futura com Z/offset para execução única; fuso usa nome IANA, como `America/Sao_Paulo` ou `UTC`.

Menus expiram em 15 minutos. Os botões são opacos e vinculados ao usuário, chat, tópico, bot/conexão, autorização e versão do agendamento. Revogação seguida de novo grant não reativa botões antigos. Mudança de seleção ou tarefa exige reabrir o menu; entregas pendentes revalidam também as conversas consultadas. Edição de mensagem falha usa uma nova mensagem, sem repetir a mutação. Recibos persistidos permitem confirmar uma edição depois de reiniciar, dentro da validade e com as mesmas autorizações. O menu funciona durante uma intervenção CUA; não altera a intervenção.

Nenhum cron real foi executado ou alterado na validação: testes usam SQLite temporário, relógio controlado quando necessário e transportes simulados.

## English

Send `/crons` in the bot's private chat, inside or outside a topic. The menu lists authorized Telegram conversation schedules for this user/chat, including other topics and one-time schedules. Web conversation schedules are excluded. Conservatively classified legacy Telegram schedules remain available even when old origin metadata is null; histories, bindings and grants are preserved.

Open a schedule to inspect its instructions, schedule, timezone, state, next occurrence and saved delivery policy. Long instructions are abbreviated. **Pause/Resume** changes activation only; resuming allows normal future scheduler activity and there is no run-now button. **Edit…** supports title, instructions, schedule and timezone: reply to the exact bot prompt, inspect the preview and confirm. Ordinary messages, replies in another topic and old prompts cannot populate the edit. `/crons` cancels the previous menu in that topic even when sent as a reply to the edit prompt; this exit command takes precedence, while other slash-prefixed edit text remains data. Instruction changes are refused while an occurrence is pending, preserving its claimed instructions. **Delete…** requires confirmation and soft-deletes the schedule while preserving conversation history and admitted occurrences; cancel keeps it.

Edits retain the conversation, kind, origin and frozen bot/chat/user/topic/delivery policy. The menu's topic never becomes the delivery destination. Paused schedules stay paused when edited. Cron expressions require five fields; one-time dates must be future ISO timestamps with Z/offset; timezones must be IANA names.

Menus expire after 15 minutes. Opaque buttons bind the owner, source topic, bot/connection, grants and task version. Revocation/regrant, selection changes and stale tasks invalidate controls. Pending deliveries revalidate every consulted conversation. Failed message edits fall back without repeating mutations. Durable receipts support a restart within the original expiry and authorization. Cron management remains available during CUA handoff without changing its state. Tests use temporary databases and fake transports; no production cron was run or changed.
