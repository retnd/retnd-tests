// The workflow feature, as this run is told about it and as the service
// reports it (backupd#816, EPIC L sub-issue L9).
//
// Three jobs, and they are here together because they are three halves of
// one question: "is this deployment one the workflow cases can assert
// against, and which of them".
//
// # 1. What the rig seeded
//
// Everything EPIC L added is invisible on a deployment that configures no
// hooks, and a hook that does something assertable has to have been
// written by somebody. So the rig seeds a script tree and a set of backup
// sets, one per scenario, and names each of them in an environment
// variable. Nothing here invents one: a spec whose set was not exported
// says so with `needs()` and asserts nothing, because a workflow case that
// silently fell back to `e2e/vps` would be a green run reporting on a set
// with no hooks in it.
//
// # 2. What the rig can do TO the deployment mid-run
//
// The same control-directory protocol `harness/engine.ts` uses, and
// deliberately the same shape rather than a second one: request files the
// rig removes as it picks them up, exactly one acknowledgement file
// written back, and a success acknowledgement that means the rig VERIFIED
// the state rather than asked for it. Three requests here, and each is a
// thing no browser can do:
//
//   crash        the engine is stopped and started again underneath a run
//                that is in flight, so the run is interrupted the way a
//                power cut interrupts one and Reconcile-at-startup has a
//                real abandoned run to find
//   runner-down  the Host Workflow Runner is stopped, so a local hook has
//                nowhere to execute
//   runner-up    and started again, verified by the runner answering
//
// # 3. What the service says it holds
//
// Read straight from `/api/v1`, the way `harness/api.ts` reads everything
// else, because a precondition read through the pages under test would be
// checking the pages against themselves.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { APIRequestContext } from "@playwright/test";

import { csrfHeaders } from "./session";

const BASE = "/api/v1";

/**
 * # The sets the rig seeds, one per fixture state
 *
 * The names are the rig's (scripts/e2e/three-machine-web-ui.sh), and this
 * module holds only the VARIABLE they arrive in. A suite that hard-coded
 * `e2e/workflow-happy` would keep passing after the rig renamed it, by
 * skipping every case that mentioned it.
 */
export const WORKFLOW_SET_VAR = "RETND_WORKFLOW_SET";
export const EXEC_SET_VAR = "RETND_EXEC_SET";
export const SFTP_ONLY_SET_VAR = "RETND_SFTP_ONLY_SET";
export const NO_HOOKS_SET_VAR = "RETND_WF_NO_HOOKS_SET";
export const BEFORE_FAIL_SET_VAR = "RETND_WF_BEFORE_FAIL_SET";
export const AFTER_FAIL_SET_VAR = "RETND_WF_AFTER_FAIL_SET";
export const HOSTILE_SET_VAR = "RETND_WF_HOSTILE_SET";
export const SECRET_SET_VAR = "RETND_WF_SECRET_SET";
export const SLOW_SET_VAR = "RETND_WF_SLOW_SET";
export const CRASH_SET_VAR = "RETND_WF_CRASH_SET";
export const MANY_STEPS_SET_VAR = "RETND_WF_MANY_STEPS_SET";

/** The set whose hooks carry deliberate lint findings BELOW the severity
 *  that gates a save, and the DIRECTORY holding the one script whose
 *  finding is at error severity.
 *
 *  A directory rather than a second set, and the difference is the whole
 *  finding: an error-severity finding is refused AT SAVE TIME, by the CLI
 *  and by the API alike, so "a backup set configured with a BSH003 hook"
 *  is not a state any route can reach. The directory therefore sits
 *  attached to nothing, and the case that uses it drives the REFUSAL
 *  through the browser - which proves the gate rather than the report.
 *
 *  Every other seeded script is deliberately lint-clean, so an empty
 *  findings panel elsewhere is the contrast that makes a populated one
 *  mean something. */
export const FINDINGS_SET_VAR = "RETND_WF_FINDINGS_SET";
export const REJECTED_DIR_VAR = "RETND_WF_REJECTED_DIR";

/** The plaintext behind the secret-backed variable the secret set's hook
 *  echoes. Exported by the rig SO THAT this suite can assert it never
 *  reaches a page: it is the only value in this repository whose presence
 *  anywhere in a DOM is a defect. */
export const SECRET_VALUE_VAR = "RETND_WF_SECRET_VALUE";

/** The engine-visible root of the seeded script tree, for a case that
 *  wants to assert the directory a stage reports is the directory the rig
 *  actually wrote. */
export const SCRIPT_PREFIX_VAR = "RETND_WF_SCRIPT_PREFIX";

/** Run ids for the three states a browser cannot cause.
 *
 *  Nothing in the shipped bundle cancels a run, bypasses hooks, or makes a
 *  remote process's termination unconfirmable: those are engine and CLI
 *  paths. So the rig produces the run and names it, and the cases here
 *  assert what the product RENDERS for it. Unset means the rig could not
 *  produce that state this time, and the case says so rather than
 *  pretending a run of another shape is one. */
export const BYPASSED_RUN_VAR = "RETND_WF_BYPASSED_RUN";
export const CANCELED_RUN_VAR = "RETND_WF_CANCELED_RUN";
export const UNCONFIRMED_RUN_VAR = "RETND_WF_UNCONFIRMED_RUN";

/** Which fixture states this run was given. Every field is nullable and
 *  none has a default, for `harness/deployment.ts`'s reason: a workflow
 *  spec that guessed a set name would assert against whatever set happened
 *  to answer. */
