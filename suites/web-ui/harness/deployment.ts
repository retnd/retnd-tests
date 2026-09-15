// Which deployment this run drives, read out of the environment and
// nothing else.
//
// This file replaced `under-test.ts`, and the two answer opposite
// questions. That one resolved a `ui/shared` DIRECTORY and a free port,
// because the run's job was to start a Vite dev server over the mock API
// and point a browser at it. This one resolves a URL, because the run's
// job is now to drive a deployment somebody else already stood up: a
// browser in one container, `backupd-web serve-ui` in another, a real sshd in
// a third, all on a private Docker network, with SQLite behind the whole
// thing.
//
// Every value below is required or optional on purpose, and the required
// ones have no default. A base URL that silently fell back to
// `http://localhost:...` is how a suite goes back to testing nothing
// while still reporting green, which is the failure this whole repository
// exists to prevent.
//
// EPIC L (backupd#816) added a second family of them. The workflow
// fixtures - which seeded backup set carries which hook scenario, and
// where the control directory that can crash the engine mid-run is - live
// in `harness/workflow.ts` beside the protocol they belong to, and are
// carried here so that one call resolves everything this run was told.

import { type WorkflowFixtures, resolveWorkflowFixtures } from "./workflow";

/** The providers a Web UI bundle can be built for. The bundle is chosen at
 *  BUILD time (VITE_PLATFORM, and `serve-ui --profile`), so a run drives
 *  exactly one of these: the one the image under test was built with. */
export const PROVIDERS = [
  "generic",
  "ugos",
  "synology",
  "truenas",
  "unraid",
  "openmediavault",
  "proxmox"
] as const;

export type Provider = (typeof PROVIDERS)[number];

/** The SSH source machine the deployment ingests from, when the run was
 *  told where it is. Optional, because most of this suite reads pages that
 *  are already populated; the wizard's own "prove the source" cases are
 *  the ones that need a host they can really reach. */
export interface SourceMachine {
  host: string;
  port: number;
  user: string;
  path: string;
}

export interface Deployment {
  /** Where the Web UI answers, on the private network the runner is on.
   *  A container name and a port, e.g. `http://backupd:8080`. */
  baseURL: string;
  /** The throwaway administrator this run signs in as. Held in memory for
   *  the length of the run and written nowhere. */
  credentials: { username: string; password: string };
  /** The single-use enrolment token, when the deployment handed one over.
   *  Present only on a deployment that has no administrator yet. */
  bootstrapToken: string | null;
  /** The backup set the topology seeded and ingested before this run
   *  started, in `source/set` form (e.g. `e2e/vps`), or null when the run
   *  was not told about one.
   *
   *  It is an anchor rather than a configuration: a spec can assert that
   *  the set the topology says it created is the set the page is showing,
   *  which is a claim that spans the whole path from the browser to
   *  SQLite and is the sharpest single thing this move buys. */
  seededBackupSet: string | null;
  /** Which provider bundle the image under test serves. */
  platform: Provider;
  /** Whether this run may take actions that destroy data it cannot put
   *  back: applying a retention plan is the whole list today. Off unless
   *  the deployment says it is disposable. */
  allowDestructive: boolean;
  source: SourceMachine | null;
  /** Which workflow fixture states the rig seeded, and under which
   *  backup set names. Every field nullable: a rig that seeded none of
   *  them is an ordinary Suite B deployment, and the workflow specs say
   *  so rather than asserting against a set with no hooks in it. */
  workflow: WorkflowFixtures;
}

export const BASE_URL_VAR = "RM_BASE_URL";
export const USERNAME_VAR = "RM_ADMIN_USERNAME";
export const PASSWORD_VAR = "RM_ADMIN_PASSWORD";
export const BOOTSTRAP_TOKEN_VAR = "RM_BOOTSTRAP_TOKEN";
export const BACKUP_SET_VAR = "RM_BACKUP_SET";
export const PLATFORM_VAR = "RM_PLATFORM";
export const DESTRUCTIVE_VAR = "RM_ALLOW_DESTRUCTIVE";
export const WORKERS_VAR = "RM_WORKERS";
export const OUTPUT_DIR_VAR = "RM_ARTIFACTS_DIR";
export const NO_SANDBOX_VAR = "RM_NO_SANDBOX";
export const SOURCE_HOST_VAR = "RM_VPS_HOST";
export const SOURCE_PORT_VAR = "RM_VPS_PORT";
export const SOURCE_USER_VAR = "RM_VPS_USER";
export const SOURCE_PATH_VAR = "RM_VPS_PATH";

