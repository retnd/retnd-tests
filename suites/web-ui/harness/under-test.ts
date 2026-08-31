// What this suite is testing, and where it serves it from.
//
// In its old home inside rclone-manager the answer was implicit: the app
// was the working tree the config file sat in. Out here it has to be
// stated, because a browser suite that quietly picks its own idea of "the
// app" is the exact failure this repository exists to prevent. So the app
// under test is resolved once, out loud, printed at startup, and the run
// refuses to start if it cannot be resolved.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PORT_FLOOR, PORT_SLOTS, derivePort, resolveE2EPort } from "../e2e/port";

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTS_REPO_ROOT = resolve(HERE, "../../..");

/** The rclone-manager `ui/shared` directory whose dev server this run drives.
 *
 *  Three sources, in order, and the run stops rather than guessing:
 *
 *  1. `RM_UI_DIR`, which is what rclone-manager's own gate sets: the app
 *     under test is then the working tree being committed, not a release.
 *  2. `RM_SOURCE_DIR/ui/shared`, so the same variable Suite A already uses
 *     to name a checkout works here too.
 *  3. the pinned build's own checkout, resolved by `tools/getbuild`. That
 *     also runs the identity handshake, so a standalone Suite B run has
 *     the same "the binary said which commit it is" evidence Suite A does.
 */
export function resolveUiDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.RM_UI_DIR ?? "").trim();
  if (explicit !== "") return checkUiDir(resolve(explicit), "RM_UI_DIR");

  const source = (env.RM_SOURCE_DIR ?? "").trim();
  if (source !== "") return checkUiDir(resolve(source, "ui/shared"), "RM_SOURCE_DIR/ui/shared");

  const build = JSON.parse(
    execFileSync("go", ["run", "./tools/getbuild/cmd/getbuild"], {
      cwd: TESTS_REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"]
    })
  ) as { source_dir?: string };

  if (!build.source_dir) {
    throw new Error(
      "the pinned build was resolved without a source checkout, so there is no ui/shared to serve. " +
        "Point this run at one with RM_UI_DIR=/path/to/rclone-manager/ui/shared, " +
        "or set RM_SOURCE_DIR to a checkout."
    );
  }
  return checkUiDir(resolve(build.source_dir, "ui/shared"), "the pinned build's checkout");
}

function checkUiDir(dir: string, origin: string): string {
  if (!existsSync(resolve(dir, "package.json"))) {
    throw new Error(`${origin} resolved to ${dir}, which has no package.json, so there is no dev server to start.`);
  }
  if (!existsSync(resolve(dir, "node_modules"))) {
    throw new Error(
      `${origin} resolved to ${dir}, whose dependencies are not installed, so \`npm run dev\` there would fail. ` +
        `Fix it with: cd ${dir} && npm ci`
    );
  }
  return dir;
}

/** The environment variable the runner hands its chosen port to its own
 *  workers through. Not a knob: nobody sets this by hand, and `E2E_PORT`
 *  is the documented way to name a port from outside. It exists because
 *  Playwright re-evaluates this config in every process it starts, and
 *  the answer has to be the same in all of them. */
export const PORT_HANDOFF_VAR = "__RM_E2E_PORT";

/** The port this run serves the app under test on.
 *
 *  Three properties, all bought expensively:
 *
 *  - **Per checkout, not per machine.** The default is derived from the
 *    git toplevel of the app under test, so two rclone-manager worktrees
 *    running this suite at once do not contend for one port. The derivation
 *    moved from "the checkout the config file is in" to "the checkout the
 *    app is in" because out here those are different repositories, and the
 *    one that varies per concurrent run is the second.
 *  - **Never a server this run did not start.** The port is probed free
 *    before Vite is asked for it, `--strictPort` stops Vite sliding to
 *    another one, and `reuseExistingServer` is false, so a run that cannot
 *    bind fails loudly instead of reporting on somebody else's build.
 *  - **The same answer in every process of one run.** See below.
 *
 *  `E2E_PORT` still wins, and is validated rather than coerced. An explicit
 *  port is taken exactly as given, with no free-port scan: "use this port"
 *  and "use a port near this one" are different instructions.
 *
 *  # Resolved once, then read back
 *
 *  Playwright evaluates `playwright.config.ts` in every process it starts:
 *  the runner, plus one per worker. Anything this file *computes* therefore
 *  has to come out the same in all of them, and a free-port scan does not.
 *  By the time a worker gets here the runner's own Vite is already holding
 *  the port the runner picked, so the worker's probe finds it taken, walks
 *  to the next slot, and ends up with a `baseURL` nothing is listening on.
 *  That is a race, and it lands on the side that works most of the time:
 *  it showed up once as a single `ERR_CONNECTION_REFUSED` out of 165, with
 *  the runner on 5930 and one worker on 5931.
 *
 *  The scan therefore runs in the runner only. The chosen port goes into
 *  the runner's own environment, workers are forked from it and inherit it,
 *  and every process after the first reads it back instead of asking the
 *  machine again. An inherited value is validated the same way `E2E_PORT`
 *  is, rather than coerced: a `Number()` over a stale or truncated value
 *  reaches `baseURL` as `NaN` and buys a 60 second webServer timeout that
 *  names the server instead of the variable.
 *
 *  The blocking CI signal never had this problem, because rclone-manager's
 *  gate picks a free port itself and passes `E2E_PORT`, which every process
 *  READS. This makes the standalone `make suite-b` path agree by the same
 *  construction rather than by luck.
 */
export function resolvePort(uiDir: string, env: NodeJS.ProcessEnv = process.env): number {
  if ((env.E2E_PORT ?? "").trim() !== "") return resolveE2EPort(env, uiDir);

  const inherited = (env[PORT_HANDOFF_VAR] ?? "").trim();
  if (inherited !== "") {
    if (!/^\d+$/.test(inherited) || Number(inherited) < 1 || Number(inherited) > 65535) {
      throw new Error(
        `${PORT_HANDOFF_VAR} was inherited as ${JSON.stringify(env[PORT_HANDOFF_VAR])}, which is not a port. ` +
          "This variable is set by the runner for its own workers and is not meant to be set by hand; " +
          "use E2E_PORT to name a port from outside."
      );
    }
    return Number(inherited);
  }

  const start = derivePort(gitToplevel(uiDir));
  const chosen = execFileSync(
    process.execPath,
    [resolve(HERE, "pick-free-port.mjs"), String(start), String(PORT_FLOOR), String(PORT_SLOTS)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  ).trim();
  env[PORT_HANDOFF_VAR] = chosen;
  return Number(chosen);
}

/** The checkout the app under test belongs to, falling back to the directory
 *  itself outside a checkout (a tarball, a container image) where every run
 *  is the only run anyway. */
export function gitToplevel(dir: string): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (root) return root;
  } catch {
    // Not a checkout, or no git on PATH.
  }
  return dir;
}
