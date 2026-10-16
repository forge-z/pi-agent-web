import type { Runtime } from "./runtime.js";

export const humanControlResource = (resource: string) =>
  /^(?:\/cua-handoffs\/[a-f0-9-]+\/(?:create|end)|\/mcp-interactions\/[a-f0-9-]+|\/mcp-calls\/[a-f0-9]{24}\/reconcile|\/actions\/[a-f0-9]{24})$/.test(
    resource,
  );

/** Operational projection only. Never inspect the transcript or return completed tool data. */
export function humanControls(app: Runtime, id: string) {
  return {
    actions: app.store
      .all<{
        id: string;
        server: string;
        tool: string;
        state: string;
        args: string | null;
      }>(
        "SELECT id,server,tool,state,CASE WHEN state='pending' THEN args ELSE NULL END AS args FROM actions WHERE conversationId=? AND state IN ('pending','uncertain') ORDER BY rowid",
        id,
      )
      .map(({ args, ...row }) => ({
        ...row,
        ...(args === null ? {} : { args }),
      })),
    mcpInteractions:
      app.mcpCalls
        ?.interactions(id)
        .filter((row) => row.state === "pending")
        .map(({ id, server, kind, payload }) => ({
          id,
          server,
          kind,
          payload: controlPayload(payload),
        })) ?? [],
    mcpCalls:
      app.mcpCalls
        ?.list(id)
        .filter((row) => row.state === "uncertain")
        .map(({ id, server, tool, state }) => ({ id, server, tool, state })) ??
      [],
    cuaHandoffs:
      app.cuaHandoffs
        ?.list(id)
        .filter((row) => row.state !== "ended")
        .map(({ id, server, state, expiresAt, url, clipboard }) => ({
          id,
          server,
          state,
          expiresAt,
          url,
          clipboard,
        })) ?? [],
  };
}

function controlPayload(encoded: string) {
  const value = JSON.parse(encoded) as Record<string, unknown>;
  const interaction =
    value.interaction &&
    typeof value.interaction === "object" &&
    !Array.isArray(value.interaction)
      ? (value.interaction as Record<string, unknown>)
      : {};
  return JSON.stringify({
    message: value.message ?? interaction.message,
    requestedSchema: value.requestedSchema ?? interaction.requestedSchema,
    url: value.url ?? interaction.url,
    source: value.source,
  });
}
