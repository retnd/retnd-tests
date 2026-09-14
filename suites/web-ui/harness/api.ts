// Reading and arranging the deployment through its own API, rather than
// through the browser.
//
// This is the half of the move that the mock made unnecessary and a real
// backend makes essential. Against `createMockApi` every page came up
// fully populated: a dozen backups, a stale set, a set halted on a changed
// host key, an operation mid-transfer, a quarantine queue. A real
// deployment starts EMPTY and gains all of that only when a backup
// actually runs. So a spec that asserts on rows has two honest options:
// know that the rows are there, or say why it is not asserting.
//
// Both of those need somebody to ask the deployment what it currently
// holds, and asking it through the pages under test would be circular. So
// this module asks the API directly, once per worker, and the answer is
// what the specs' own preconditions are written against.
//
// # Arrange here, assert in the browser
//
// The second job is setup. Driving the UI to reach a precondition makes
// every spec depend on the correctness of the flow it is not testing, and
// makes a failure in one flow look like a failure in six. The API is the
// clean way in: this module is where a spec goes to make the deployment be
// in a state, and the browser is kept for the thing actually under test.
//
// Everything mutating here also knows how to put back what it changed. One
// deployment is one database, shared by every spec in the run, and a spec
// that leaves the retention policy edited has changed what the next twenty
// are looking at.

import type { APIRequestContext } from "@playwright/test";

import { csrfHeaders } from "./session";
import { type WorkflowFacts, describeWorkflowFacts, readWorkflowFacts } from "./workflow";

const BASE = "/api/v1";

/** What one call to the deployment found. Deliberately a narrow, hand-
 *  written subset of the wire shapes rather than the generated contract
 *  module: nothing in this repository depends on the product's source
 *  tree, and a suite that imported its types would stop being a black-box
 *  suite. */
interface WireHealth {
  backup_set_id: string;
  set_name: string;
  source_name: string;
  state: "HEALTHY" | "DEGRADED" | "STALE" | "FAILING";
  halt_reason?: "HOST_KEY_CHANGED" | "AUTHENTICATION_FAILED" | "KEY_PERMISSIONS";
  current_transfers: number;
  quarantined_count: number;
  newest_good_backup_at?: string;
  last_completed_backup_at?: string;
}

/** Where one copy of a backup actually is, and what anybody can do with
 *  it. The Copies card on a backup's detail page is one row per entry. */
export interface WirePlacement {
  access: "immediate" | "requires_restore" | "restoring" | "unreachable";
  location: string;
  medium: string;
  medium_type: "local" | "s3";
  storage_class?: string;
  verification_class?: "content" | "attested" | "existence";
}

export interface WireArtifactRow {
  id: string;
  name: string;
  set_name: string;
  source_name: string;
  quarantined: boolean;
  retention_tier?: string;
  remote_source_removed_at?: string;
  validation: "passed" | "failed" | "pending";
  /** Absent on a build predating EPIC E, empty on a backup that is still
   *  arriving. Neither is the same as "the copy is gone", which is the
   *  distinction the Copies card exists to draw. */
  placements?: WirePlacement[];
}

/** The retention classes one backup carries. The wire field is a single
 *  string that can name more than one, and "this backup is both the
 *  newest daily and the newest weekly" is a real state rather than a
 *  fixture: it is what the newest backup of any deployment with a
 *  multi-tier chain looks like once retention has classified it. */
export function retentionClasses(artifact: WireArtifactRow): string[] {
  return (artifact.retention_tier ?? "").split(/[,\s]+/).filter((c) => c !== "");
}

/** What the last finished run cycle got done, as the service records it.
 *
 *  The dashboard's "Last run cycle" panel is drawn from the newest
 *  operation carrying one of these (DashboardPage's
 *  `operations.data?.find((op) => op.cycle !== null)`), so a deployment
 *  that has never run one has no panel at all, which is a state the specs
 *  have to be able to tell from a panel showing zeroes. */
export interface CycleOutcome {
  artifacts_walked: number;
  artifacts_through: number;
  backup_sets_processed: number;
}

/** A medium the configuration declares. `local` is not one of these: the
 *  drive the manager already writes to is a destination whether or not
 *  anything else is declared, and the question these specs ask is whether
 *  this deployment ever heard of the FEATURE. */
interface WireMedium {
  id: string;
  storage_class?: string;
  archive?: boolean;
}

/** Everything the specs' preconditions are written against.
 *
 *  Read once per worker. It is a snapshot rather than a live view on
 *  purpose: a precondition that re-read the deployment on every assertion
 *  would let a spec skip halfway through, which reads as a pass. */
