// One whole deployment, stood up per test and removed afterwards.
//
// What "the manager" means here is what `container/compose.yaml` means by
// it: two containers from one image, differing only in `command:`. The
// engine (`/backup-manager-web serve`) holds the API, local authentication
// and the scheduler, and publishes NO port at all. The UI host
// (`/backup-manager-web serve-ui`) serves the static bundle, reverse
// proxies `/api/v1` and `/health` to the engine over a private network, and
// is the only thing with a published port. Copying that split rather than
// running one process is the difference between testing a deployment and
// testing a binary: the browser here reaches the engine the way a browser
// on a NAS does, through the proxy, over the same two hops, with the same
// forwarded-header trust boundary between them.
//
// The third container is the machine being backed up. See harness/source.ts.
import { createServer } from "node:net";

import { docker, dockerOrThrow, installExitTeardown, Run } from "./docker";
import { checkoutDir, resolveImage, type ImageUnderTest } from "./image";
import { newPassword, redactLog, tokenFrom } from "./secrets";
import { buildSourceImage, startSource, type SourceMachine } from "./source";

/** The uid and gid the containers run as, and the ownership the volumes are
 *  given before first start. compose.yaml's PUID/PGID default, because this
 *  suite's job is to deploy the shipped shape rather than a convenient one:
 *  both services run non-root there, with a read-only rootfs, no
 *  capabilities and no new privileges, and all of that is copied below. */
const PUID = 1000;
const PGID = 1000;

/** The engine's network alias. compose's service name, which is what
 *  `serve-ui`'s own UPSTREAM_ADDR default points at, so the UI host's
 *  upstream here is spelled exactly the way a real deployment spells it. */
const ENGINE_ALIAS = "rclone-manager";

export interface Manager {
  engineContainer: string;
  uiContainer: string;
  /** Where the browser goes. Same origin as the API, which the built client
   *  requires: its BASE is a relative "/api/v1". */
  uiUrl: string;
  uiPort: number;
  /** Everything the engine has printed. The enrolment token is in here, and
   *  reading it from a container's log is the only way to get it, which is
   *  the point: it never becomes a file and never becomes an argument. */
  engineLog(): Promise<string>;
  /** What is on the manager's backup volume, relative to /data/backups. */
  backupsListing(relPath?: string): Promise<string[]>;
  /** The sha256 of one file on the backup volume, read by a container this
   *  run starts rather than by the engine that wrote it. What the UI
   *  reports and what is on disk are two different claims. */
  backupDigest(relPath: string): Promise<string>;
  /** A file from the state volume (state.db, local-auth.json), or null when
   *  it is not there. Returned rather than printed: local-auth.json holds
   *  an Argon2id hash, and a suite that dumps it into its own output has
   *  moved a credential somewhere new. */
  stateFile(name: string): Promise<string | null>;
  /** A file from the config volume, config.yaml being the one that matters. */
  configFile(name: string): Promise<string | null>;
  /** Stops and starts the engine, and waits for it to answer again. The
   *  first-run flow can end in "configuration saved, restart required", and
   *  a spec that has to get past that needs a restart rather than a
   *  workaround. */
  restartEngine(): Promise<void>;
}

export interface Deployment {
  runId: string;
  image: ImageUnderTest;
  /** Shorthand for manager.uiUrl, which is where every spec starts. */
  uiUrl: string;
  manager: Manager;
  source: SourceMachine;
  /** The administrator this run intends to create. The password is
   *  generated per run and held in memory only: nothing writes it to a
   *  file, into argv, or into the report. Enrolment is what turns this from
   *  an intention into an account, and it happens in the browser. */
  admin: { username: string; password: string };
  /** The one-time enrolment token, read out of the engine's log.
   *
   *  A function rather than a value, so nothing holds it before something
   *  needs it, and so the wait for the engine to have printed it belongs to
   *  the caller's step rather than to the boot. */
  enrolmentToken(): Promise<string>;
  stop(keep?: boolean): Promise<void>;
}