export interface WorkflowFixtures {
  happySet: string | null;
  execSet: string | null;
  sftpOnlySet: string | null;
  noHooksSet: string | null;
  beforeFailSet: string | null;
  afterFailSet: string | null;
  hostileSet: string | null;
  secretSet: string | null;
  slowSet: string | null;
  crashSet: string | null;
  manySteps: string | null;
  findingsSet: string | null;
  rejectedDir: string | null;
  secretValue: string | null;
  scriptPrefix: string | null;
  bypassedRun: string | null;
  canceledRun: string | null;
  unconfirmedRun: string | null;
}

/** A backup set id is two segments, source and set (model.BackupSetID).
 *  A malformed one is a rig defect and is reported as one here rather than
 *  becoming a 404 in the middle of a case. */
function setVar(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = (env[name] ?? "").trim();
  if (value === "") return null;
  if (!/^[^/]+\/[^/]+$/.test(value)) {
    throw new Error(
      name + "=" + JSON.stringify(value) + " is not a backup set id. They are two segments, " +
        "source and set, e.g. e2e/workflow-happy. The rig exports these; a malformed one would " +
        "send every case that uses it to a 404 page and read as a product failure."
    );
  }
  return value;
}

function plainVar(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = (env[name] ?? "").trim();
  return value === "" ? null : value;
}

export function resolveWorkflowFixtures(env: NodeJS.ProcessEnv = process.env): WorkflowFixtures {
  return {
    happySet: setVar(env, WORKFLOW_SET_VAR),
    execSet: setVar(env, EXEC_SET_VAR),
    sftpOnlySet: setVar(env, SFTP_ONLY_SET_VAR),
    noHooksSet: setVar(env, NO_HOOKS_SET_VAR),
    beforeFailSet: setVar(env, BEFORE_FAIL_SET_VAR),
    afterFailSet: setVar(env, AFTER_FAIL_SET_VAR),
    hostileSet: setVar(env, HOSTILE_SET_VAR),
    secretSet: setVar(env, SECRET_SET_VAR),
    slowSet: setVar(env, SLOW_SET_VAR),
    crashSet: setVar(env, CRASH_SET_VAR),
    manySteps: setVar(env, MANY_STEPS_SET_VAR),
    findingsSet: setVar(env, FINDINGS_SET_VAR),
    rejectedDir: plainVar(env, REJECTED_DIR_VAR),
    secretValue: plainVar(env, SECRET_VALUE_VAR),
    scriptPrefix: plainVar(env, SCRIPT_PREFIX_VAR),
    bypassedRun: plainVar(env, BYPASSED_RUN_VAR),
    canceledRun: plainVar(env, CANCELED_RUN_VAR),
    unconfirmedRun: plainVar(env, UNCONFIRMED_RUN_VAR)
  };
}

/** The sentence a skipped workflow case prints. One string, because a
 *  skip line that does not say how to un-skip it is a case nobody ever
 *  runs again. */
export function needsFixture(varName: string): string {
  return (
    "the rig to seed a workflow fixture and name it in " + varName + ": " +
    "scripts/e2e/three-machine-web-ui.sh --suite <this directory>"
  );
}

/* ------------------------------------------------------------------ */
/* The control channel                                                 */
/* ------------------------------------------------------------------ */

/** The control directory, as the CLIENT container sees it. Set by the rig
 *  whenever it is running the workflow watcher beside the client. */
export const WORKFLOW_CONTROL_VAR = "RETND_WORKFLOW_CONTROL";

/** The rig's request names. Written down here because this module and
 *  `scripts/e2e/three-machine-web-ui.sh`, in the other repository, are the
 *  two halves of one protocol and neither can import the other. */
export const CRASH_REQUEST = "crash";
export const RUNNER_DOWN_REQUEST = "runner-down";
export const RUNNER_UP_REQUEST = "runner-up";

/** And the acknowledgements. A success one means the rig verified the
 *  state: `crashed` only after the engine went away, came back and served
 *  one healthcheck through the proxy; `runner-started` only after the
 *  runner answered for itself. */
export const CRASHED_ACK = "crashed";
export const CRASH_FAILED_ACK = "crash-failed";
export const RUNNER_STOPPED_ACK = "runner-stopped";
export const RUNNER_DOWN_FAILED_ACK = "runner-down-failed";
export const RUNNER_STARTED_ACK = "runner-started";
export const RUNNER_UP_FAILED_ACK = "runner-up-failed";

/** How long each half is given. A crash is a container stop plus a start
 *  plus a healthcheck, so it gets the same budget `startEngine` has; the
 *  runner is a host process and is either up or not within seconds, but
 *  the budget is generous because a tight one turns a slow CI machine into
 *  a product failure. */
export const CRASH_TIMEOUT_MS = 180_000;
export const RUNNER_TIMEOUT_MS = 60_000;

const POLL_MS = 100;
const REASON_SETTLE_MS = 1_000;
const REASON_LIMIT = 400;

export interface WorkflowControl {
  readonly dir: string;
}

/** The control channel, when the rig is running its watcher. `null`
 *  otherwise, and the cases that need it skip with a stated reason: a
 *  Suite B run against a deployment nobody is watching must not try to
 *  crash it. */
export function resolveWorkflowControl(env: NodeJS.ProcessEnv = process.env): WorkflowControl | null {
  const dir = (env[WORKFLOW_CONTROL_VAR] ?? "").trim();
  return dir === "" ? null : { dir };
}