export interface DeploymentFacts {
  /** Whether this instance has any configuration at all. A fresh
   *  container answers false, every page renders the first-run banner and
   *  every resource refuses with NOT_CONFIGURED. */
  configured: boolean;
  /** One entry per configured backup set, with the health verdict the
   *  service computes rather than one derived here. */
  sets: WireHealth[];
  /** Backups in the catalogue, quarantined ones excluded (GET /backups
   *  and GET /quarantine are two different lists). */
  backups: WireArtifactRow[];
  quarantined: WireArtifactRow[];
  /** How many activity events the feed currently holds. */
  activityEvents: number;
  /** Operations that have started and not reported an outcome. The
   *  dashboard's progress bar and stage list only exist while one is
   *  running, and on a real deployment that is a window of seconds. */
  runningOperations: number;
  /** The newest run cycle the service has finished, or null on a
   *  deployment that has never run one. Carried whole rather than as a
   *  boolean, so a spec can compare what the page renders against what the
   *  API says instead of merely checking that a digit is present. */
  lastCycle: CycleOutcome | null;
  /** Storage mediums the configuration declares, `local` excluded. An
   *  empty list is FR-35's compatibility case, and it is the state a
   *  deployment that never adopted the feature is really in. */
  mediums: WireMedium[];
  /** The manager-wide storage verdict, as the service reports it. */
  storageLevel: "" | "OK" | "WARNING" | "CRITICAL";
  /** The service's own version line, for the run's opening banner. */
  serviceVersion: string;
  /** What the TOPOLOGY says it seeded, in `source/set` form, or null.
   *
   *  The one field here that does not come from the deployment, and it is
   *  the point of it: a name the suite did not choose and the bundle
   *  cannot invent is the only anchor that can tell a real catalogue from
   *  a convincing fixture. Filled in by the fixture from RM_BACKUP_SET. */
  seededBackupSet: string | null;
  /** What this deployment's workflow surface looks like (EPIC L,
   *  backupd#816). Read here rather than in each spec because every
   *  workflow case's first precondition is the same one - whether this
   *  build serves the routes at all - and a build predating EPIC L must
   *  skip them with that sentence rather than fail them. */
  workflow: WorkflowFacts;
}

