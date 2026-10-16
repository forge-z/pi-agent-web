import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const development = import.meta.url.endsWith(".ts");
const appRoot = new URL(development ? "../" : "../../", import.meta.url);
const commitHash = (value: unknown, short = false) =>
  typeof value === "string" &&
  (short
    ? /^(?:[a-f0-9]{7}|[a-f0-9]{40}|[a-f0-9]{64})$/i
    : /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i
  ).test(value.trim())
    ? value.trim().toLowerCase().slice(0, 7)
    : null;
function readJson(file: URL) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** Return only public identity fields. Build dates come exclusively from the build artifact. */
export function readAppInfo(
  root = appRoot,
  source = development,
  sourceCommit = process.env.SOURCE_COMMIT,
) {
  const pkg = readJson(new URL("package.json", root));
  const build = source ? {} : readJson(new URL("dist/build-info.json", root));
  let commit = commitHash(build.commit, true);
  if (source) {
    try {
      commit = commitHash(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1000,
        }),
      );
    } catch {
      // Source archives and Docker builds may not include Git metadata.
    }
  }
  commit ??= commitHash(sourceCommit);
  const builtAt =
    typeof build.builtAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(build.builtAt) &&
    Number.isFinite(Date.parse(build.builtAt)) &&
    new Date(build.builtAt).toISOString() === build.builtAt
      ? build.builtAt
      : null;
  return {
    version:
      typeof pkg.version === "string" &&
      /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(pkg.version)
        ? pkg.version
        : null,
    commit,
    builtAt,
  };
}