export const NEEDS_WORKFLOW_CONTROL =
  "a rig that can crash the engine mid-run and stop the Host Workflow Runner: it exports " +
  WORKFLOW_CONTROL_VAR + " and runs the watcher that reads it";

/** The rig's reason, read out of a failure acknowledgement, as one line.
 *  Never throws: this is called on a path already reporting a failure. */
async function refusalReason(path: string): Promise<string> {
  const settled = Date.now() + REASON_SETTLE_MS;
  for (;;) {
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      text = "";
    }
    const line = text.replace(/\s+/gu, " ").trim();
    if (line !== "") {
      return line.length > REASON_LIMIT ? line.slice(0, REASON_LIMIT) + "..." : line;
    }
    if (Date.now() >= settled) return "the rig gave no reason";
    await sleep(POLL_MS);
  }
}

/** Sends one request and waits for the rig to answer it.
 *
 *  Returns on the success acknowledgement and on nothing else. A resolved
 *  call is read downstream as "the deployment is now in that state", so a
 *  timeout and a refusal are both failures of the RIG and both name the
 *  paths: the half-failure somebody actually has to debug is "the two
 *  halves are not looking at the same directory". */
async function ask(
  control: WorkflowControl,
  request: string,
  ack: string,
  failedAck: string,
  timeoutMs: number
): Promise<void> {
  mkdirSync(control.dir, { recursive: true });
  const ackPath = join(control.dir, ack);
  const failedPath = join(control.dir, failedAck);
  rmSync(ackPath, { force: true });
  rmSync(failedPath, { force: true });
  writeFileSync(join(control.dir, request), "", "utf8");

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(ackPath)) return;
    if (existsSync(failedPath)) {
      throw new Error(
        "the rig tried to answer `" + request + "` and could not: " +
          (await refusalReason(failedPath)) + " (it said so in " + failedPath + "). The " +
          "deployment is in whatever state that left it."
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "the rig never answered `" + request + "` within " + String(Math.round(timeoutMs / 1000)) +
          "s: its watcher reads " + join(control.dir, request) + " and answers with " + ackPath +
          ", or refuses with " + failedPath + ", and neither appeared."
      );
    }
    await sleep(POLL_MS);
  }
}

/** Stops the engine and starts it again, verified healthy.
 *
 *  Called WHILE a workflow run is executing, which is the whole point: a
 *  run that was mid-hook when its engine went away is the run
 *  Reconcile-at-startup has to find and mark `recovery_required`. Calling
 *  it against an idle deployment proves nothing and costs a minute. */
export async function crashEngine(
  control: WorkflowControl,
  timeoutMs: number = CRASH_TIMEOUT_MS
): Promise<void> {
  await ask(control, CRASH_REQUEST, CRASHED_ACK, CRASH_FAILED_ACK, timeoutMs);
}

/** Stops the Host Workflow Runner. The engine stays up, so this is the
 *  "a local hook has nowhere to execute" state and not an outage. */
export async function stopRunner(
  control: WorkflowControl,
  timeoutMs: number = RUNNER_TIMEOUT_MS
): Promise<void> {
  await ask(control, RUNNER_DOWN_REQUEST, RUNNER_STOPPED_ACK, RUNNER_DOWN_FAILED_ACK, timeoutMs);
}

/** Starts it again, and returns once the rig has seen it answer. */
export async function startRunner(
  control: WorkflowControl,
  timeoutMs: number = RUNNER_TIMEOUT_MS
): Promise<void> {
  await ask(control, RUNNER_UP_REQUEST, RUNNER_STARTED_ACK, RUNNER_UP_FAILED_ACK, timeoutMs);
}

/** Runs `body` with the runner stopped, and puts it back however `body`
 *  ends.
 *
 *  Written out rather than left as a `finally` for `withEngineStopped`'s
 *  reason: a throwing `finally` REPLACES the assertion failure that is the
 *  reason anybody is reading the report, and "the runner would not come
 *  back" has to be said as well, because every local-hook case after this
 *  one is worthless without it. */
