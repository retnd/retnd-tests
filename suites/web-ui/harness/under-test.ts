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

/** The port this run serves the app under test on.
 *
 *  Two properties, both carried over from the old home for reasons that
 *  cost real time to learn (rclone-manager #172):
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
 *
 *  `E2E_PORT` still wins, and is validated rather than coerced. An explicit
 *  port is taken exactly as given, with no free-port scan: "use this port"
 *  and "use a port near this one" are different instructions.
 */
export function resolvePort(uiDir: string, env: NodeJS.ProcessEnv = process.env): number {
  if ((env.E2E_PORT ?? "").trim() !== "") return resolveE2EPort(env, uiDir);
  const start = derivePort(gitToplevel(uiDir));
  const chosen = execFileSync(
    process.execPath,
    [resolve(HERE, "pick-free-port.mjs"), String(start), String(PORT_FLOOR), String(PORT_SLOTS)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  ).trim();
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
