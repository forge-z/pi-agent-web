import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";

const app = await Runtime.open({
  dir: process.argv[2],
  gateway: { call: async () => ({}) },
});
const web = createAppServer(app, {
  password: "test-password-123",
  origin: "http://127.0.0.1:3000",
  secureCookie: false,
});
await new Promise<void>((resolve) =>
  web.server.listen(0, "127.0.0.1", resolve),
);
const address = web.server.address();
if (!address || typeof address !== "object") throw new Error("No HTTP port");
process.send?.(address.port);
process.once("message", async () => {
  await web.close();
  await app.close();
  process.disconnect();
});