export async function withRunnerStopped<T>(
  control: WorkflowControl,
  body: () => Promise<T>
): Promise<T> {
  await stopRunner(control);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await body() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  try {
    await startRunner(control);
  } catch (restore) {
    if (outcome.ok) throw restore;
    const asserted = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    const restoring = restore instanceof Error ? restore.message : String(restore);
    throw new Error(
      "the case failed AND the Host Workflow Runner did not come back, so every local-hook case " +
        "after this one runs against a deployment that cannot execute one.\n  the case: " +
        asserted + "\n  the restore: " + restoring,
      { cause: outcome.error }
    );
  }

  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/* ------------------------------------------------------------------ */
/* What the service reports                                            */
/* ------------------------------------------------------------------ */

/** One workflow run, as the wire spells it. A hand-written subset, for
 *  `harness/api.ts`'s reason: nothing in this repository imports the
 *  product's types, or it would stop being a black-box suite. */
export interface WireWorkflowRun {
  run_id: string;
  backup_set_id: string;
  state: string;
  backup_status: string;
  workflow_status: string;
  cleanup_status: string;
  recovery_state?: string;
  bypassed?: boolean;
  failed_script?: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  script_count?: number;
}

export interface WireWorkflowStep {
  step_id: string;
  order: number;
  script_name: string;
  scope?: string;
  phase?: string;
  target: string;
  execution_connection_ref?: string;
  state: string;
  exit_code?: number | null;
  termination_confirmed?: boolean;
  duration_ms?: number;
}

export interface WireWorkflowHold {
  run_id: string;
  backup_set_id: string;
  scope?: string;
  entered_at?: string;
  spool_ref?: string;
}

export interface WireBackupSetWorkflow {
  backup_set_id: string;
  configured: boolean;
  before_dir?: string;
  after_dir?: string;
  effective_script_timeout_seconds?: number;
  remote_exec_connection_ref?: string;
  stages?: Array<{ scope?: string; phase?: string; dir?: string }>;
}

export interface WireWorkflowSettings {
  configured: boolean;
  root?: string;
  before_dir?: string;
  after_dir?: string;
  exec_connections?: string[];
  runner?: { configured?: boolean; socket?: string; token_file?: string };
}

/** A read that answers with `null` rather than throwing when the route is
 *  not there or refuses.
 *
 *  404 is a build predating EPIC L, 503 is a fresh install, and both are
 *  answers a precondition turns into a stated skip. A read that threw
 *  would turn "this deployment has no workflow surface" into an error in a
 *  worker fixture, which fails every spec in the directory. */
async function readOrNull<T>(api: APIRequestContext, path: string): Promise<T | null> {
  const response = await api.get(BASE + path);
  if (response.status() === 401 || response.status() === 403) {
    // Loud, not null. A null here reads as "no runs" and "no holds" to
    // every waiter in this file, and that is exactly how the crash case
    // waited eight minutes for a hold the engine had raised within
    // seconds: the engine it crashed came back with an empty session
    // store (sessions are in memory for one process), the worker's cookie
    // was a stranger to it, and every read said 401.
    throw new Error(
      "GET " + path + " answered " + response.status() + ": this worker's session is gone. A case that " +
        "crashed or restarted the engine has to call bm.reauthenticate() before it reads again."
    );
  }
  if (response.status() !== 200) return null;
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function readWorkflowSettings(api: APIRequestContext): Promise<WireWorkflowSettings | null> {
  return readOrNull<WireWorkflowSettings>(api, "/settings/workflow");
}

/** Runs `body` with the deployment's global "before" stage pointed at
 *  `dir`, and puts the previous value back however it ends.
 *
 *  # Why a spec arranges this rather than the rig
 *
 *  Because a global stage runs for EVERY backup set, and a deployment
 *  that has one configured has no set with no hooks - `hasWorkflowSurface`
 *  is true everywhere, the quiet "nothing runs before or after this set's
 *  backups" sentence becomes unreachable, and #816's empty-state fixture
 *  stops existing. So the rig seeds the directory and attaches it to
 *  nothing, one case borrows it, and the deployment is handed back
 *  exactly as it was found.
 *
 *  The restore is written out rather than left in a `finally` for
 *  `withEngineStopped`'s reason: a throwing restore must not replace the
 *  assertion failure that is the reason anybody is reading the report,
 *  and a global stage left configured would change what every later spec
 *  in the run is looking at. */
export async function withGlobalBeforeDir<T>(
  api: APIRequestContext,
  dir: string,
  body: () => Promise<T>
): Promise<T> {
  const before = await readWorkflowSettings(api);
  const previous = before?.before_dir ?? "";
  const headers = await csrfHeaders(api);

  const patch = async (value: string): Promise<void> => {
    const response = await api.patch(BASE + "/settings/workflow", {
      headers,
      data: { before_dir: value }
    });
    if (response.status() >= 400) {
      throw new Error(
        "PATCH /settings/workflow answered " + response.status() + " for before_dir=" +
          JSON.stringify(value) + ", so the deployment's global stage could not be " +
          (value === "" ? "cleared" : "set") + "."
      );
    }
  };

  await patch(dir);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await body() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  try {
    await patch(previous);
  } catch (restore) {
    if (outcome.ok) throw restore;
    const asserted = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    const restoring = restore instanceof Error ? restore.message : String(restore);
    throw new Error(
      "the case failed AND the deployment's global workflow stage was left configured, so every " +
        "later set reads as having hooks.\n  the case: " + asserted + "\n  the restore: " + restoring,
      { cause: outcome.error }
    );
  }

  if (!outcome.ok) throw outcome.error;

  return outcome.value;
}

export async function readBackupSetWorkflow(
  api: APIRequestContext,
  backupSetId: string
): Promise<WireBackupSetWorkflow | null> {
  const path = backupSetId.split("/").map(encodeURIComponent).join("/");

  return readOrNull<WireBackupSetWorkflow>(api, "/backup-sets/" + path + "/workflow");
}

export async function readWorkflowValidation(
  api: APIRequestContext,
  backupSetId: string
): Promise<{ valid_for_backup?: boolean; workflow_valid?: boolean; scripts?: unknown[]; findings?: Array<{ check?: string; severity?: string; detail?: string }> } | null> {
  const path = backupSetId.split("/").map(encodeURIComponent).join("/");

  return readOrNull(api, "/backup-sets/" + path + "/workflow/validation");
}

/** This set's runs, newest first as the service orders them. An empty
 *  array is a real answer ("no run recorded"); `null` means the route is
 *  not served at all, which is a different fact and a different skip. */
export async function readWorkflowRuns(
  api: APIRequestContext,
  backupSetId?: string
): Promise<WireWorkflowRun[] | null> {
  const query = backupSetId === undefined ? "" : "?backup_set=" + encodeURIComponent(backupSetId);
  const body = await readOrNull<{ runs?: WireWorkflowRun[] }>(api, "/workflow-runs" + query);
  return body === null ? null : (body.runs ?? []);
}

export async function readWorkflowRun(
  api: APIRequestContext,
  runId: string
): Promise<WireWorkflowRun | null> {
  return readOrNull<WireWorkflowRun>(api, "/workflow-runs/" + encodeURIComponent(runId));
}

export async function readWorkflowSteps(
  api: APIRequestContext,
  runId: string
): Promise<WireWorkflowStep[]> {
  const body = await readOrNull<{ steps?: WireWorkflowStep[] }>(
    api,
    "/workflow-runs/" + encodeURIComponent(runId) + "/steps"
  );
  return body?.steps ?? [];
}

export async function readWorkflowRecovery(api: APIRequestContext): Promise<WireWorkflowHold[] | null> {
  const body = await readOrNull<{ holds?: WireWorkflowHold[] }>(api, "/workflow-recovery");
  return body === null ? null : (body.holds ?? []);
}

/** Whether this deployment has the workflow surface at all, and what it
 *  currently holds. Read once per worker beside the rest of the facts. */
export interface WorkflowFacts {
  /** Whether `/settings/workflow` answers. False against a build that
   *  predates EPIC L, which is the only honest reason to skip every case
   *  in these files at once. */
  served: boolean;
  /** Whether the deployment declares a workflow root. */
  configured: boolean;
  /** Whether a Host Workflow Runner is configured for local execution. */
  runnerConfigured: boolean;
  /** Deployment-wide stage directories. Their presence decides which
   *  empty state a set with no hooks of its own shows: with globals
   *  configured, EVERY set inherits them and the quiet "nothing runs"
   *  sentence is unreachable by construction. */
  globalBeforeDir: string;
  globalAfterDir: string;
  /** Execution connections this deployment declares, for remote hooks. */
  execConnections: string[];
  /** Whether `/workflow-recovery` answers. A build that serves it is one
   *  whose Run control is gated on it. */
  recoveryServed: boolean;
  /** Runs the journal holds, across every set. */
  runs: number;
  /** Sets currently held for recovery. Not zero on a deployment a
   *  previous case crashed and did not settle, which is worth printing. */
  holds: number;
}

export async function readWorkflowFacts(api: APIRequestContext): Promise<WorkflowFacts> {
  const settings = await readWorkflowSettings(api);
  const recovery = await readWorkflowRecovery(api);
  const runs = await readWorkflowRuns(api);
  return {
    served: settings !== null,
    configured: settings?.configured === true,
    runnerConfigured: settings?.runner?.configured === true,
    globalBeforeDir: settings?.before_dir ?? "",
    globalAfterDir: settings?.after_dir ?? "",
    execConnections: settings?.exec_connections ?? [],
    recoveryServed: recovery !== null,
    runs: (runs ?? []).length,
    holds: (recovery ?? []).length
  };
}

export function describeWorkflowFacts(facts: WorkflowFacts): string {
  if (!facts.served) return "no workflow surface (this build predates EPIC L)";
  return [
    facts.configured ? "workflow configured" : "workflow NOT configured",
    facts.runnerConfigured ? "host runner configured" : "no host runner",
    facts.globalBeforeDir === "" && facts.globalAfterDir === ""
      ? "no global stages"
      : "global stages configured",
    facts.execConnections.length + " exec connection(s)",
    facts.runs + " workflow run(s)",
    facts.holds + " recovery hold(s)"
  ].join(", ");
}

/* ------------------------------------------------------------------ */
/* Waiting for the deployment to get somewhere                         */
/* ------------------------------------------------------------------ */

/** How long a seeded hook run is given to finish.
 *
 *  The fixtures are deliberately small - a few kilobytes over SFTP and a
 *  handful of scripts that print a line - so anything past this is a
 *  deployment that is stuck rather than one that is slow, and a case that
 *  waited for the whole test timeout would report "timeout" instead of
 *  "the run never left `running`". */
export const RUN_SETTLE_MS = 60_000;
const RUN_POLL_MS = 500;

/** How often a waiter re-checks whether something it can clear is the
 *  reason nothing is happening. Seconds rather than milliseconds: it
 *  costs a request, and the thing it looks for takes a run's
 *  finalisation to appear. */
const HOLD_SWEEP_MS = 5_000;

/** The scheduler cadence the rig configured, in seconds.
 *
 *  Exported by the rig rather than written down, because the product
 *  puts a floor under it: `config.MinPollInterval` is one minute and a
 *  shorter interval is refused, so "a run within 60 seconds" is not
 *  achievable on any legal configuration and a suite that assumed one
 *  would report a stall on a healthy deployment. */
export const POLL_SECONDS_VAR = "RETND_WF_POLL_SECONDS";

/** How long a run is given to APPEAR.
 *
 *  Longer than the settle budget, and for a different reason: nothing in
 *  this suite can start a backup. `POST /api/v1/operations` answers
 *  DESTRUCTIVE_OPERATIONS_DISABLED on every deployment, because
 *  `NewEngine` never sets a destructive gate (backupd#92), so the
 *  product's own Run control is refused whoever presses it. The rig
 *  answers that by giving the deployment the shortest legal scheduler
 *  interval, and these cases OBSERVE the run it starts.
 *
 *  Two and a half intervals, floored at 150 seconds. A set becomes due
 *  one interval after its last run and then waits its turn in the cycle,
 *  so one interval is the wrong budget and two is tight on the set whose
 *  hook holds for forty-five seconds. A function rather than a constant
 *  because Playwright resolves the environment per worker. */
export function runAppearMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[POLL_SECONDS_VAR] ?? "").trim();
  const seconds = /^\d+$/.test(raw) ? Number(raw) : 60;

  return Math.max(150_000, seconds * 2_500);
}

