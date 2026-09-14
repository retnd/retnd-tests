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
export const WORKFLOW_SET_VAR = "RM_WORKFLOW_SET";
export const EXEC_SET_VAR = "RM_EXEC_SET";
export const SFTP_ONLY_SET_VAR = "RM_SFTP_ONLY_SET";
export const NO_HOOKS_SET_VAR = "RM_WF_NO_HOOKS_SET";
export const BEFORE_FAIL_SET_VAR = "RM_WF_BEFORE_FAIL_SET";
export const AFTER_FAIL_SET_VAR = "RM_WF_AFTER_FAIL_SET";
export const HOSTILE_SET_VAR = "RM_WF_HOSTILE_SET";
export const SECRET_SET_VAR = "RM_WF_SECRET_SET";
export const SLOW_SET_VAR = "RM_WF_SLOW_SET";
export const CRASH_SET_VAR = "RM_WF_CRASH_SET";
export const MANY_STEPS_SET_VAR = "RM_WF_MANY_STEPS_SET";

/** The set whose hooks carry deliberate lint findings BELOW the severity
 *  that gates a save, and the one whose findings are at error severity.
 *
 *  Two sets rather than one, because the findings panel and the save
 *  GATE are different claims: a warning is reported and saves fine, an
 *  error refuses. Every other seeded script is deliberately lint-clean,
 *  so an empty panel elsewhere is the contrast that makes a populated one
 *  mean something. */
export const FINDINGS_SET_VAR = "RM_WF_FINDINGS_SET";
export const REJECTED_SET_VAR = "RM_WF_REJECTED_SET";

/** The plaintext behind the secret-backed variable the secret set's hook
 *  echoes. Exported by the rig SO THAT this suite can assert it never
 *  reaches a page: it is the only value in this repository whose presence
 *  anywhere in a DOM is a defect. */
export const SECRET_VALUE_VAR = "RM_WF_SECRET_VALUE";

/** The engine-visible root of the seeded script tree, for a case that
 *  wants to assert the directory a stage reports is the directory the rig
 *  actually wrote. */
export const SCRIPT_PREFIX_VAR = "RM_WF_SCRIPT_PREFIX";

/** Run ids for the three states a browser cannot cause.
 *
 *  Nothing in the shipped bundle cancels a run, bypasses hooks, or makes a
 *  remote process's termination unconfirmable: those are engine and CLI
 *  paths. So the rig produces the run and names it, and the cases here
 *  assert what the product RENDERS for it. Unset means the rig could not
 *  produce that state this time, and the case says so rather than
 *  pretending a run of another shape is one. */
export const BYPASSED_RUN_VAR = "RM_WF_BYPASSED_RUN";
export const CANCELED_RUN_VAR = "RM_WF_CANCELED_RUN";
export const UNCONFIRMED_RUN_VAR = "RM_WF_UNCONFIRMED_RUN";

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
  rejectedSet: string | null;
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
    rejectedSet: setVar(env, REJECTED_SET_VAR),
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
export const WORKFLOW_CONTROL_VAR = "RM_WORKFLOW_CONTROL";

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
 *  The exclusion is what makes "press Run, then read the run" honest: a
 *  set that already has history would otherwise hand back the previous
 *  run instantly and the case would assert against it. */
export async function waitForNewRun(
  api: APIRequestContext,
  backupSetId: string,
  excludingRunId: string | null,
  timeoutMs = RUN_SETTLE_MS
): Promise<WireWorkflowRun> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await newestRun(api, backupSetId);
    if (run !== null && run.run_id !== excludingRunId) return run;
    if (Date.now() >= deadline) {
      throw new Error(
        "no new workflow run appeared for " + backupSetId + " within " +
          String(Math.round(timeoutMs / 1000)) + "s" +
          (excludingRunId === null ? "" : " (the newest is still " + excludingRunId + ")") +
          ". The run control was pressed and the engine recorded nothing, so there is no run to " +
          "assert about."
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