/** Stands the whole thing up.
 *
 *  Every failure below tears down what has been created so far and then
 *  rethrows. A half-booted deployment left behind is the same leak as a
 *  finished one, and it is likelier: the failures happen during the boot. */
export async function bootDeployment(): Promise<Deployment> {
  installExitTeardown();

  const image = await resolveImage();
  const run = new Run();

  try {
    const network = run.trackNetwork(run.name("net"));
    await dockerOrThrow("creating this run's network", [
      "network",
      "create",
      ...run.labelArgs(),
      network
    ]);

    // The manager's three host paths, as volumes rather than bind mounts.
    // compose binds host directories because an operator has a NAS share to
    // point at; a test does not, and a named volume removes cleanly and
    // carries no ownership from whatever the host filesystem happens to be.
    const stateVolume = run.trackVolume(run.name("state"));
    const backupsVolume = run.trackVolume(run.name("backups"));
    const configVolume = run.trackVolume(run.name("config"));
    for (const volume of [stateVolume, backupsVolume, configVolume]) {
      await dockerOrThrow(`creating volume ${volume}`, ["volume", "create", ...run.labelArgs(), volume]);
    }

    const toolImage = await buildSourceImage(checkoutDir(), image.commit);

    // The step docs/deployment.md tells an operator to do before first
    // start: the paths the engine writes into have to be owned by
    // PUID:PGID already, because the image has no shell, no root step and
    // no init to chown them. A fresh named volume is root-owned, so
    // without this the engine comes up as uid 1000 and cannot write a
    // thing. Done with the one image this run is guaranteed to have.
    await dockerOrThrow("giving the manager's volumes to the uid it runs as", [
      "run",
      "--rm",
      ...run.labelArgs(),
      "--network",
      "none",
      // Straight to the binary, past the image's own entrypoint. That
      // entrypoint is atmoz/sftp's, which creates users and generates a
      // 4096-bit RSA host key before it runs anything, and this container
      // exists to run one chown.
      "--entrypoint",
      "chown",
      "-v",
      `${stateVolume}:/data/state`,
      "-v",
      `${backupsVolume}:/data/backups`,
      "-v",
      `${configVolume}:/etc/backup-manager/config`,
      toolImage,
      `${PUID}:${PGID}`,
      "/data/state",
      "/data/backups",
      "/etc/backup-manager/config"
    ]);

    // Chosen before the engine starts, because the engine has to be told
    // the URL an operator will actually open: it prints the enrolment link
    // against that, and its own address is not reachable from anywhere.
    //
    // The window between probing this free and binding it is real. It is
    // also the whole defence, and it is enough here: the port is published
    // by a container THIS run starts, so losing the race is a start failure
    // rather than a run that reports on somebody else's deployment. That is
    // the same argument suites/web-ui makes for refusing to reuse a server,
    // and it matters more with containers, not less.
    const uiPort = await freePort();
    const uiUrl = `http://127.0.0.1:${uiPort}`;

    const engineContainer = await run.claimContainer("engine");
    await dockerOrThrow("starting the engine", [
      "run",
      "-d",
      "--name",
      engineContainer,
      "--network",
      network,
      "--network-alias",
      ENGINE_ALIAS,
      ...run.labelArgs(),
      // compose's x-security, verbatim: no capabilities, no new
      // privileges, read-only rootfs, non-root. A suite that quietly
      // relaxed any of these would be deploying a shape nobody ships.
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--read-only",
      "--user",
      `${PUID}:${PGID}`,
      "--tmpfs",
      `/tmp:size=64m,mode=1777,uid=${PUID},gid=${PGID}`,
      // The three paths compose binds host directories to. The state
      // directory is a directory rather than a file because SQLite in WAL
      // mode writes -wal and -shm beside the database, and the config
      // directory is a directory for the reason issue #196 gives: the
      // engine replaces config.yaml through a temp file in its own
      // directory, and a bind of the file alone leaves that directory
      // read-only. Both are also the only shapes that can honestly be
      // EMPTY, which is the state a fresh install starts in.
      "-v",
      `${stateVolume}:/data/state`,
      "-v",
      `${backupsVolume}:/data/backups`,
      "-v",
      `${configVolume}:/etc/backup-manager/config`,
      // compose has two more mounts, the SSH private key and the pinned
      // known_hosts file, and they are deliberately not here. Both are
      // read-only host files an operator brings, and this suite has
      // neither: the key material a backup set uses is minted or imported
      // through the Web UI, into the engine's own ssh_keys/ store beside
      // config.yaml, which is the path the wizard actually takes and the
      // one the wizard specs need to exercise. Mounting a key from here
      // would be arranging the answer to a question those specs are for.

      // Deliberately not compose's `unless-stopped`. A container that
      // restarts itself hides a crash behind a healthy-looking service,
      // and a test needs the crash.
      "--restart",
      "no",
      // The image's own HEALTHCHECK is `/backup-manager status`, which is
      // backup FRESHNESS: it exits non-zero for an instance nobody has
      // configured yet, which is every deployment this suite starts. compose
      // overrides it with a liveness probe for exactly that reason, and its
      // own comment is worth reading on why freshness is the wrong question
      // for a start gate. The docker CLI can only express a healthcheck
      // through a shell and this image has none, so the override is not
      // available here: the same liveness probe runs from the harness
      // instead (see waitForEngine), and the daemon's own check is turned
      // off rather than left answering the wrong question and marking a
      // perfectly good container unhealthy.
      "--no-healthcheck",
      "-e",
      "LISTEN_ADDR=:8080",
      "-e",
      "TMPDIR=/tmp",
      "-e",
      "TZ=UTC",
      "-e",
      `PUBLIC_BASE_URL=${uiUrl}`,
      // Safe for the same reason compose says it is: the only peer this
      // container can have is the UI host, because it publishes no port and
      // joins no other network.
      "-e",
      "TRUST_FORWARDED_HEADERS=true",
      // No published port. Not an omission: it is the deployment's actual
      // network isolation, and a suite that published one here would be
      // testing a different topology from the one that ships.
      image.reference,
      "/backup-manager-web",
      "serve",
      "--profile=generic"
    ]);
    await waitForEngine(engineContainer);

    const uiContainer = await run.claimContainer("ui");
    await dockerOrThrow("starting the UI host", [
      "run",
      "-d",
      "--name",
      uiContainer,
      "--network",
      network,
      ...run.labelArgs(),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--read-only",
      "--user",
      `${PUID}:${PGID}`,
      "--tmpfs",
      `/tmp:size=16m,mode=1777,uid=${PUID},gid=${PGID}`,
      "--restart",
      "no",
      // Same as the engine: the image's freshness HEALTHCHECK is the wrong
      // question for this container, which has no backup state at all.
      "--no-healthcheck",
      "-e",
      "LISTEN_ADDR=:8080",
      "-e",
      "TMPDIR=/tmp",
      "-e",
      "TZ=UTC",
      "-e",
      `UPSTREAM_ADDR=http://${ENGINE_ALIAS}:8080`,
      // Loopback only. The published port is how the browser gets in, and
      // binding it to 127.0.0.1 keeps a test deployment off the LAN of
      // whoever is running the suite.
      "-p",
      `127.0.0.1:${uiPort}:8080`,
      image.reference,
      "/backup-manager-web",
      "serve-ui",
      "--profile=generic"
    ]);
    await waitForUi(uiUrl, uiContainer);

    const source = await startSource(run, network, toolImage);

    const manager: Manager = {
      engineContainer,
      uiContainer,
      uiUrl,
      uiPort,
      engineLog: async () => redactLog(await rawLog(engineContainer)),
      backupsListing: (relPath = "") => listing(run, toolImage, backupsVolume, relPath),
      backupDigest: (relPath) => volumeDigest(run, toolImage, backupsVolume, relPath),
      stateFile: (name) => readVolumeFile(run, toolImage, stateVolume, name),
      configFile: (name) => readVolumeFile(run, toolImage, configVolume, name),
      restartEngine: async () => {
        await dockerOrThrow("restarting the engine", ["restart", engineContainer]);
        await waitForEngine(engineContainer);
        await waitForUi(uiUrl, uiContainer);
      }
    };

    return {
      runId: run.id,
      image,
      uiUrl,
      manager,
      source,
      admin: { username: "live-admin", password: newPassword() },
      enrolmentToken: () => enrolmentToken(engineContainer),
      stop: (keep = false) => run.teardown(keep)
    };
  } catch (err) {
    await run.teardown();
    throw err;
  }
}