function required(env: NodeJS.ProcessEnv, name: string, what: string): string {
  const value = (env[name] ?? "").trim();
  if (value === "") {
    throw new Error(
      name +
        " is not set, and there is no default for it. " +
        what +
        " This suite drives a deployment it did not create, so it cannot guess one: " +
        "a fallback to localhost would let a run report green against nothing at all."
    );
  }
  return value;
}

/** The Web UI's base URL on the private network.
 *
 *  Validated as a URL rather than taken as a string, because the failure
 *  it prevents is expensive and silent: a value with a stray quote or a
 *  missing scheme reaches `page.goto` as a relative path and the run
 *  spends its whole budget on navigations that were never going to
 *  resolve.
 *
 *  A trailing slash is trimmed so `baseURL + "/activity"` and Playwright's
 *  own relative-URL resolution agree about what the path is. */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = required(
    env,
    BASE_URL_VAR,
    "It names the container serving the Web UI on the private Docker network, " +
      "resolved by Docker's embedded DNS, e.g. http://backupd:8080."
  );

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      BASE_URL_VAR + " is not a URL. It wants a scheme and a host, e.g. http://backupd:8080."
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // A bare `backupd:8080` lands here rather than in the catch
    // above, because URL parses it happily as a scheme called
    // `backupd`. So the message names the likely mistake as well as
    // the rule: what is missing is `http://`, not the host.
    throw new Error(
      BASE_URL_VAR + "=" + JSON.stringify(raw) + " is not a URL a browser can be pointed at: " +
        "its scheme is " + parsed.protocol + " and it wants http or https. " +
        "A value like host:port parses as a scheme; write http://host:port."
    );
  }
  return raw.replace(/\/+$/, "");
}

/** Which provider bundle the image under test serves.
 *
 *  Refused rather than defaulted when it is spelled wrong. The old suite
 *  read `VITE_PLATFORM` and could re-run the provider spec seven times by
 *  restarting Vite with a different value each time. Nothing here can do
 *  that: the bundle is chosen when the image is built, so this variable
 *  DESCRIBES the deployment rather than configuring it, and a wrong value
 *  makes the provider spec assert another platform's treatment against
 *  this one. */
export function resolvePlatform(env: NodeJS.ProcessEnv = process.env): Provider {
  const raw = (env[PLATFORM_VAR] ?? "").trim();
  if (raw === "") return "generic";
  const known = PROVIDERS.find((p) => p === raw);
  if (!known) {
    throw new Error(
      PLATFORM_VAR + "=" + JSON.stringify(raw) + " names no provider this product ships. " +
        "It has to be one of: " + PROVIDERS.join(", ") + ". " +
        "It describes which bundle the image under test was built with; it does not choose one."
    );
  }
  return known;
}

function resolveSource(env: NodeJS.ProcessEnv): SourceMachine | null {
  const host = (env[SOURCE_HOST_VAR] ?? "").trim();
  if (host === "") return null;

  const port = Number((env[SOURCE_PORT_VAR] ?? "22").trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(SOURCE_PORT_VAR + " is not a port. Leave it unset for 22.");
  }
  const user = (env[SOURCE_USER_VAR] ?? "").trim();
  const path = (env[SOURCE_PATH_VAR] ?? "").trim();
  if (user === "" || path === "") {
    throw new Error(
      SOURCE_HOST_VAR + " is set, so the run is being told about a real source machine, " +
        "but " + SOURCE_USER_VAR + " and " + SOURCE_PATH_VAR + " have to come with it: " +
        "a hostname on its own cannot be listed, and the wizard's own cases prove a source by listing it."
    );
  }
  return { host, port, user, path };
}

/** Everything this run knows about the deployment it is pointed at.
 *
 *  Resolved once, in the runner, and printed (minus the password) so a
 *  passing run has said out loud what it passed against. */
