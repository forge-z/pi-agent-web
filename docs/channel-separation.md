# Canais separados e padrão persistido / Separate channels and saved defaults

## PT-BR

A web interage somente com conversas web. Conversas Telegram não aparecem na barra lateral, lixeira, busca, retomada, links diretos ou painel de agendas. O servidor nega o namespace `/api/conversations/:id` inteiro para IDs Telegram, incluindo snapshots, streams SSE, histórico JSON/texto/downloads, ações e todas as mutações. Listas e seus hashes SSE usam somente conversas web. Agendas Telegram e suas ocorrências ficam fora das consultas web; `/crons` no Telegram permite gerenciá-las. A referência de um anchor legado classificado Telegram é omitida do status web do bot, preservando o binding no banco.

**Controles humanos aprovados em 15/10/2026:** `/controls` no Telegram e os links CUA abrem `/human-controls?c=ID`, com documento e JavaScript próprios. A página exige login da instalação para consultar `/api/human-controls/:id`; não carrega o workspace, lista, título, histórico, mensagens, modelo ou compositor. Mostra apenas ações pendentes/incertas, formulários/permissões MCP pendentes, reconciliação de chamadas incertas e intervenções CUA não encerradas. Argumentos de ações pendentes e campos necessários do formulário são exibidos para decisão; evidências, resultados, respostas armazenadas, bindings e payload interno de retomada são excluídos. Tickets CUA vencidos não são expostos. A API não chama `Runtime.snapshot` e seus GETs não retomam execuções nem criam tickets.

Somente os POSTs exatos de decisão de ações, interação/reconciliação MCP e criação/devolução CUA são aceitos nessa API isolada. Eles mantêm sessão, Origin, escopo, permissões e validações dos serviços existentes, e retornam apenas `{ "ok": true }`, inclusive em replay. A página atualiza pela projeção isolada. Não autoriza novos prompts, troca de modelo, alteração de conversa, tarefas ou reconciliação de entregas Telegram. O token do viewer permanece fora do Telegram e do contexto do modelo. `/controls` não cria conversa e funciona durante uma intervenção CUA. Veja [crons no Telegram](telegram-cron-management.md).

### Migração conservadora

A ocultação local do PR #41 foi substituída pela remoção integral do acesso web. O endpoint `web-visibility` foi retirado; a tabela `conversation_web_hidden` e os valores existentes permanecem preservados, sem migração destrutiva. Nenhum histórico é copiado, recriado ou purgado.

- `conversation_channels` é aditiva e mantém a classificação por ID. Conversas já registradas em `telegram_conversations` (inclusive espelhos web antigos) são Telegram, independentemente de conexão/grant atual.
- Para linhas anteriores à classificação, evidência em bindings, grants atuais ou históricos (`telegram_grant_versions`), ou solicitações `source=telegram`, classifica o histórico compartilhado como Telegram. Na dúvida, ele deixa de ser editável pela web. O histórico misto permanece inteiro no mesmo ID; não é dividido, copiado ou recriado.
- Novas conversas recebem origem explícita na criação. Um novo vínculo de pareamento não converte uma conversa web em Telegram. Não se removem bindings/grants nem se alteram seleções ou destinos de crons.
- Recibos antigos de criação de tópico permanecem no banco, sem conclusão/repetição pela web. Solicitações web já admitidas no Pi são apenas reanexadas após reinício. Solicitações web ainda não admitidas em histórico agora Telegram ficam `channel_separated`; o serviço inicia normalmente sem inserir um novo turno.
- Apenas cópias web antigas ainda `pending` são canceladas. Partes já enviadas, em envio ou incertas e suas auditorias são preservadas; filas de respostas Telegram e notificações de tarefas permanecem intactas. Turnos novos não são espelhados entre canais.
- Históricos Telegram arquivados não recebem novas purgas automáticas. Uma purga permanente já reclamada antes do upgrade pode concluir a recuperação interrompida. Nenhuma migração inicia purga ou restaura grants revogados.