/** The states a run is no longer moving in, out of the thirteen the
 *  contract declares. `pending`, `running` and `cleanup_running` are
 *  deliberately absent: a canceled run whose after hooks are still
 *  executing is live, and a wait that stopped there would read the
 *  verdicts mid-flight. */
export const TERMINAL_RUN_STATES: Record<string, true> = {
  success: true,
  failed: true,
  timed_out: true,
  canceled: true,
  skipped: true,
  interrupted: true,
  recovery_required: true,
  cleanup_failed: true,
  recovered: true
};

/** The newest run of this set, or null when it has none. */
export async function newestRun(
  api: APIRequestContext,
  backupSetId: string
): Promise<WireWorkflowRun | null> {
  const runs = await readWorkflowRuns(api, backupSetId);
  return (runs ?? [])[0] ?? null;
}

/** Waits until this set has a run that is not `excludingRunId`.
 *
 *  The exclusion is what makes "read the run this case is about" honest:
 *  a set that already has history would otherwise hand back the previous
 *  run instantly, and the case would assert against a run that predates
 *  whatever it is testing.
 *
 *  The run is started by the deployment's scheduler rather than by the
 *  browser. See RUN_APPEAR_MS for why, and note what does NOT change:
 *  the hooks execute for real, and every assertion about them is still
 *  made through the product's own pages. */
