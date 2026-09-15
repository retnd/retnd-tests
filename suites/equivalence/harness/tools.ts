// The Go side of Suite C, reached the way suites/web-ui reaches nothing at
// all: by shelling out.
//
// Every fact this suite needs about backend state comes from a tool in
// tools/ rather than from a TypeScript reimplementation. That is not
// tidiness. Suite C's whole claim is that two work directories hold the
// same state, and if the browser side and the CLI side could disagree
// about what state IS, the claim would be about nothing.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../../..");
export const WORK_ROOT = resolve(REPO_ROOT, ".work");
const BIN_DIR = resolve(WORK_ROOT, "equiv-bin");

/** The build under test, resolved once through the same pin and the same
 *  identity handshake Suites A and B use. Both binaries come from one
 *  resolution: the claim is that the same commit answers identically
 *  through the CLI and through the web engine, and two independently
 *  chosen builds would make that claim about nothing. */
export interface Build {
  cli: string;
  web: string;
  source_dir?: string;
  commit: string;
  version: string;
}

let cachedBuild: Build | undefined;

export function resolveBuild(): Build {
  if (cachedBuild) return cachedBuild;
  const raw = execFileSync("go", ["run", "./tools/getbuild/cmd/getbuild"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  const build = JSON.parse(raw) as Build;
  if (!build.web) {
    throw new Error(
      "the resolved build has no retnd-web binary, so there is no engine to drive the Web UI against. " +
        "source mode's go builder produces one; local mode needs RETND_WEB_BINARY."
    );
  }
  cachedBuild = build;
  return build;
}

const built = new Set<string>();

/** Builds one of this repository's own Go commands and returns its path.
 *
 *  Once per process, not once per disk file. Trusting an existing binary
 *  under .work/ is how a run ends up driving a stale tool: the first
 *  version of this cached on disk, and the very next change to equivstate
 *  was tested against the previous build for twenty minutes. `go build` is
 *  incremental, so rebuilding costs nothing when nothing changed. */
export function tool(name: string, pkg: string): string {
  const out = resolve(BIN_DIR, name);
  if (built.has(name)) return out;
  mkdirSync(BIN_DIR, { recursive: true });
  execFileSync("go", ["build", "-o", out, pkg], { cwd: REPO_ROOT, stdio: ["ignore", "inherit", "inherit"] });
  built.add(name);
  return out;
}

export interface Manifest {
  scenario: string;
  work: string;
  config: string;
  state_db: string;
  sets: { source: string; set: string; id: string; remote_path: string; local_path: string }[];
}

/** Materialises one fixture scenario into its own work directory.
 *
 *  Suite C always materialises a scenario TWICE, into two directories that
 *  start bit-identical, so the only difference between them at comparison
 *  time is which surface the change was made through. */
export function materialise(scenario: string, label: string, cli: string, now?: string): Manifest {
  const work = resolve(WORK_ROOT, `equiv-${label}-${process.pid}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(work, { recursive: true });
  const argv = ["--scenario", scenario, "--work", work, "--cli", cli];
  if (now) argv.push("--now", now);
  const raw = execFileSync(
    tool("mkfixture", "./fixtures/cmd/mkfixture"),
    argv,
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  );
  return JSON.parse(raw) as Manifest;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the product's CLI against one work directory. --config is appended
 *  rather than expected in argv, so a caller cannot accidentally point the
 *  CLI side at the UI side's directory.
 *
 *  `version` is the one command that has to opt out, with `config: false`.
 *  The usage banner says every command *except* version accepts --config,
 *  and since backupdproject/backupd#189 the binary means it: version
 *  answers an undefined flag the way every other command does, with exit 2
 *  and the flag package's own complaint. Suite A pins that as
 *  `version/no-config-flag`. Appending --config unconditionally therefore
 *  made this helper unable to run the one command whose whole job is to
 *  say which build it is.
 *
 *  It is an opt-out at the call site rather than a name check inside here,
 *  because a helper that silently drops an argument for some commands and
 *  not others is exactly the kind of quiet accommodation this suite exists
 *  to catch elsewhere. A spec that skips the flag says so in its own text. */
export function runCli(
  build: Build,
  work: string,
  argv: string[],
  opts: { config?: boolean } = {}
): CliResult {
  const full = opts.config === false ? argv : [...argv, "--config", resolve(work, "config.yaml")];
  const r = spawnSync(build.cli, full, { encoding: "utf8" });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export interface Comparison {
  equal: boolean;
  report: string;
}

/** Compares the resulting backend state of the two work directories.
 *
 *  `ignoreFiles` and `maskVolatile` are arguments rather than defaults
 *  on purpose: a comparison that quietly ignores the thing under test is
 *  the exact failure this repository exists to prevent, so what a spec
 *  chose to ignore is visible in the spec. */
export function compareState(
  build: Build,
  uiSide: string,
  cliSide: string,
  opts: { ignoreFiles?: string[]; maskVolatile?: boolean } = {}
): Comparison {
  const args = ["compare", "--cli", build.cli, "--a", uiSide, "--b", cliSide];
  for (const suffix of opts.ignoreFiles ?? []) args.push("--ignore-file", suffix);
  if (opts.maskVolatile) args.push("--mask-volatile");
  const r = spawnSync(tool("equivstate", "./tools/equivstate/cmd/equivstate"), args, { encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`equivstate failed to run (exit ${r.status}): ${r.stderr}`);
  }
  return { equal: r.status === 0, report: (r.stdout ?? "") + (r.stderr ?? "") };
}
