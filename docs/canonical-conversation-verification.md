# Canonical conversation verification — 2026-10-15

> Historical design / desenho histórico: cross-channel continuation and mirroring are superseded by [channel separation / separação dos canais](channel-separation.md). Existing bindings and cron destinations remain intact.

Cloud workspace only; base `162590eccb1b5933db53d6c8d8b7877d7ec6cb42`, Node 24.19.0.

- `npm test`: 638 passed, 0 failed, 0 skipped; 79.74 seconds.
- `npm run check`, `npm run lint`, `npm run format:check`, `npm run build`, `git diff --check`: passed.
- Independent routing review reproduced and verified fixes for captured-origin route changes, revoke/regrant during answer retrieval and native creation, and stale receipt cancellation.
- Temporary SQLite, faux model and simulated Telegram cover A→B navigation, restart and deduplication, both creation interfaces, independent archive/revocation, ambiguous creation, legacy future selection, and inline response reconstruction beyond 1 MiB.
- Existing Markdown safety limits remain active. Expanded pages contain at most 16,384 visible characters and omit provider metadata.

No production access, credential changes, real Telegram messages, merge or deployment. Real Telegram clients and Safari/iOS were not tested.

## Validação em português

A suíte completa aprovou 638 testes, sem falhas ou testes ignorados. Tipos, lint, formatação e build passaram. A revisão independente verificou as corridas de rota, revogação/reautorização e criação nativa; os testes usam somente SQLite descartável, modelo faux e Telegram simulado. Respostas longas foram reconstruídas integralmente em páginas limitadas, mantendo as proteções Markdown.

Não houve acesso à produção, mudança de credenciais, envio real, merge ou deploy. Cliente Telegram real e Safari/iOS permanecem sem validação neste escopo.