export async function waitForNewRun(
  api: APIRequestContext,
  backupSetId: string,
  excludingRunId: string | null,
  timeoutMs = RUN_SETTLE_MS,
  /** Run every few seconds while waiting, for a caller that can REMOVE
   *  a reason no run is appearing. The only such reason this suite can
   *  do anything about is a hold, and a hold cannot be cleared before
   *  it exists: an interrupted run finalises seconds to minutes after
   *  whatever interrupted it, so a clear taken once before the wait is
   *  structurally too early. */
  whileWaiting?: () => Promise<void>
): Promise<WireWorkflowRun> {
  const deadline = Date.now() + timeoutMs;
  let nextSweep = Date.now();
  for (;;) {
    const run = await newestRun(api, backupSetId);
    if (run !== null && run.run_id !== excludingRunId) return run;
    if (whileWaiting !== undefined && Date.now() >= nextSweep) {
      nextSweep = Date.now() + HOLD_SWEEP_MS;
      await whileWaiting();
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "no new workflow run appeared for " + backupSetId + " within " +
          String(Math.round(timeoutMs / 1000)) + "s" +
          (excludingRunId === null ? "" : " (the newest is still " + excludingRunId + ")") +
          ". Nothing in this suite can start one - the destructive gate refuses the product's " +
          "own Run control (backupd#92) - so this case waited " +
          (Math.round((timeoutMs / 1000) / Number((process.env[POLL_SECONDS_VAR] ?? "60").trim() || 60) * 10) / 10) +
          " scheduler intervals and the scheduler did not run this set" +
          (whileWaiting === undefined ? "." : ", with no hold on it to explain why.")
      );
    }
    await sleep(RUN_POLL_MS);
  }
}

/** Waits until a run stops moving, and hands back its final shape. */
export async function waitForRunToSettle(
  api: APIRequestContext,
  runId: string,
  timeoutMs = RUN_SETTLE_MS
): Promise<WireWorkflowRun> {
  const deadline = Date.now() + timeoutMs;
  let last: WireWorkflowRun | null = null;
  for (;;) {
    last = await readWorkflowRun(api, runId);
    if (last !== null && TERMINAL_RUN_STATES[last.state] === true) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        "workflow run " + runId + " was still " + (last?.state ?? "unreadable") + " after " +
          String(Math.round(timeoutMs / 1000)) + "s. Its verdicts cannot be asserted while it is " +
          "still moving."
      );
    }
    await sleep(RUN_POLL_MS);
  }
}

/** Waits until this set has nothing in flight.
 *
 *  The Run control is disabled while a run of the set is busy, which on
 *  a deployment scheduled at the product's one-minute floor is a large
 *  fraction of the time. A case asserting that the control came BACK
 *  after a hold was settled has to wait for the set to be idle first, or
 *  it is asserting the scheduler's timing rather than the gate. */
export async function waitForSetIdle(
  api: APIRequestContext,
  backupSetId: string,
  timeoutMs = runAppearMs()
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await newestRun(api, backupSetId);
    if (run === null || TERMINAL_RUN_STATES[run.state] === true) return;
    if (Date.now() >= deadline) {
      throw new Error(
        backupSetId + " still had a run in flight (" + run.state + ") after " +
          String(Math.round(timeoutMs / 1000)) + "s, so whether its Run control is available " +
          "says nothing about the recovery gate."
      );
    }
    await sleep(RUN_POLL_MS);
  }
}

/** Catches this set with a step actually executing.
 *
 *  The crash cases need a live hook to crash INTO, and nothing here can
 *  start one: they wait for the scheduler. Two things make that harder
 *  than it sounds, and both are handled here rather than in each case.
 *
 *  First, the set may ALREADY be mid-hook when a case arrives, and
 *  waiting for a NEW run in that situation throws away the live one and
 *  then waits out the whole of its cycle. So the run in flight right
 *  now is used when there is one.
 *
 *  Second, the budget. `runAppearMs` is two and a half scheduler
 *  intervals, which fits an ordinary set; the crash fixture is the
 *  slowest set in the deployment - its own hook holds for the better
 *  part of a minute before its backup even starts - so the gap between
 *  one of its runs STARTING and the next is longer than the interval,
 *  and a case that budgeted one interval reported the scheduler as
 *  broken when it was merely behind. Each attempt gets double.
 *
 *  Returns the run and the step that was executing when it was seen. */
