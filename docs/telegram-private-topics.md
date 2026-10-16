# Tópicos privados do Telegram

Cada tópico nativo do chat privado com o bot mantém sua própria seleção de conversa Pi. O evento de criação cria uma conversa canônica, antes da primeira mensagem; `/new TÍTULO` cria e seleciona outra dentro do mesmo tópico. `/topics` lista os tópicos conhecidos deste chat privado, inclusive tópicos observados ainda sem conversa Pi. O botão seleciona a conversa dentro do tópico indicado; abra esse tópico no cliente Telegram para continuar. Ele não redireciona o contexto do tópico de origem. `/topics ID` volta a uma conversa Pi do tópico atual; `/chats` conserva a listagem local antiga como alias fora do menu. Trocar de tópico no cliente Telegram retoma a seleção persistida correspondente, inclusive após reiniciar o Pi Agent.

Com a criação de tópicos pelo usuário habilitada, o cliente Telegram pode criar um tópico automaticamente antes de enviar uma mensagem digitada no **Geral**, conforme [Bot forums](https://core.telegram.org/api/forum#bot-forums). Assim, enviar `/new Viagem` pode criar um tópico nativo cujo nome inicial inclui o comando. Quando o novo evento `forum_topic_created` marca esse nome como `is_name_implicit`, o Pi usa [editForumTopic](https://core.telegram.org/bots/api#editforumtopic) para remover apenas o prefixo `/new` ou `/new@BOT`; acentos, aspas e pontuação do nome são preservados. `/new` sem nome usa `Conversa Telegram`. Nomes explícitos, tópicos já observados e comandos em tópicos existentes não são renomeados. Uma tentativa de edição com resultado incerto não é repetida automaticamente após duplicação ou reinício. Não há correção retroativa de nomes antigos.

Modelos, histórico, comandos e respostas ficam vinculados à conversa daquele tópico. A aba Telegram no painel web permite apenas consultar o histórico: **Somente leitura · continue no Telegram**. Novas conversas web não criam tópicos, e turnos novos não são espelhados entre canais. Veja a [migração conservadora e a exceção operacional aprovada](channel-separation.md).

## Inventário e estado observado

A [Bot API](https://core.telegram.org/bots/api) não documenta método para enumerar todos os tópicos existentes. A lista é local e pode estar incompleta: mensagens com `message_thread_id` e os eventos `forum_topic_created`, `forum_topic_edited`, `forum_topic_closed` e `forum_topic_reopened` atualizam os tópicos conhecidos. Mensagens de serviço não são enviadas ao modelo. Um fechamento observado retira o tópico dos menus e impede novos envios e seleção por botões antigos; uma reabertura observada permite listá-lo novamente. Sem evento de estado, o rótulo diz apenas **observado**, sem afirmar que o tópico continua aberto no servidor. Métodos MTProto de enumeração não fazem parte desta integração Bot API.

O nome observado no Telegram é canônico: `forum_topic_edited` atualiza o título local sem ecoar outra edição. Nomes de até 128 caracteres Unicode são preservados. Renomeie e gerencie tópicos no Telegram; a web bloqueia essas mutações. Novos tópicos nativos observados recebem uma conversa Pi uma vez. Recibos legados de criação permanecem preservados e não podem ser concluídos pela web. A lista exibe até 50 botões por mensagem.

## Ativação pelo proprietário do bot

Esta implementação não altera o BotFather ou a conta Telegram. Após instalar uma versão com o recurso:

1. Preserve ou configure a conexão privada existente no painel web. Se precisar usar `/link CODIGO`, envie-o na conversa sem tópico; o código não é consumido quando enviado dentro de um tópico.
2. No BotFather, habilite **Threaded mode** para esse bot. Permita a criação de tópicos pelos usuários se desejar criá-los no cliente; a opção **Disallow users to create new threads** controla essa permissão. O Telegram documenta esse modo em [Bot forums](https://core.telegram.org/api/forum#bot-forums).
3. Em um cliente Telegram compatível, crie ou abra dois tópicos privados e envie uma mensagem em cada um. Use `/new` e `/topics` dentro deles, depois abra a aba Telegram no painel web para consultar seus históricos.

As mensagens e ações do bot usam `message_thread_id`, conforme a [Bot API](https://core.telegram.org/bots/api#message). O Pi não cria tópicos por meio da web nem apaga tópicos nativos. Ajusta somente novos nomes implícitos de `/new` descritos acima.

Em 10 de outubro de 2026, os [termos para desenvolvedores de bots, seção 6.2.6](https://telegram.org/tos/bot-developers#6-2-6-enabling-topics-in-private-chats), estabelecem uma taxa não reembolsável de 15% nas compras subsequentes de Stars dentro do bot enquanto tópicos privados estiverem habilitados. A condição trata dessas compras; este recurso não introduz cobrança nem integração de Stars no Pi Agent. Confira os termos antes de ativar o modo.

## Compatibilidade e revogação

Conversas, seleção e filas antigas sem `message_thread_id` permanecem sem tópico. A migração é aditiva: não move nem converte históricos existentes. A ausência do identificador segue o comportamento anterior; identificadores inválidos, mensagens sinalizadas como tópico sem identificador e tópicos recebidos fora de chat privado são ignorados. Clientes antigos podem apresentar mensagens sem identidade de tópico; a aplicação não tenta adivinhar essa identidade.

Se a versão anterior foi interrompida após registrar um update, mas antes de confirmar o offset de polling, a recuperação reconhece seu fingerprint antigo sem tópico. Resultados, requests, comandos e ações já persistidos são reconhecidos com a autorização do proprietário original; não são executados de novo, importados para o tópico ou reenviados para um destino diferente. Comandos/efeitos incertos continuam incertos. Quando apenas o ledger foi gravado, sem admissão ou efeito persistido, a mensagem é admitida no tópico da entrega autenticada atual. O primeiro replay fixa seu fingerprint com tópico de forma atômica; alterações posteriores de texto, chat, usuário ou tópico são rejeitadas.

O hash antigo não informa o tópico original. A migração registra uma única vez os ledgers já existentes como candidatos à compatibilidade, inclusive registros sem tópico gravados antes desta correção; somente candidatos que correspondem ao hash antigo usam esse caminho. Updates novos seguem a verificação estrita por tópico e nunca passam a ser candidatos durante reinícios. Recibos de polling já confirmados continuam sendo reconhecidos antes de executar a recuperação.

A exclusão permanente registra os updates comprovadamente associados à conversa antes de apagar suas evidências. Essa marca terminal guarda somente o número do update, sem texto, histórico, resultado, proprietário ou destino. Replays marcados são ignorados antes da recuperação/admissão, inclusive quando o fingerprint legado já foi promovido; não criam outra conversa nem uma nova resposta. O polling pode confirmar o descarte e avançar o offset normalmente. Updates de outras conversas e ledgers ainda sem admissão seguem seu tratamento anterior.

Uma exclusão concluída antes desta correção pode já ter apagado a associação entre conversa e update. A migração não tenta reconstruir essa informação a partir de hashes ou marcar updates sem prova de pertencimento.

O vínculo privado existente continua autorizando o bot e seu usuário. Cada conversa de tópico também exige seu próprio grant. Um tópico não consegue selecionar, ler ou alterar uma conversa de outro tópico ou do chat antigo. Apagar/restaurar uma conversa não recria seu grant. `/new` cria uma conversa nova no tópico se o vínculo privado continuar autorizado. Excluir ou revogar a conversa de pareamento não remove autorizações independentes de outros tópicos. Cada conversa exige sua própria rota e grant; recuperar a conversa não recupera o vínculo revogado.

Respostas em andamento e resultados de tarefas com entrega **Web + Telegram** guardam o destino da conversa de origem. Trocar a seleção com `/new` não redireciona essas entregas. Nas notificações de tarefas, revogar vínculos/grants cancela partes pendentes definitivamente; reconectar não as reativa. Respostas e recibos comuns conferem a autorização atual antes de enviar: a revogação cancela partes pendentes definitivamente, mesmo que uma autorização nova seja concedida antes do flush. Filas antigas mantêm destino sem tópico. A aplicação não redireciona resultados para o chat geral quando o tópico deixa de estar disponível. Apagar um tópico no cliente Telegram não apaga sua conversa Pi; erros de envio seguem o tratamento de incerteza existente.

## Validação

Os testes usam Runtime e SQLite reais com provider e transporte simulados. Cobrem isolamento por tópico, comandos, modelo, histórico web somente leitura, respostas concorrentes, filas de tarefas, revogação/regrant, exclusão/restauração, migração, reinício, polling e destino de mensagens/typing. Um único scheduler verifica as leases de typing; 32 tópicos exigem 32 verificações por tick, sem varreduras globais repetidas por tópico.

A ativação e a apresentação em clientes Telegram reais não foram verificadas neste ambiente. Nenhuma conta, credencial real, BotFather, serviço de produção ou deploy foi utilizado.

Abrir a web, recarregar a página ou excluir a conversa ativa não cria outra conversa ou tópico. A seleção usa primeiro uma URL válida com `?c=ID`, depois a última conversa ativa lembrada neste navegador e por fim a conversa ativa mais recente. Sem conversa disponível, a web aguarda **Nova conversa**. A ausência ou indisponibilidade do armazenamento local não autoriza criação automática.

Turnos novos da web e do Telegram permanecem separados. Registros históricos de espelhamento e suas auditorias são preservados; não há cópia ou reenvio de histórico.

A lixeira de sete dias aplica-se às conversas web. Históricos Telegram não podem ser excluídos, restaurados ou purgados pela web; os tópicos e suas mensagens permanecem preservados. A documentação oficial de [closeForumTopic](https://core.telegram.org/bots/api#closeforumtopic) e [reopenForumTopic](https://core.telegram.org/bots/api#reopenforumtopic) especifica supergrupos, enquanto criação, edição e exclusão mencionam chats privados. Esta integração de tópicos privados não assume suporte não documentado a fechar/reabrir. Não há purga remota automática; uma exclusão definitiva do Telegram é irreversível e exigiria um fluxo separado com confirmação explícita.