/** Waits on the engine's own liveness probe, run the way compose runs it:
 *  the same subcommand, against the same URL, inside the container. It
 *  needs no shell, which is what makes it usable at all against a
 *  distroless image, and no published port, which is what makes it usable
 *  against a container that deliberately has none. */
async function waitForEngine(container: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const alive = await docker([
      "exec",
      container,
      "/backup-manager-web",
      "healthcheck",
      "--url",
      "http://127.0.0.1:8080/health/live"
    ]);
    if (alive.code === 0) return;
    // A container that has stopped is not going to start answering, and
    // waiting the rest of the budget out only delays a failure that is
    // already decided. Its log is the whole story, and it is right there.
    if (!(await isRunning(container))) {
      throw new Error(
        `the engine started and then exited, so there is nothing to drive.\nits log:\n${await tailLog(container)}`
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the engine never became live within 120s.\nits log:\n${await tailLog(container)}\n` +
          `last probe: ${alive.stderr.trim() || alive.stdout.trim()}`
      );
    }
    await sleep(400);
  }
}

/** Waits on `/health/live` THROUGH the UI host, from this process.
 *
 *  One request that answers three questions at once: the published port is
 *  reachable from here, the UI host is serving, and its reverse proxy can
 *  reach the engine. `serve-ui` forwards /health/ and /api/v1/ upstream
 *  unchanged, so a 200 here is the engine answering, which is exactly the
 *  path every request the browser makes will take. */
async function waitForUi(uiUrl: string, container: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let last = "";
  for (;;) {
    try {
      const res = await fetch(`${uiUrl}/health/live`);
      if (res.status === 200) return;
      last = `${res.status} from ${uiUrl}/health/live`;
    } catch (err) {
      last = String(err);
    }
    if (!(await isRunning(container))) {
      throw new Error(
        `the UI host started and then exited, so nothing is serving the app.\n` +
          `its log:\n${await tailLog(container)}`
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `nothing answered ${uiUrl}/health/live within 120s (last: ${last}).\n` +
          `the UI host's log:\n${await tailLog(container)}\n` +
          "If the Docker daemon is not on this machine, a port published to 127.0.0.1 is not reachable from here."
      );
    }
    await sleep(250);
  }
}