export async function catchRunInFlight(
  api: APIRequestContext,
  backupSetId: string,
  attempts = 2
): Promise<{ run: WireWorkflowRun; step: WireWorkflowStep }> {
  const budget = runAppearMs() * 2;
  const missed: string[] = [];

  // Already executing? Then this IS the window, and waiting for the
  // next run would be waiting out the one that is open.
  const current = await newestRun(api, backupSetId);
  let previous = current?.run_id ?? null;
  if (current !== null && TERMINAL_RUN_STATES[current.state] !== true) {
    const live = (await readWorkflowSteps(api, current.run_id)).find(
      (step) => step.state === "running"
    );
    if (live !== undefined) return { run: current, step: live };
  }

  // Waiting for a run of a HELD set is waiting for something the engine
  // is right to refuse, and a clear taken once at the start of a case
  // can only ever be too early: an interrupted run does not become a
  // hold until it finalises, which is seconds to minutes after whatever
  // interrupted it. So a hold found while waiting is treated as a
  // legitimate starting state - settled at the moment it exists, and
  // said out loud - rather than as a reason to keep waiting.
  const unblock = async (): Promise<void> => {
    const settled = await acknowledgeHolds(
      api,
      backupSetId,
      "e2e: settled so the scheduler will run this set again; an earlier case interrupted a " +
        "hook belonging to it and the hold only finalised afterwards"
    );
    if (settled.length > 0) {
      console.log(
        "e2e: " + backupSetId + " was held (" + settled.length + " hold(s)) while this case was " +
          "waiting for the scheduler, which is why no run was appearing; acknowledged"
      );
    }
  };

  for (let attempt = 0; attempt < attempts; attempt++) {
    const run = await waitForNewRun(api, backupSetId, previous, budget, unblock);
    previous = run.run_id;
    try {
      return { run, step: await waitForRunningStep(api, run.run_id) };
    } catch (missedIt) {
      missed.push(run.run_id + ": " + (missedIt instanceof Error ? missedIt.message : String(missedIt)));
    }
  }
  throw new Error(
    "never caught " + backupSetId + " with a step in flight across " + attempts + " scheduled " +
      "runs, so there was never a live hook to act on:\n  " + missed.join("\n  ")
  );
}

/** Waits until a run has a step in `state`, so a case that has to act
 *  MID-RUN (crash the engine, read a live terminal) acts while there is
 *  really something in flight rather than at a moment it guessed. */
export async function waitForRunningStep(
  api: APIRequestContext,
  runId: string,
  timeoutMs = RUN_SETTLE_MS
): Promise<WireWorkflowStep> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const steps = await readWorkflowSteps(api, runId);
    const running = steps.find((step) => step.state === "running");
    if (running !== undefined) return running;
    const run = await readWorkflowRun(api, runId);
    if (run !== null && TERMINAL_RUN_STATES[run.state] === true) {
      throw new Error(
        "workflow run " + runId + " reached " + run.state + " without this case ever seeing a " +
          "running step, so there was no live run to act on. The fixture's hook is too short to " +
          "be caught mid-flight."
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "workflow run " + runId + " had no running step within " +
          String(Math.round(timeoutMs / 1000)) + "s."
      );
    }
    await sleep(RUN_POLL_MS);
  }
}

/** Waits until this set is held for recovery, and hands back the hold.
 *
 *  The hold list is the thing the Run control is gated on, so this is what
 *  a crash case waits for rather than the run's own `recovery_state`: the
 *  two can disagree for as long as it takes reconciliation to run, and the
 *  refusal an operator meets is the hold. */
export async function waitForHold(
  api: APIRequestContext,
  backupSetId: string,
  timeoutMs = RUN_SETTLE_MS
): Promise<WireWorkflowHold> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const holds = await readWorkflowRecovery(api);
    const mine = (holds ?? []).find((hold) => hold.backup_set_id === backupSetId);
    if (mine !== undefined) return mine;
    if (Date.now() >= deadline) {
      throw new Error(
        "no recovery hold appeared for " + backupSetId + " within " +
          String(Math.round(timeoutMs / 1000)) + "s of the engine being crashed mid-run. Either " +
          "the run finished before the crash landed, or reconciliation did not mark it."
      );
    }
    await sleep(RUN_POLL_MS);
  }
}

/** Crashes the engine INTO a live hook and returns the hold that
 *  reconciliation raised, retrying until it lands inside the window.
 *
 *  The window is real and narrow: the fixture's hook holds for about
 *  forty-five seconds inside a cycle, nothing in this suite can start a
 *  run, and the stop-start-healthcheck the rig performs takes time of
 *  its own. A crash that lands after the hook finished leaves nothing
 *  to reconcile, and the honest response is to try the next scheduled
 *  run rather than to assert against a run that completed.
 *
 *  Retried here rather than in each case, because the two crash cases
 *  need identical timing and a retry written twice is a retry that
 *  drifts. Throws only when every attempt missed, and says how many.
 *
 *  The mechanism itself is not in doubt: a crash into a live step
 *  raises a global hold and a set hold about five seconds after the
 *  engine returns, each carrying the run id and the spool reference.
 *  What is uncertain is only whether this attempt caught the hook. */