export function resolveDeployment(env: NodeJS.ProcessEnv = process.env): Deployment {
  const baseURL = resolveBaseUrl(env);
  const username = required(
    env,
    USERNAME_VAR,
    "It names the throwaway administrator this run signs in as."
  );
  const password = required(
    env,
    PASSWORD_VAR,
    "It carries the throwaway administrator's password. It stays in this process's environment: " +
      "nothing here writes it to a file, puts it in an argv, or prints it."
  );
  const bootstrapToken = (env[BOOTSTRAP_TOKEN_VAR] ?? "").trim();
  const seeded = (env[BACKUP_SET_VAR] ?? "").trim();
  if (seeded !== "" && !/^[^/]+\/[^/]+$/.test(seeded)) {
    throw new Error(
      BACKUP_SET_VAR + "=" + JSON.stringify(seeded) + " is not a backup set id. They are two " +
        "segments, source and set, e.g. e2e/vps (core/internal/model's BackupSetID.String())."
    );
  }

  return {
    baseURL,
    credentials: { username, password },
    bootstrapToken: bootstrapToken === "" ? null : bootstrapToken,
    seededBackupSet: seeded === "" ? null : seeded,
    platform: resolvePlatform(env),
    allowDestructive: (env[DESTRUCTIVE_VAR] ?? "").trim() === "1",
    source: resolveSource(env),
    workflow: resolveWorkflowFixtures(env)
  };
}

/** How many browsers run at once.
 *
 *  One, unless the caller insists. Not a performance choice: one
 *  deployment is one SQLite database, and this suite both reads it and
 *  writes it. A retention policy saved by one worker is read back by
 *  another, a backup set created in the wizard changes what every list
 *  page shows, and a page asserting on a count is asserting on state some
 *  other worker is in the middle of changing. Against the mock that could
 *  not happen: each browser had its own in-memory fixture.
 *
 *  `RM_WORKERS` exists for a run that has been narrowed to read-only
 *  specs and wants them faster. It is not a knob to turn when the suite is
 *  slow. */
export function resolveWorkers(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[WORKERS_VAR] ?? "").trim();
  if (raw === "") return 1;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(WORKERS_VAR + "=" + JSON.stringify(raw) + " is not a worker count.");
  }
  return Number(raw);
}

/** Chromium's own flags, for a browser that is running inside a container.
 *
 *  `--disable-dev-shm-usage` unconditionally: a container's `/dev/shm` is
 *  64MB by default, Chromium puts its renderer's shared memory there, and
 *  the tab dies with a bare "Target closed" that reads as a product
 *  failure. Telling Chromium to use `/tmp` instead costs nothing on a host
 *  that sized `/dev/shm` properly.
 *
 *  `--no-sandbox` only when asked, because it is a real reduction in
 *  isolation and it is only needed by an image that runs the browser as
 *  root. An image built on Playwright's own base runs as `pwuser` and does
 *  not need it. */
export function resolveChromiumArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args = ["--disable-dev-shm-usage"];
  if ((env[NO_SANDBOX_VAR] ?? "").trim() === "1") args.push("--no-sandbox");
  return args;
}

/** Where this run's evidence goes: traces, screenshots, videos, and the
 *  HTML report.
 *
 *  Two SUBDIRECTORIES of `RM_ARTIFACTS_DIR`, never the directory itself,
 *  and that is not tidiness. Playwright removes its own `outputDir`
 *  between runs, so pointing it at the mount point makes the run die
 *  before it starts a browser:
 *
 *      Error: EACCES: permission denied, rmdir '/artifacts'
 *
 *  A bind mount cannot be unlinked from inside the container. It also
 *  refuses an HTML report folder nested inside the test output folder, so
 *  the two are siblings rather than one inside the other. Both are still
 *  under the directory the client container mounts out, which is the
 *  property that matters: a failure here happens on a private network
 *  against a deployment that is deleted seconds later, so evidence that
 *  does not survive teardown is evidence nobody ever reads. */
export function resolveArtifactPaths(env: NodeJS.ProcessEnv = process.env): {
  outputDir: string;
  htmlReport: string;
} {
  const raw = (env[OUTPUT_DIR_VAR] ?? "").trim();
  const root = (raw === "" ? "." : raw).replace(/\/+$/, "");
  return { outputDir: root + "/test-results", htmlReport: root + "/html-report" };
}
