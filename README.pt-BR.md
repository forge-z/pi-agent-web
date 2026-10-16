# Pi Personal Agent

[English](README.md) · [Português (Brasil)](README.pt-BR.md)

Um assistente pessoal com histórico durável, interface web e integração opcional com Telegram e ferramentas MCP. No modo `demo`, as conversas ficam locais e recebem respostas simuladas; nenhuma conta externa é necessária. No modo `live`, o login OpenAI é feito pela interface. Ferramentas MCP podem usar o modo `legacy`, com propostas e confirmação da aplicação, ou `direct`, com execução direta e as permissões nativas do serviço.

## Rodar localmente sem Docker

Requer Git e Node.js 24 ou superior com npm. O `.nvmrc` indica a versão 24 e o `npm ci` recusa versões anteriores. Docker é opcional neste caminho.

```sh
git clone https://github.com/forge-z/pi-agent-web.git
cd pi-agent-web
npm ci
```

### Desenvolvimento

Execute os fontes TypeScript com `npm run dev`:

```sh
HOST=127.0.0.1 PORT=3000 APP_ORIGIN=http://127.0.0.1:3000 COOKIE_SECURE=false WEB_PASSWORD='local-demo-password' APP_MODE=demo npm run dev
```

Abra <http://127.0.0.1:3000> e entre com a senha `local-demo-password`. Ela é apenas um exemplo para teste local; escolha uma senha própria com pelo menos 12 caracteres antes de qualquer uso real. O login web é separado da autenticação no provedor. Os scripts npm não carregam `.env` automaticamente; forneça as variáveis no shell.

### Execução local compilada

Compile primeiro e inicie a saída JavaScript. Isso também funciona sem Docker:

```sh
npm run build
HOST=127.0.0.1 PORT=3000 APP_ORIGIN=http://127.0.0.1:3000 NODE_ENV=production COOKIE_SECURE=false WEB_PASSWORD='substitua-por-sua-senha-longa' APP_MODE=demo npm start
```

Substitua a senha de exemplo por uma própria. `NODE_ENV=production` altera o ambiente de execução; `APP_MODE=demo` continua usando respostas simuladas. Use `APP_MODE=live` para acessar um provedor real e conecte sua conta ou chave API em **Configurações**. A instalação local mantém os dados do app na sua máquina; chamadas a modelos reais e integrações configuradas podem acessar serviços externos.

Mantenha `HOST=127.0.0.1` para acesso somente nesta máquina. Sem `HOST` explícito, desenvolvimento escuta em `127.0.0.1`, enquanto `NODE_ENV=production` escuta em `0.0.0.0`. `COOKIE_SECURE=false` é para HTTP local; use `true` quando servir a aplicação por HTTPS.

### Portas e plataformas

A porta `3000` é o padrão, não uma exigência. Se outro processo já a utiliza, escolha uma porta livre e atualize `APP_ORIGIN` para a origem exata aberta no navegador:

```sh
HOST=127.0.0.1 PORT=3100 APP_ORIGIN=http://127.0.0.1:3100 COOKIE_SECURE=false WEB_PASSWORD='local-demo-password' APP_MODE=demo npm run dev
```

Abra `http://127.0.0.1:3100`. Se `APP_ORIGIN` estiver ausente, o app usa `http://127.0.0.1:${PORT}`. Uma origem já configurada precisa ser atualizada quando o endereço do navegador muda; caso contrário, as escritas são rejeitadas. Em falhas de bind como `EADDRINUSE`, o app atual registra **Não foi possível iniciar o servidor HTTP**, fecha os recursos e encerra com código 1. Ele não tenta outra porta automaticamente.

Os comandos acima usam sintaxe de shell POSIX (shells Linux/macOS). No PowerShell do Windows, defina as variáveis antes de iniciar o app, por exemplo:

```powershell
$env:HOST = '127.0.0.1'
$env:PORT = '3100'
$env:APP_ORIGIN = 'http://127.0.0.1:3100'
$env:COOKIE_SECURE = 'false'
$env:WEB_PASSWORD = 'local-demo-password'
$env:APP_MODE = 'demo'
npm run dev
```

Para a execução compilada no PowerShell, execute `npm run build`, defina `$env:NODE_ENV = 'production'`, escolha uma senha própria e execute `npm start`. Início e persistência foram testados no Linux com Node.js 24; macOS e Windows nativo não foram verificados aqui.

### Persistência e implantação Docker

Os dados do app, incluindo histórico SQLite e conexões salvas, ficam em `./data` por padrão e sobrevivem a reinícios. Defina `DATA_DIR` como um diretório persistente se necessário; iniciar de outro diretório de trabalho altera o local padrão dos dados. Mantenha esse diretório privado, preserve-o nas atualizações e execute uma única instância do app sobre ele.