export async function crashIntoHook(
  api: APIRequestContext,
  control: WorkflowControl,
  backupSetId: string,
  /** Signs the caller in again after the crash. The engine that comes
   *  back has an empty session store, so without this every read below
   *  answers 401 and readOrNull refuses. */
  afterCrash: () => Promise<void>,
  attempts = 2
): Promise<{ run: WireWorkflowRun; step: WireWorkflowStep; hold: WireWorkflowHold }> {
  const missed: string[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const caught = await catchRunInFlight(api, backupSetId);
    await crashEngine(control);
    await afterCrash();
    // Three scheduler intervals for the hold, not one. An interrupted run
    // is not a hold until it finalises, which on the rig means waiting out
    // the crash fixture's own 90s script bound and whatever confirmation
    // the engine does on restart. One interval (60s) was inside that
    // window, so a first attempt gave up on a hold that then landed
    // anyway, and the second attempt waited five intervals for a run of a
    // set the engine was by then right to be refusing. The line below says
    // how long it really took, so the next reader of a red run has a
    // number rather than a guess.
    const crashedAt = Date.now();
    const hold = await waitForHold(api, backupSetId, runAppearMs() * 3).catch(() => null);
    if (hold !== null) {
      console.log(
        "e2e: " + backupSetId + " was held " + String(Math.round((Date.now() - crashedAt) / 1000)) +
          "s after the engine was crashed into " + caught.step.script_name
      );
    }
    if (hold !== null) return { run: caught.run, step: caught.step, hold };
    missed.push(
      caught.run.run_id + " was " + caught.step.script_name + " when the crash was requested, " +
        "and reconciliation raised no hold for " + backupSetId
    );
  }
  throw new Error(
    "crashed the engine " + attempts + " times into a run of " + backupSetId + " and never " +
      "interrupted a hook: every crash landed after the step had finished, so there was nothing " +
      "for reconciliation to find.\n  " + missed.join("\n  ")
  );
}

/** Acknowledges the holds this deployment is carrying, through the API.
 *
 *  A cleanup step and not an assertion: a set with an unresolved hold
 *  is a set the ENGINE will not run again, so a case that fails before
 *  it settles a hold does not fail alone - it starves every later case
 *  that waits for the scheduler to come round to that set, and those
 *  report "the scheduler did not run this set", which says nothing
 *  about what actually broke.
 *
 *  `backupSetId` narrows it to one set; `null` settles every hold on
 *  the deployment. The wide form is for the cases that take a shared
 *  facility away - stopping the Host Workflow Runner interrupts hooks
 *  belonging to WHATEVER set the scheduler happened to be running, not
 *  only the set the case names - so a case that cannot know whose run
 *  it disturbed settles all of them rather than guessing.
 *
 *  Acknowledge rather than resume, deliberately: resuming EXECUTES the
 *  hooks a run still owed, which is a thing under test and not a thing
 *  to do behind a case's back. An acknowledgement records a person
 *  taking responsibility and changes nothing on the source machine,
 *  which is exactly what a test harness tidying up after itself is
 *  doing.
 *
 *  Returns the set ids it settled a hold for, and never throws: it runs
 *  on the way out of a case that may already be failing, and an error
 *  here would replace the reason anybody is reading the report. */
export async function acknowledgeHolds(
  api: APIRequestContext,
  backupSetId: string | null,
  reason: string
): Promise<string[]> {
  const settled: string[] = [];
  try {
    const holds = await readWorkflowRecovery(api);
    const headers = await csrfHeaders(api);
    for (const hold of holds ?? []) {
      if (backupSetId !== null && hold.backup_set_id !== backupSetId) continue;
      const response = await api.post(
        BASE + "/workflow-recovery/" + encodeURIComponent(hold.run_id) + "/acknowledge",
        { headers, data: { reason } }
      );
      if (response.status() < 400) {
        settled.push(hold.backup_set_id);
        continue;
      }
      // Said out loud, because a refusal here is not a tidy-up that
      // failed: the hold stays, the engine will not schedule that set
      // again, and every later case waiting for a run of it is starved
      // for a reason none of them can report. The status is the whole
      // diagnosis - 403 would mean this route sits behind the same gate
      // that refuses a run, which is a finding about the product and
      // not about the suite.
      console.log(
        "e2e: could not acknowledge hold " + hold.run_id + " on " + hold.backup_set_id + ": HTTP " +
          response.status() + " " + (await response.text()).slice(0, 200)
      );
    }
  } catch (failed) {
    // Said out loud rather than swallowed: a sweep that could not read or
    // acknowledge is the difference between "no hold" and "could not look",
    // and a waiter reads an empty answer as the first.
    console.log(
      "e2e: the hold sweep for " + String(backupSetId) + " did not complete: " +
        (failed instanceof Error ? failed.message : String(failed))
    );
    return settled;
  }

  return settled;
}

/** Waits until this set is no longer held. Used after Resume cleanup and
 *  after Acknowledge, so the next case does not inherit a blocked set. */
export async function waitForNoHold(
  api: APIRequestContext,
  backupSetId: string,
  timeoutMs = RUN_SETTLE_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const holds = await readWorkflowRecovery(api);
    if (!(holds ?? []).some((hold) => hold.backup_set_id === backupSetId)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        backupSetId + " is still held for recovery " + String(Math.round(timeoutMs / 1000)) +
          "s after it was settled, so every later case that runs it would be refused."
      );
    }
    await sleep(RUN_POLL_MS);
  }
}