async function readJson<T>(api: APIRequestContext, path: string, fallback: T): Promise<T> {
  const response = await api.get(BASE + path);
  // 503 NOT_CONFIGURED on a fresh install, and 404 for a route a build
  // predating a feature does not serve. Both are answers rather than
  // failures, and the caller's own precondition is what turns them into a
  // stated skip.
  if (response.status() !== 200) return fallback;
  try {
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

/** Asks the deployment what it currently holds.
 *
 *  Every call here is a GET, so this cannot itself change what it is
 *  measuring. */
export async function readFacts(api: APIRequestContext): Promise<Omit<DeploymentFacts, "seededBackupSet">> {
  const firstRun = await readJson<{ configured?: boolean }>(api, "/system/first-run", {});
  const health = await readJson<{ backup_sets?: WireHealth[] }>(api, "/system/health", {});
  const backups = await readJson<{ artifacts?: WireArtifactRow[] }>(api, "/backups", {});
  const quarantine = await readJson<{ artifacts?: WireArtifactRow[] }>(api, "/quarantine", {});
  const activity = await readJson<{ events?: unknown[] }>(api, "/activity", {});
  const operations = await readJson<{
    operations?: Array<{ status?: string; cycle?: CycleOutcome }>;
  }>(api, "/operations", {});
  const settings = await readJson<{ mediums?: WireMedium[] }>(api, "/settings", {});
  const storage = await readJson<{ manager?: { level?: string } }>(api, "/system/storage", {});
  // `core_version` on the wire, and `service` in the client's own shape
  // (fromWireVersion, ui/shared/src/api/client.ts). Read as the wire
  // spells it, because this suite talks to the service and not to the
  // bundle: asking for `service` here got "(unreported)" out of a
  // deployment that was reporting a version perfectly well.
  const version = await readJson<{ core_version?: string }>(api, "/system/version", {});

  return {
    configured: firstRun.configured === true,
    sets: health.backup_sets ?? [],
    backups: backups.artifacts ?? [],
    quarantined: quarantine.artifacts ?? [],
    activityEvents: (activity.events ?? []).length,
    runningOperations: (operations.operations ?? []).filter(
      (op) => op.status === "RUNNING" || op.status === "running" || op.status === "IN_PROGRESS"
    ).length,
    // The same `find` the dashboard does, so the fact and the panel cannot
    // disagree about which cycle is the last one.
    lastCycle: (operations.operations ?? []).find((op) => op.cycle != null)?.cycle ?? null,
    mediums: (settings.mediums ?? []).filter((m) => m.id !== "local"),
    storageLevel: (storage.manager?.level as DeploymentFacts["storageLevel"]) ?? "",
    serviceVersion: version.core_version ?? "(unreported)",
    workflow: await readWorkflowFacts(api)
  };
}

/** A one-line summary, printed at startup so a passing run has said out
 *  loud what it passed against. Every count in it is a reason some spec
 *  either ran or stated why it did not. */
export function describeFacts(facts: DeploymentFacts): string {
  return [
    "service " + facts.serviceVersion,
    facts.configured ? "configured" : "NOT configured (fresh install)",
    facts.sets.length + " backup set(s)",
    facts.backups.length + " backup(s)",
    facts.quarantined.length + " quarantined",
    facts.activityEvents + " activity event(s)",
    facts.lastCycle
      ? "last cycle walked " + facts.lastCycle.artifacts_walked + " and got " +
        facts.lastCycle.artifacts_through + " through"
      : "no finished run cycle",
    facts.mediums.length + " declared storage medium(s)",
    "storage " + (facts.storageLevel === "" ? "unknown" : facts.storageLevel),
    describeWorkflowFacts(facts.workflow)
  ].join(", ");
}

/** The settings document, as the service currently has it. */
export async function readSettings(api: APIRequestContext): Promise<Record<string, unknown>> {
  const response = await api.get(BASE + "/settings");
  if (response.status() !== 200) {
    throw new Error("GET /settings answered " + response.status() + ", so there is nothing to arrange from.");
  }
  return (await response.json()) as Record<string, unknown>;
}

/** Writes part of the settings document, and refuses quietly at nothing.
 *
 *  PATCH rather than PUT is the contract's own shape: an omitted field is
 *  left exactly as the running configuration has it, so an arrange step
 *  changing one threshold cannot accidentally rewrite the retention chain
 *  on its way past. */
export async function patchSettings(api: APIRequestContext, body: unknown): Promise<void> {
  const response = await api.patch(BASE + "/settings", {
    headers: await csrfHeaders(api),
    data: body
  });
  if (response.status() !== 200 && response.status() !== 204) {
    throw new Error("PATCH /settings answered " + response.status() + " rather than 200 or 204.");
  }
}

/** Runs `body`, then puts the capacity thresholds back however it ends.
 *
 *  The arrange step behind the storage-critical cases. Against the mock
 *  those were a `?scenario=` fixture and could never have been real; here
 *  the deployment really is told that it has less headroom than it has,
 *  really does compute CRITICAL from it, and really does escalate the
 *  headline. The restore is in a `finally` because a failed assertion
 *  leaving a deployment permanently in the red would fail the next twenty
 *  specs for a reason that has nothing to do with them. */
export async function withCapacityThresholds<T>(
  api: APIRequestContext,
  thresholds: { warning_free_bytes?: number; critical_free_bytes?: number },
  body: () => Promise<T>
): Promise<T> {
  const before = (await readSettings(api)).capacity as Record<string, number> | undefined;
  if (!before) throw new Error("GET /settings returned no capacity block to restore afterwards.");

  await patchSettings(api, { capacity: thresholds });
  try {
    return await body();
  } finally {
    await patchSettings(api, {
      capacity: {
        warning_free_bytes: before.warning_free_bytes,
        critical_free_bytes: before.critical_free_bytes
      }
    });
  }
}

/** Runs `body`, then puts the retention policy back however it ends.
 *
 *  The settings specs edit the chain and save it, which is exactly what
 *  they should do against a real service, and exactly what leaves the
 *  deployment different for everything after them. */
export async function withRetentionPolicyRestored<T>(
  api: APIRequestContext,
  body: () => Promise<T>
): Promise<T> {
  const before = (await readSettings(api)).retention as Record<string, unknown> | undefined;
  if (!before) throw new Error("GET /settings returned no retention block to restore afterwards.");

  try {
    return await body();
  } finally {
    await patchSettings(api, {
      retention: {
        tiers: before.tiers,
        protect_last_known_good: before.protect_last_known_good,
        timezone: before.timezone,
        week_starts_on: before.week_starts_on
      }
    });
  }
}

/** The manager-wide free space right now, for an arrange step that needs
 *  to name a threshold above it. `null` when the service cannot measure
 *  it, which is its own honest answer rather than a zero. */
export async function freeBytes(api: APIRequestContext): Promise<number | null> {
  const storage = await readJson<{ manager?: { free_bytes?: number; known?: boolean } }>(
    api,
    "/system/storage",
    {}
  );
  if (!storage.manager || storage.manager.known === false) return null;
  return typeof storage.manager.free_bytes === "number" ? storage.manager.free_bytes : null;
}
