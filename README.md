# Pi Personal Agent

[English](README.md) · [Português (Brasil)](README.pt-BR.md)

A personal assistant with durable conversation history, a web interface, and optional Telegram and MCP integrations. In `demo` mode, conversations stay local and receive simulated responses; no external account is required. In `live` mode, OpenAI sign-in takes place through the interface. MCP tools can use `legacy` mode, with application proposals and confirmation, or `direct` mode, with direct execution and the service's native permissions.

## Run locally without Docker

Requires Git and Node.js 24 or newer with npm. `.nvmrc` specifies version 24, and `npm ci` rejects older versions. Docker is optional for this path.

```sh
git clone https://github.com/forge-z/pi-agent-web.git
cd pi-agent-web
npm ci
```

### Development

Run the TypeScript sources with `npm run dev`:

```sh
HOST=127.0.0.1 PORT=3000 APP_ORIGIN=http://127.0.0.1:3000 COOKIE_SECURE=false WEB_PASSWORD='local-demo-password' APP_MODE=demo npm run dev
```

Open <http://127.0.0.1:3000> and sign in with `local-demo-password`. This password is only an example for local testing; choose your own password of at least 12 characters before real use. Web sign-in is separate from provider authentication. The npm scripts do not automatically load `.env`; supply environment variables in your shell.

### Compiled local runtime

Compile first, then start the JavaScript output. This also works without Docker:

```sh
npm run build
HOST=127.0.0.1 PORT=3000 APP_ORIGIN=http://127.0.0.1:3000 NODE_ENV=production COOKIE_SECURE=false WEB_PASSWORD='replace-with-your-own-long-password' APP_MODE=demo npm start
```

Replace the password example with your own value. `NODE_ENV=production` changes the runtime environment; `APP_MODE=demo` still uses simulated responses. Set `APP_MODE=live` to use a real model provider and connect your account or API key through **Settings**. Local hosting keeps application data on your machine; live model requests and configured integrations can contact external services.

Keep `HOST=127.0.0.1` for access from this machine only. Without an explicit `HOST`, development binds to `127.0.0.1`, while `NODE_ENV=production` binds to `0.0.0.0`. `COOKIE_SECURE=false` is for local HTTP; use `true` when serving the application over HTTPS.

### Ports and platforms

Port `3000` is the default, not a requirement. If another process already uses it, choose a free port and update `APP_ORIGIN` to the exact browser origin:

```sh
HOST=127.0.0.1 PORT=3100 APP_ORIGIN=http://127.0.0.1:3100 COOKIE_SECURE=false WEB_PASSWORD='local-demo-password' APP_MODE=demo npm run dev
```

Open `http://127.0.0.1:3100`. If `APP_ORIGIN` is omitted, the app defaults to `http://127.0.0.1:${PORT}`. A previously configured origin must be updated when the browser address changes; otherwise writes are rejected. If binding fails with an error such as `EADDRINUSE`, the current app logs **Não foi possível iniciar o servidor HTTP**, closes its resources, and exits with code 1. It does not automatically try another port.

The commands above use POSIX shell syntax (Linux/macOS shells). For Windows PowerShell, set environment variables before starting the app, for example:

```powershell
$env:HOST = '127.0.0.1'
$env:PORT = '3100'
$env:APP_ORIGIN = 'http://127.0.0.1:3100'
$env:COOKIE_SECURE = 'false'
$env:WEB_PASSWORD = 'local-demo-password'
$env:APP_MODE = 'demo'
npm run dev
```

For the compiled PowerShell runtime, run `npm run build`, set `$env:NODE_ENV = 'production'`, choose your own password, and run `npm start`. Startup and persistence were tested on Linux with Node.js 24; macOS and native Windows have not been verified here.

### Persistence and Docker deployment

Application data, including SQLite history and saved connections, is stored in `./data` by default and survives restarts. Set `DATA_DIR` to a persistent directory if needed; launching from a different working directory changes the default data location. Keep this directory private, preserve it during updates, and run a single app instance against it.

For Docker Compose or Coolify, see [deployment](docs/deployment.md). The [architecture](docs/architecture.md) covers components, persistence, and limitations. The linked technical documentation is primarily in Portuguese.

## Configuration