Para Docker Compose ou Coolify, use [docs/deployment.md](docs/deployment.md). A visão dos componentes, persistência e limites está em [docs/architecture.md](docs/architecture.md).

## Configuração

**Configurações → Sobre o app** mostra a versão do pacote, o SHA curto do commit instalado e a data de build quando disponível. Campos desconhecidos ficam como **Desconhecido**. A data é registrada por `npm run build` e não muda ao reiniciar; desenvolvimento não tem data de build. Docker/Coolify usam `SOURCE_COMMIT` durante o build; veja a [configuração dos metadados](docs/deployment.md#identificação-da-versão-instalada).

Respostas longas oferecem **Ver mais** na própria conversa, buscando até 16.384 caracteres visíveis por página. Raciocínio oculto e assinaturas do provider não geram aviso de truncamento. As proteções Markdown continuam ativas; respostas maiores são renderizadas em trechos limitados. Veja [conversas canônicas e entrega](docs/canonical-conversations.pt-BR.md).

O painel **Configurações** permite gerenciar servidores MCP e os padrões de modelo/esforço. O seletor na conversa aplica a escolha somente à conversa atual. **Tarefas** permite criar execuções únicas ou cron, pausar, executar agora e acompanhar o histórico. Veja [configurações e tarefas](docs/settings-and-tasks.md) para uso, persistência e referências no código do Pi.

Digite `/` no compositor para encontrar `/agents`, `/model`, `/thinking`, `/compact`, `/tasks`, `/crons`, `/stop` e `/help`. Eles também funcionam no Telegram, com acesso limitado às conversas vinculadas. Consulte [comandos e referências do Pi](docs/slash-commands.md).

No Telegram, `/crons` abre um menu nativo para consultar, pausar/retomar, editar e confirmar a exclusão de agendamentos Telegram autorizados, preservando o destino salvo. Veja [gerenciamento nativo de crons](docs/telegram-cron-management.md).

No Telegram, `/topics` gerencia as conversas e tópicos próprios. Conversas Telegram não são exibidas nem acessíveis pela web; `/controls` e links CUA abrem somente a página autenticada de controles humanos CUA/MCP, sem histórico ou compositor. Novas conversas web não criam tópicos nem espelham mensagens. Históricos, bindings, grants e destinos existentes são preservados. Veja [separação de canais](docs/channel-separation.md).

`/new TÍTULO` é um alias de `/topics new TÍTULO`. Na DM com tópicos habilitados, o cliente Telegram pode primeiro criar um tópico nativo automaticamente ao escrever no Geral. O Pi remove o prefixo `/new` apenas de novos nomes de tópico explicitamente marcados como implícitos; nomes e aspas são preservados. Veja [tópicos privados](docs/telegram-private-topics.md).

Conversas e tópicos Telegram são gerenciados somente no Telegram; nomes nativos continuam atualizando o título local preservado. A web oferece lixeira de sete dias, restauração e exclusão permanente apenas para conversas web. Históricos Telegram não recebem novas purgas automáticas.

Conversas que já estavam excluídas recebem sete dias a partir da primeira inicialização desta versão. A limpeza automática verifica prazos a cada minuto e retoma operações interrompidas após reiniciar. Execuções, entregas ou intervenções pendentes e dependências de outros históricos bloqueiam a limpeza até serem resolvidas; a conversa pode ser restaurada enquanto a exclusão definitiva não tiver começado. A limpeza remove os registros da conversa nos bancos locais, preservando outros chats e credenciais globais; não remove cópias de backup do volume.

O Telegram registra esse catálogo, `/topics`, `/cua` e `/controls` no menu nativo `/` do chat privado autorizado depois da primeira mensagem. O diálogo mostra o estado do registro; menus de outros chats e menus alheios existentes são preservados. Novas respostas usam HTML seguro para negrito, itálico, links e código, com divisão de mensagens longas antes de entrar na fila persistente.

Quando o Pi solicita intervenção CUA pelo Telegram, a mensagem no tópico original oferece **Assumir controle**, cancelamento e devolução com confirmação explícita de que todas as abas foram fechadas. `/cua` consulta esses controles durante a pausa. O link Pi é uma URL normal da aplicação protegida pelo login, sem credencial embutida. O desktop só abre pela interface Pi com login; o ticket privado não passa pelo Telegram nem pelo modelo. Após devolver, envie a próxima instrução para continuar. Veja [intervenção CUA](docs/cua-private-handoff.md).

Tarefas e crons preservam sua origem e destino fixos no SQLite. Trocar a conversa aberta ou usar o menu de gerenciamento não altera bot, chat, usuário ou tópico de entrega. Agendas de conversas Telegram ficam fora do painel web; use `/crons` no Telegram. A autorização é conferida antes de cada envio; resultados incertos não são reenviados. Veja [entrega de tarefas](docs/cron-telegram-delivery.md).

| Variável                             | Uso                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_PASSWORD` / `WEB_PASSWORD_FILE` | Senha da interface, com no mínimo 12 caracteres. O arquivo tem precedência quando definido. Separe essa senha do login do provider.                                                                                                                                                                        |
| `APP_ORIGIN`                         | Origem exata da interface (`scheme://host[:port]`); também protege requisições de escrita contra origem diferente.                                                                                                                                                                                         |
| `COOKIE_SECURE`                      | Defina `true` quando a interface estiver atrás de TLS.                                                                                                                                                                                                                                                     |
| `TRUST_PROXY`                        | Defina `true` só atrás de um proxy reverso que acrescente `X-Forwarded-For`; o limite de tentativas de login passa a contar por cliente, não pelo endereço do proxy.                                                                                                                                       |
| `APP_MODE`                           | `demo` por padrão; `live` ativa o provider OpenAI.                                                                                                                                                                                                                                                         |
| `MODEL_ID`                           | Modelo no modo live; padrão `gpt-6.1-sol`.                                                                                                                                                                                                                                                                 |
| `DATA_DIR`                           | Diretório das bases SQLite; padrão `./data`.                                                                                                                                                                                                                                                               |
| `MCP_CONFIG_FILE`                    | Arquivo JSON opcional com servidores MCP HTTP(S). Veja [docs/mcp.example.json](docs/mcp.example.json).                                                                                                                                                                                                     |
| Telegram                             | Conecte pelo botão **Telegram** no cabeçalho da conversa com o token do bot, seu ID numérico de usuário e a conversa atual como referência do vínculo e dos crons existentes. O fluxo usa polling privado; veja [implantação](docs/deployment.md#telegram) e [arquitetura](docs/architecture.md#telegram). |

Os arquivos Compose não declaram nem encaminham variáveis ou secrets Telegram. Token e ID de usuário são configurados pela interface e persistem no volume. No Coolify, recarregue a definição Compose do `main` antes de excluir as variáveis antigas; na primeira migração, informe o token do mesmo bot na UI. Uma conexão já salva continua usando o SQLite existente.

Use `npm run build` para compilar; `npm start` inicia `dist/src/main.js`. O runtime usa Pi Durable 1.0.4, Pi AI 1.0.4, SQLite integrado do Node e o SDK MCP por HTTP.

## Operação

O workspace web usa uma senha compartilhada para um operador; não há usuários individuais nem RBAC. No modo live, clique em **Sign in with ChatGPT** para completar o OAuth interativo. Essa conta é independente da senha da interface.

Antes de conectar ferramentas MCP, revise as permissões do serviço e a lista `allowedTools`/`deniedTools`. O modo `direct` chama ferramentas sem confirmação adicional da aplicação, e uma chamada `execute` não garante que a ferramenta seja somente de leitura. O modo `legacy` mantém listas `readTools`/`actionTools`, leitura antes da proposta e confirmação do operador. Consulte [configurações e tarefas](docs/settings-and-tasks.md), [arquitetura e limites](docs/architecture.md) e [implantação](docs/deployment.md).

## Licenças

O código deste projeto está sob MIT, veja [LICENSE](LICENSE). Avisos e referências de terceiros estão em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Verificação

```sh
npm run check
npm run lint
npm run format:check
npm run build
npm test
```

`npm run format` aplica o Prettier no repositório inteiro.

Veja [evidências e limites da verificação](docs/verification.md).

Os testes usam provider faux, MCP HTTP em loopback e transporte Telegram mock. Incluem `SIGKILL` durante geração, efeito externo e envio; o teste aguarda 31 segundos pela expiração do lock antes de retomar. Nenhuma conta real é usada.

## Aparência

A interface tem temas **Azul**, **Cinza** e **Pi**, com modos **Claro**, **Escuro** e **Automático** independentes. Pi segue o visual do [site oficial](https://pi.dev): papel quente no claro, azul profundo no escuro, títulos serifados, bordas retas e grade discreta. Os seletores ficam na entrada e no rodapé da navegação; no celular, abra o menu. A preferência é salva no navegador. O modo automático acompanha o sistema.

O logo é o oficial do Pi, os ícones são Phosphor e as fontes são servidas localmente. Veja [a direção visual](docs/design.md) e [as capturas e verificações](docs/verification.md#refinamento-visual-paletas-e-modos-de-aparência).