/** The one-time token, out of the engine's log and into a variable.
 *
 *  It is printed once, at startup, before anything is enrolled, so this
 *  usually answers immediately; the wait is here because "the container is
 *  live" and "the container has flushed its first line" are different
 *  moments and the gap is not zero.
 *
 *  Nothing about this function prints, and its failure message does not
 *  quote the log: a log with a token in it is the one thing that must not
 *  end up in the output of a run that failed to find the token in it. */
async function enrolmentToken(container: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const token = tokenFrom(await rawLog(container));
    if (token) return token;
    if (Date.now() > deadline) {
      throw new Error(
        "the engine printed no enrolment notice within 30s, so this run has no way to enrol an administrator. " +
          "Either something is already enrolled on this deployment, which cannot happen on a volume this run " +
          "created, or the notice has changed shape (apps/common/auth/local prints it). The log is deliberately " +
          "not quoted here: on the run where this message is wrong, the log has a live one-time token in it."
      );
    }
    await sleep(250);
  }
}

/** A port nothing is listening on, taken from the ephemeral range.
 *
 *  Lifted from suites/equivalence/harness/stack.ts, with the same caveat
 *  and the same answer: the window between the probe and the bind is real,
 *  and it is survivable because everything this suite talks to is something
 *  it started. */
async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const server = createServer();
    server.once("error", rej);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) return rej(new Error("no port"));
      const port = addr.port;
      server.close(() => res(port));
    });
  });
}

