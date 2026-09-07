// The Docker CLI, and the bookkeeping that makes a run leave nothing
// behind.
//
// Everything this suite creates goes through `Run`. It is not a
// convenience: teardown here has to happen on every exit path, including
// the ones a Playwright fixture never sees, and something has to be
// holding the list of what to remove when a signal arrives mid-boot.
// scripts/e2e/two-machine-backup.sh in the product repository is the same
// shape written in bash, and its lessons are carried over one by one:
// register a thing the moment it exists rather than after the step
// finishes, remove containers before the network they are on, remove
// volumes explicitly because `docker rm` alone leaves them, and treat an
// interrupt as an exit rather than as something to resume from.
import { spawn, spawnSync } from "node:child_process";

/** How long any single docker command may take before it is treated as a
 *  hung daemon rather than a slow one. Every wait in here is bounded, for
 *  the reason the two-machine script gives for its own: an end-to-end test
 *  that hangs forever on a cold machine is worse than one that fails. */
const DOCKER_TIMEOUT_MS = 300_000;

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Written to the child's stdin and closed. This is how anything
   *  sensitive reaches a container: an argument list is readable by every
   *  process on the machine through `ps`, and stdin is not. */
  input?: Buffer | string;
  timeoutMs?: number;
}

/** One docker invocation. Never throws on a non-zero exit; callers decide
 *  whether a failure is a failure, because several of them (an inspect
 *  that answers "no such object", a removal of something already gone) are
 *  the expected answer rather than a problem. */
export function docker(args: string[], opts: RunOptions = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`docker ${args[0] ?? ""} did not finish within ${opts.timeoutMs ?? DOCKER_TIMEOUT_MS}ms`));
    }, opts.timeoutMs ?? DOCKER_TIMEOUT_MS);

    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });

    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** The same, for the calls whose failure means the run cannot continue.
 *  `what` is what the message leads with, so a failure names the step
 *  rather than only the command. */