**Settings → About the app** shows the package version, the installed commit’s short SHA, and the build date when available. Unknown fields stay **Unknown**. The build date is recorded by `npm run build` and does not change on restart; development has no build date. Docker/Coolify use `SOURCE_COMMIT` during the build; see [deployment metadata](docs/deployment.md#identificação-da-versão-instalada) for configuration.

Long responses offer **View more** directly in the conversation, fetching up to 16,384 visible characters per page. Hidden reasoning and provider signatures do not trigger a truncation warning. Markdown safety limits remain in place; larger responses are rendered in bounded chunks. See [canonical conversations and delivery](docs/canonical-conversations.md).

**Settings** manages MCP servers and default model and reasoning effort. The conversation selector applies changes only to the current conversation. **Tasks** lets you create one-time or cron runs, pause them, run them now, and inspect their history. See [settings and tasks](docs/settings-and-tasks.md) for usage, persistence, and Pi source references.

Type `/` in the composer to find `/agents`, `/model`, `/thinking`, `/compact`, `/tasks`, `/crons`, `/stop`, and `/help`. These commands also work in Telegram, with access limited to authorized conversations. See [commands and Pi references](docs/slash-commands.md).

In Telegram, `/crons` opens a native menu to inspect, pause/resume, edit and confirm deletion of authorized Telegram schedules, preserving their saved destination. See [native cron management](docs/telegram-cron-management.md).

In Telegram, `/model` opens a [clickable provider/model menu](docs/telegram-model-menu.md), with pagination, back and cancel. It changes only the current conversation; `/default` explicitly changes the default for future conversations.

In Telegram, `/topics` manages its own conversations/topics. Telegram conversations are neither shown nor accessible through the web; `/controls` and CUA links open only the authenticated CUA/MCP human-controls page, without history or a composer. New web conversations do not create topics or mirror turns. Existing histories, bindings, grants and destinations are preserved. See [channel separation](docs/channel-separation.md).

`/new TITLE` is an alias for `/topics new TITLE`. In a threaded private chat, the Telegram client may first create a native topic automatically when you type in General. Pi removes the `/new` prefix only from newly observed topic names explicitly marked as implicit; names and quotes are otherwise preserved. See [private topics](docs/telegram-private-topics.md).

Telegram conversations and topics are managed only in Telegram; native names still update the preserved local title. The web offers seven-day trash, restore and permanent deletion only for web conversations. Telegram histories are excluded from new automatic purge claims.

Conversations deleted before this retention feature receive seven days from their first startup under that version. Automatic cleanup checks web-history deadlines every minute and resumes interrupted cleanup after restarting. Telegram histories are excluded from new automatic purge claims. Pending runs, deliveries, handoffs, and dependencies from other histories block cleanup until resolved; a conversation can be restored until permanent deletion has started. Cleanup removes that conversation's records from the local databases, preserving other conversations and global credentials. It does not remove volume backups.

Telegram registers the command catalog, including `/topics`, `/cua` and `/controls`, in the authorized private chat's native `/` menu after the first message. The connection dialog shows registration status; menus belonging to other chats or services are preserved. New replies use safe HTML for bold, italics, links, and code, and long messages are split before entering the persistent outbox.

When Pi requests a CUA handoff through Telegram, the message in the original topic offers **Assumir controle (sem clipboard)** (take control without clipboard), cancellation, and a two-step return confirmation stating that every viewer tab has been closed. `/cua` shows these controls during the pause. These Telegram control labels currently use Portuguese. The desktop opens only through the Pi interface after web sign-in; the private viewer ticket never enters Telegram or model messages. The Pi link is an ordinary login-protected application URL, without an embedded credential. After returning control, send the next instruction to continue. See [CUA handoffs](docs/cua-private-handoff.md).

Task and cron results use the bot, chat, user and topic saved at creation and copied to each admitted occurrence. The server captures the human request origin: requests from Telegram topics default to their captured Telegram destination plus the same persisted history; new web requests stay in web conversations. A model-provided `delivery=web` cannot suppress that copy; an explicit human web-only choice can. Direct task-panel destination selections remain authoritative. Navigating to another conversation does not move this destination. Ambiguous legacy tasks ask for an explicit destination for future runs. Authorization is checked before every send; revocation cancels pending parts, and uncertain results are not resent. The pending panel and deletion guards use the same delivery associations, including control replies and legacy receipts. New recovery replies persist their chat/user/topic scope and main conversation, when known; a later binding change does not transfer those owned replies. A legacy chat-only delivery with no ownership evidence remains conservatively associated with the currently linked web anchor, rather than every conversation in that chat. Ambiguous legacy deliveries are retained rather than physically purged as owned history.

In a web conversation, an uncertain delivery can be closed explicitly from its owning conversation's Telegram delivery card: verify the result in Telegram, enter a note, and confirm **Record resolution without resending**. This atomically records the conversation, note, timestamp and previous transport result in `telegram_delivery_resolutions` and marks only that delivery `reconciled`. It neither sends a message nor settles requests, tasks, actions or handoffs. Sending deliveries cannot be reconciled, and shared controls owned by another conversation must be resolved there. Audits persist across restarts and follow their proven delivery's normal history retention; unowned legacy records and their audit are retained conservatively. Results completed without a valid binding are not sent after a new connection is established. See [task delivery](docs/cron-telegram-delivery.md).

| Variable                             | Purpose                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_PASSWORD` / `WEB_PASSWORD_FILE` | Web password, at least 12 characters. The file takes precedence when configured. Keep this separate from provider sign-in.                                                                                                                                                                                                  |
| `APP_ORIGIN`                         | Exact application origin (`scheme://host[:port]`); also rejects writes from a different origin.                                                                                                                                                                                                                             |
| `COOKIE_SECURE`                      | Set to `true` when the interface runs behind TLS.                                                                                                                                                                                                                                                                           |
| `TRUST_PROXY`                        | Set to `true` only behind a reverse proxy that adds `X-Forwarded-For`; sign-in rate limits then apply to the client address instead of the proxy.                                                                                                                                                                           |
| `APP_MODE`                           | Defaults to `demo`; `live` enables the OpenAI provider.                                                                                                                                                                                                                                                                     |
| `MODEL_ID`                           | First-install bootstrap in live mode (`gpt-6.1-sol`). Saved defaults in the data volume win on restart/redeploy.                                                                                                                                                                                                            |
| `DATA_DIR`                           | SQLite database directory; defaults to `./data`.                                                                                                                                                                                                                                                                            |
| `MCP_CONFIG_FILE`                    | Optional JSON file containing HTTP(S) MCP servers. See [the example](docs/mcp.example.json).                                                                                                                                                                                                                                |
| Telegram                             | Connect with the **Telegram** button in the conversation header, using the bot token, your numeric user ID, and the current conversation as the authorization and existing cron reference. Reception uses private polling; see [deployment](docs/deployment.md#telegram) and [architecture](docs/architecture.md#telegram). |

Web and Telegram have separate conversations. The web API excludes Telegram histories, streams and schedules. Only the isolated authenticated CUA/MCP controls page remains available through Telegram `/controls` and CUA links, without conversation history or a composer. See [channel separation and persistent defaults](docs/channel-separation.md).

Choose the default for **new web and Telegram conversations** under **Settings → New conversations**, or use `/default PROVIDER MODEL EFFORT` in Telegram. `/model` and `/thinking` affect only the current conversation. Existing overrides are preserved. Keep `pi_agent_data` mounted at `/app/data`; changing or removing the volume loses access to saved choices and history.

The Compose files do not declare or forward Telegram variables or secrets. The bot token and user ID are configured through the interface and persist in the data volume. In Coolify, reload the Compose definition from `main` before removing old variables; for the first migration, enter the same bot's token in the UI. A saved connection continues using the existing SQLite data.

Run `npm run build` to compile; `npm start` launches `dist/src/main.js`. The runtime uses Pi Durable 1.0.4, Pi AI 1.0.4, Node's built-in SQLite, and the MCP SDK over HTTP.

## Operation

The web workspace uses a shared password for one operator; there are no individual accounts or RBAC. In live mode, click **Sign in with ChatGPT** to complete interactive OAuth. This account is independent of the web password.

Before connecting MCP tools, review the service's permissions and the `allowedTools`/`deniedTools` lists. `direct` mode calls tools without additional application confirmation, and an `execute` call does not guarantee that a tool is read-only. `legacy` mode retains `readTools`/`actionTools`, a read before the proposal, and operator confirmation. See [settings and tasks](docs/settings-and-tasks.md), [architecture and limitations](docs/architecture.md), and [deployment](docs/deployment.md).

## Licenses

This project's code is licensed under MIT; see [LICENSE](LICENSE). Third-party notices and references are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Verification

```sh
npm run check
npm run lint
npm run format:check
npm run build
npm test
```

`npm run format` applies Prettier to the entire repository.

See [verification evidence and limitations](docs/verification.md).

Tests use a faux provider, loopback HTTP MCP servers, and mocked Telegram transport. They include `SIGKILL` during generation, external effects, and sending; a recovery test waits 31 seconds for lock expiry. No real account is used. Mock coverage does not establish successful operation in a real Telegram client or CUA desktop.

## Appearance

The interface offers **Blue**, **Gray**, and **Pi** themes with independent **Light**, **Dark**, and **Automatic** modes. Pi follows the [official website's](https://pi.dev) style: warm paper in light mode, deep blue in dark mode, serif headings, straight borders, and a subtle grid. Selectors appear on the sign-in screen and in the navigation footer; on mobile, open the menu. Preferences are saved in the browser. Automatic mode follows the system setting.

The logo is Pi's official logo, the icons are Phosphor, and fonts are served locally. See [visual direction](docs/design.md) and [screenshots and checks](docs/verification.md#refinamento-visual-paletas-e-modos-de-aparência).
