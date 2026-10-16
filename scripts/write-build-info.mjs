import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readAppInfo } from "../dist/src/app-info.js";

// This runs only after compilation, never at application startup.
const root = pathToFileURL(process.cwd() + "/");
await writeFile(
  new URL("dist/build-info.json", root),
  JSON.stringify({
    ...readAppInfo(root, true),
    builtAt: new Date().toISOString(),
  }) + "\n",
);