export async function dockerOrThrow(what: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const r = await docker(args, opts);
  if (r.code !== 0) {
    throw new Error(`${what} failed (docker exited ${r.code}):\n${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}

/** Refuses the run when Docker is not there, rather than skipping it.
 *
 *  This is the one preflight that is not about tidiness. This repository's
 *  gate distinguishes "performed and passed" from "could not perform", and
 *  a browser suite that quietly reports green on a machine where it never
 *  stood anything up has answered a question nobody asked. So a missing or
 *  stopped daemon is a hard, loud failure with the fix in the message.
 *
 *  Deliberately not a `test.skip`. A skip is invisible in a pass count, and
 *  the pass count is what people read. */
export async function requireDocker(): Promise<void> {
  let info: Result;
  try {
    info = await docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 30_000 });
  } catch (err) {
    throw new Error(
      "Suite D needs Docker and could not run the docker CLI at all: " +
        String(err) +
        "\nThis suite stands up the real deployment in containers, so there is nothing to fall back to. " +
        "It refuses rather than skipping, because a suite that cannot tell you whether it performed the proof " +
        "is worse than one that says it could not."
    );
  }
  if (info.code !== 0) {
    throw new Error(
      "Suite D needs a reachable Docker daemon, and `docker info` failed:\n" +
        (info.stderr.trim() || info.stdout.trim()) +
        "\nStart Docker and run this again. This suite refuses rather than skipping: reporting a pass for a run " +
        "that never stood anything up is the one thing it must not do."
    );
  }
}

/** A per-run identity. Every container, network and volume name carries it,
 *  so two runs on one machine cannot collide over a name, and nothing this
 *  run removes can belong to another one. */
export function newRunId(): string {
  return `${process.pid.toString(36)}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export const SUITE_LABEL = "rclone-manager-tests.suite=live-deployment";

/** Everything one run created, and the only thing that removes it.
 *
 *  Names are per run and are never reused, and `claim` refuses a name that
 *  already exists rather than adopting it. suites/web-ui's config makes the
 *  same refusal about a dev server and explains what it cost to learn;
 *  containers make that hazard worse, because a leftover from another
 *  checkout answers on its port and reports healthy while serving a
 *  different build. */
export class Run {
  readonly id: string;
  readonly label: string;
  private readonly containers: string[] = [];
  private readonly networks: string[] = [];
  private readonly volumes: string[] = [];
  private stopped = false;

  constructor(id: string = newRunId()) {
    this.id = id;
    this.label = `rclone-manager-tests.run=${id}`;
    liveRuns.add(this);
  }

  /** The labels every object this run creates carries: one saying which
   *  suite made it, one saying which run. The second is what makes the
   *  teardown sweep safe, because a filter on it can only ever match this
   *  run's own objects. */
  labelArgs(): string[] {
    return ["--label", SUITE_LABEL, "--label", this.label];
  }

  name(role: string): string {
    return `rmlive-${this.id}-${role}`;
  }

  /** Reserves a name, refusing rather than reusing.
   *
   *  A collision here is close to impossible (the id carries a pid, a
   *  timestamp and a random number) and the check stays anyway, because
   *  "close to impossible" is what the stale dev server on a shared port
   *  also looked like. */
  async claimContainer(role: string): Promise<string> {
    const name = this.name(role);
    const existing = await docker(["ps", "-aq", "--filter", `name=^${name}$`]);
    if (existing.stdout.trim() !== "") {
      throw new Error(
        `a container called ${name} already exists, and this run did not start it. ` +
          "Refusing to adopt it: a leftover container answers on its port and looks healthy while serving " +
          "something else entirely. Remove it and run again."
      );
    }
    this.containers.push(name);
    return name;
  }

  trackNetwork(name: string): string {
    this.networks.push(name);
    return name;
  }

  trackVolume(name: string): string {
    this.volumes.push(name);
    return name;
  }

  /** Removes everything this run created, and says so if anything is left.
   *
   *  Safe to call twice: the exit handler calls it again after a fixture
   *  already has, and `docker rm` on something already gone is not news.
   *
   *  The order is load-bearing. Containers first, then the network they
   *  were on, because a network with an endpoint on it cannot be removed
   *  and "network is in use" at teardown time is exactly how a network
   *  survives a run. Volumes last, because a volume attached to a
   *  container cannot be removed either. */
  async teardown(keep = false): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    liveRuns.delete(this);

    if (keep) {
      process.stderr.write(
        `live-deployment: RM_LIVE_KEEP is set and this run failed, so it is left up for reading:\n` +
          this.containers.map((c) => `    container ${c}\n`).join("") +
          this.networks.map((n) => `    network   ${n}\n`).join("") +
          this.volumes.map((v) => `    volume    ${v}\n`).join("") +
          `    remove it with: docker rm -fv $(docker ps -aq --filter label=${this.label}) ; ` +
          `docker network rm ${this.networks.join(" ")} ; docker volume rm ${this.volumes.join(" ")}\n`
      );
      return;
    }

    // The sweep by label first, because it also catches the short-lived
    // `--rm` helpers this suite runs against its volumes: --rm removes
    // them on exit, but a signal arriving mid-command leaves one behind,
    // and a container this run created is this run's to remove whether or
    // not it was registered.
    const strays = await docker(["ps", "-aq", "--filter", `label=${this.label}`]);
    const all = new Set([...this.containers, ...strays.stdout.split("\n").map((s) => s.trim()).filter(Boolean)]);
    // -v, and it is not decoration: an anonymous volume created by a
    // container outlives `docker rm` without it, which is how a shared
    // Docker disk fills up invisibly.
    for (const c of all) await docker(["rm", "-fv", c]);
    for (const n of this.networks) await docker(["network", "rm", n]);
    for (const v of this.volumes) await docker(["volume", "rm", v]);

    await this.reportLeftovers();
  }

  /** Teardown that checks itself. A teardown nobody verified is a claim,
   *  and this suite's whole argument is that a claim nothing checks is not
   *  evidence. */
  private async reportLeftovers(): Promise<void> {
    const left: string[] = [];
    const containers = await docker(["ps", "-aq", "--filter", `label=${this.label}`]);
    if (containers.stdout.trim()) left.push(`containers: ${containers.stdout.trim().split("\n").join(" ")}`);
    const networks = await docker(["network", "ls", "-q", "--filter", `label=${this.label}`]);
    if (networks.stdout.trim()) left.push(`networks: ${networks.stdout.trim().split("\n").join(" ")}`);
    const volumes = await docker(["volume", "ls", "-q", "--filter", `label=${this.label}`]);
    if (volumes.stdout.trim()) left.push(`volumes: ${volumes.stdout.trim().split("\n").join(" ")}`);
    if (left.length > 0) {
      process.stderr.write(`live-deployment: teardown left something behind, which it must not: ${left.join("; ")}\n`);
    }
  }

  /** The synchronous half, for the exit handler. `process.on("exit")` runs
   *  no promises, so the last-resort removal has to be blocking calls, and
   *  it is best-effort by construction: it names what it tried and never
   *  throws out of an exit handler. */
  teardownSync(): void {
    if (this.stopped) return;
    this.stopped = true;
    liveRuns.delete(this);
    const quiet = { stdio: "ignore" as const, timeout: 30_000 };
    for (const c of this.containers) spawnSync("docker", ["rm", "-fv", c], quiet);
    for (const n of this.networks) spawnSync("docker", ["network", "rm", n], quiet);
    for (const v of this.volumes) spawnSync("docker", ["volume", "rm", v], quiet);
  }
}

/** Every run this process has booted and not yet torn down.
 *
 *  A Playwright fixture's own `finally` covers a passing test and a failing
 *  one. It does not cover the process being killed between two steps, and
 *  that is precisely when a half-booted deployment is sitting there: the
 *  window this list closes is the boot itself. */
const liveRuns = new Set<Run>();

let handlersInstalled = false;

/** Installs the last-resort teardown, once per process.
 *
 *  Three handlers rather than one, for the reason the two-machine script
 *  gives: a signal handler in Node, like a bash trap, runs and then lets
 *  the process carry on, so a handler that only tears down would leave the
 *  run continuing against containers that are no longer there. These tear
 *  down and then exit, and `exit` fires the exit handler, which finds
 *  nothing left to do. */
export function installExitTeardown(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  process.on("exit", () => {
    for (const run of [...liveRuns]) run.teardownSync();
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      for (const run of [...liveRuns]) run.teardownSync();
      // 128 + the signal number, which is what a shell reports for a
      // process that died on one, so a caller reading the status sees an
      // interrupt rather than a test failure.
      process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
    });
  }
}