/** Reading a volume needs a container, because the containers that own
 *  these volumes are distroless and have no shell, no find and no
 *  sha256sum. So every read below runs the one image this run is guaranteed
 *  to have, with the volume mounted read-only at one fixed path, on no
 *  network, removed on exit. It carries the run's labels so that a stray
 *  left by an interrupt is still something teardown sweeps up.
 *
 *  Read-only, and that is the contract rather than caution: nothing in this
 *  suite is allowed to reach into a volume and change what the engine
 *  wrote. A harness that can edit the thing it is measuring is not
 *  measuring it.
 *
 *  The mount path is a name nothing else has, and that is load-bearing
 *  rather than tidy. Docker populates an EMPTY named volume from whatever
 *  the image has at the mount point the first time something mounts it,
 *  and "populates" includes stamping the mount point's own ownership onto
 *  the volume. Read-only does not stop it: the copy happens before the
 *  flag applies. So reading a still-empty volume at `/mnt`, which exists
 *  in the tool image owned by root, handed the volume to root, and the
 *  engine runs as uid 1000. Every transfer after that died on
 *  "mkdir /data/backups/<set>: permission denied", and an SSH-key import
 *  against a config volume that had been read while empty died the same
 *  way, both several steps downstream of the read that caused it.
 *
 *  A path the image does not have has nothing to copy and nothing to
 *  stamp, so the chown above survives. This is the one place in the
 *  harness where reading really could change what it was measuring, which
 *  is exactly what the paragraph above says must not happen. */
const READ_MOUNT = "/rmlive-volume";

async function volumeRead(run: Run, image: string, volume: string, argv: string[]) {
  const [binary, ...args] = argv;
  return docker([
    "run",
    "--rm",
    ...run.labelArgs(),
    "--network",
    "none",
    // Past the image's entrypoint, for the same reason the chown above
    // does it: these reads happen several times per spec and none of them
    // wants a user-creating, host-key-generating shell script in front of
    // it.
    "--entrypoint",
    binary,
    "-v",
    `${volume}:${READ_MOUNT}:ro`,
    image,
    ...args
  ]);
}

async function listing(run: Run, image: string, volume: string, relPath: string): Promise<string[]> {
  const at = relPath === "" ? READ_MOUNT : `${READ_MOUNT}/${relPath}`;
  const out = await volumeRead(run, image, volume, ["find", at, "-type", "f"]);
  if (out.code !== 0) return [];
  return out.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.slice(READ_MOUNT.length + 1))
    .sort();
}

async function volumeDigest(run: Run, image: string, volume: string, relPath: string): Promise<string> {
  const out = await volumeRead(run, image, volume, ["sha256sum", `${READ_MOUNT}/${relPath}`]);
  if (out.code !== 0) {
    throw new Error(`nothing to digest at ${relPath} on the manager: ${out.stderr.trim() || out.stdout.trim()}`);
  }
  const digest = out.stdout.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`sha256sum ${relPath} answered something that is not a digest: ${out.stdout.trim()}`);
  }
  return digest;
}

async function readVolumeFile(run: Run, image: string, volume: string, relPath: string): Promise<string | null> {
  const out = await volumeRead(run, image, volume, ["cat", `${READ_MOUNT}/${relPath}`]);
  return out.code === 0 ? out.stdout : null;
}

async function isRunning(container: string): Promise<boolean> {
  const state = await docker(["inspect", "-f", "{{.State.Running}}", container]);
  return state.code === 0 && state.stdout.trim() === "true";
}

/** A container's whole log, unredacted. One caller: finding the enrolment
 *  token, which is the only thing that needs it that way. */
async function rawLog(container: string): Promise<string> {
  const logs = await docker(["logs", container]);
  return logs.stdout + logs.stderr;
}

/** The tail of a container's log, for a failure message, with the token
 *  taken out. A boot that failed for some reason OTHER than the token is
 *  exactly when a log with a live one in it gets quoted into the output. */
async function tailLog(container: string): Promise<string> {
  const logs = await docker(["logs", "--tail", "60", container]);
  return redactLog(logs.stdout + logs.stderr);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