Os crons continuam ligados ao `conversationId`, origem e destino congelados que já estavam no SQLite. A seleção aberta na web ou no Telegram não altera esses dados. Esta alteração não modifica agendamentos nem dispara rotinas; testes usam bancos temporários e transportes simulados.

### Modelo e esforço

O Compose passa `MODEL_ID` ao boot, mas não escreve o default diretamente. A escolha global explícita já tinha precedência; a confusão era que `/model` alterava somente a conversa e o bootstrap ainda não salvo era recalculado a cada boot. Agora o bootstrap é salvo uma vez em `model-defaults-selection:live` ou `model-defaults-selection:demo`, no `app.sqlite` do volume `/app/data`. A migração conserva defaults antigos `model-defaults:<provider>`. Credenciais não são alteradas.

Na web, **Configurações → Novas conversas** salva o padrão para futuras conversas web e Telegram. O seletor no compositor altera apenas a conversa atual. No Telegram:

- `/default` consulta o padrão.
- `/default openai gpt-6.1-sol high` salva provider/modelo/esforço para novas conversas de ambos os canais.
- `/model ID` e `/thinking ESFORÇO` alteram somente a conversa atual e validam as capacidades do modelo.

Defaults explícitos e overrides existentes sobrevivem a reboot/redeploy com outro `MODEL_ID`, desde que o mesmo volume permaneça montado e o modelo continue disponível no catálogo. `live` e `demo` têm padrões separados. Não há alteração silenciosa dos modelos de todas as conversas.

## English

The web operates only on web conversations. Telegram conversations are excluded from sidebar/search/trash/resume, direct history URLs and schedule panels. The server denies the entire `/api/conversations/:id` namespace for Telegram IDs, including snapshots, SSE, JSON/text/download history, actions and mutations. List digests use only web rows. Telegram schedules and runs are excluded from web APIs and managed through Telegram `/crons`. Classified legacy anchor IDs/titles are redacted from bot status without changing bindings.

**Approved human controls:** Telegram `/controls` and CUA links open `/human-controls?c=ID`, with separate HTML/JavaScript and installation login. The page has no conversation list, title, transcript, messages, model selector or composer. Its `/api/human-controls/:id` projection includes only pending/uncertain actions, pending MCP requests, uncertain-call reconciliation and non-ended CUA handoffs. Pending action arguments and required form fields support informed decisions. Evidence, completed results, stored responses, bindings and internal resume payloads are excluded; expired CUA tickets are masked. GET never calls `Runtime.snapshot`, resumes work or creates tickets.

Only exact action-decision, MCP interaction/reconciliation and CUA mint/end POSTs are allowed. Existing session, Origin, conversation scope and service validations remain, while POST responses contain only `{ "ok": true }`, including replays. Refresh reads only the isolated projection. There are no prompts, settings, conversation changes, schedule mutations or Telegram transport reconciliation here. Viewer credentials stay outside Telegram/model messages. `/controls` works during CUA hold without creating a conversation.

The PR #41 visibility preference/API is retired; its table/values and all history are retained. Classification remains additive and conservative: known dedicated/mirrored Telegram histories remain Telegram even without current grants, and legacy binding/grant/request evidence classifies shared histories without copying, splitting or recreating messages/topics. Bindings, grants, selections, cron origins/destinations and admitted requests are preserved. Unadmitted legacy web requests are retired without new turns; only unsent old web mirror parts are cancelled. Archived Telegram histories are excluded from new automatic purge claims. No migration starts a purge or reactivates revoked grants.

Compose's `MODEL_ID` is a first-install bootstrap hint, persisted once per `live`/`demo` mode in SQLite on the data volume. Explicit saved defaults already had precedence; `/model` was a conversation-only choice and an unsaved bootstrap used to be recomputed at boot. Older provider-scoped defaults are preserved. Use **Settings → New conversations** on the web or `/default PROVIDER MODEL EFFORT` in Telegram to set the default for future conversations on both channels. `/default` reads it; `/model` and `/thinking` change only the current conversation. Existing overrides remain untouched. Saved compatible selections survive a different environment default on reboot/redeploy while the same volume and catalog entries remain available. No credentials are changed.
