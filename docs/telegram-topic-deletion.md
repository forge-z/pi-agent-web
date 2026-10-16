# Exclusão de tópicos: investigação / Topic deletion investigation

## PT-BR

Investigação em 15/10/2026, após o merge do PR #39, base `f03c239548152740a5ff85166085ac6f534ea76a`. **Não há sincronização automática confiável de exclusões feitas pelo cliente Telegram.** O histórico local persistido não representa uma lista remota de tópicos existentes. O acesso a conversas Telegram pela web foi removido; somente controles humanos isolados continuam disponíveis. `Runtime.listConversations` usa o lifecycle local; `observeTopic` só atualiza observações de nome e fechamento.

A [Bot API atual](https://core.telegram.org/bots/api#message) documenta criação, edição, fechamento e reabertura. Não expõe `forum_topic_deleted`, nem método público para consultar/listar tópicos. Fechar é diferente de apagar. `deleted_business_messages` trata mensagens de contas Business, não exclusão de tópicos. `deleteForumTopic` apaga tópico e mensagens; não é uma consulta e não foi usado.

O [servidor oficial fixado em `e3e9dd8`](https://github.com/tdlib/telegram-bot-api/blob/e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1/telegram-bot-api/Client.cpp#L7066-L7082) aplica `Message thread not found` como descrição padrão a erros da consulta interna de tópico. Esse resultado pode indicar destino inválido ou inacessível, não prova exclusão. HTTP 400 genérico, 401/403, rate limit, falhas de rede, timeout ou indisponibilidade também não autorizam ocultar, apagar ou romper vínculos. A aplicação conserva apenas código e mensagem segura de recusa; não tenta deduzir exclusão desses dados.

A preferência local introduzida no PR #41 foi substituída pela remoção da apresentação e acesso web a conversas Telegram. Seu endpoint foi retirado; a metadata já salva e todos os históricos, bindings, grants, agendamentos e destinos continuam preservados. Não há sondagem, exclusão remota, cópia de mensagens, recriação ou purga. `/controls` e links CUA abrem somente [controles humanos isolados](channel-separation.md), sem conversa ou histórico. Use `/crons` no Telegram para administrar agendas. A limitação da Bot API sobre exclusões continua sendo a mesma.

## English

Persisted local history is not a remote topic inventory. Telegram histories are no longer accessible through the web. The current [Bot API](https://core.telegram.org/bots/api#message) has no topic-deletion update or public topic lookup/listing method. Closing a topic is a separate operation; Business message deletion updates do not describe forum-topic deletion. Calling `deleteForumTopic` would mutate Telegram and is not a valid existence probe.

The [pinned official implementation](https://github.com/tdlib/telegram-bot-api/blob/e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1/telegram-bot-api/Client.cpp#L7066-L7082) uses `Message thread not found` as a fallback for internal lookup errors. This does not establish that a topic was deleted. Network, permissions, generic refusals or service failures cannot authorize hiding or deleting local data.

The PR #41 local visibility preference has been superseded by removing Telegram conversation presentation and access from the web. Its API is retired; stored visibility metadata, history, bindings, grants, schedules and frozen destinations are preserved. There are no probes, remote deletions, message copies, topic recreation or purges. `/controls` and CUA links open only the isolated authenticated human-controls page described in [channel separation](channel-separation.md). Manage schedules with Telegram `/crons`. The Bot API deletion limitation remains unchanged.
