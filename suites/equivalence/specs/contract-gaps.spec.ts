import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, signIn, test } from "../harness/fixtures";

// The matrix's gap rows, made executable.
//
// A matrix that only says "this row has no equivalent" rots: somebody
// fixes the product, the row stays marked blocked, and the document that
// was supposed to make the gaps visible starts hiding them instead. So
// every gap this suite claims is pinned by an assertion here, in the same
// strict-expected-failure spirit Suite A's known_discrepancy marker uses:
// red while the gap is open, and red again the moment it closes, which
// forces MATRIX.md to be updated rather than quietly outgrown.
//
// What these cases pin is a finding, not a design. The authoritative
// /api/v1 contract (api/v1/openapi.json, issue #166) is what
// ui/shared/src/api/client.ts is checked against here, because the
// contract-drift gate cannot do it: that gate compares the GENERATED
// bindings, and client.ts is hand-written on top of them, so its paths
// are string literals nothing else reads. findings/DISC-007.md has the
// write-up.
//
// Most of what this file was filed for is now closed. DISC-007 recorded
// fourteen pairs the client called that neither the contract nor the
// router had, which left the Dashboard, Backups, Activity and Quarantine
// pages unable to load against a real backend. backupd#214
// (aba87b7) added them, and this repository saw it when the pin moved
// from 612b48c to 6a93b96. Two pairs remain absent, and they are the
// ones where the client is simply calling the wrong path: GET /version
// and GET /health, which the contract spells /system/version and serves
// outside /api/v1 respectively.

/** Paths ui/shared/src/api/client.ts requests, and whether the engine
 *  actually serves them. Derived by reading both sides, then confirmed
 *  against a running engine by the cases below.
 *
 *  `status` is asserted exactly, not just through `served`, because 403
 *  and 200 are different claims and collapsing them is how this table
 *  would start hiding the thing it exists to show. A route that answers
 *  403 because this probe sends no CSRF token is served; one that answers
 *  403 because the destructive gate is closed is served and refused; one
 *  that answers 404 is absent. Only the last is a gap. Pinning the number
 *  means a catalog route quietly losing its CSRF requirement, or a
 *  readable route regressing behind a gate, both fail here. */
const UI_CALLS: {
  path: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  served: boolean;
  status: number;
  note: string;
}[] = [
  { path: "/system/version", method: "GET", served: true, status: 200, note: "the engine's version route" },
  { path: "/system/capabilities", method: "GET", served: true, status: 200, note: "platform capabilities" },
  { path: "/backup-sets", method: "GET", served: true, status: 200, note: "the one list the UI gets right" },
  { path: "/settings", method: "GET", served: true, status: 200, note: "read half of the settings row" },
  { path: "/validators", method: "GET", served: true, status: 200, note: "wizard picklist" },
  { path: "/auth/session", method: "GET", served: true, status: 200, note: "session probe" },

  // Closed by backupd#214 (aba87b7), which landed inside this
  // repository's 612b48c -> 6a93b96 pin move: every one of these is now
  // registered in apps/common/webhost/router.go AND declared in
  // api/v1/openapi.json. MATRIX.md's rows moved with them.
  { path: "/backups", method: "GET", served: true, status: 200, note: "closed by #214: the Backups page can load" },
  { path: "/activity", method: "GET", served: true, status: 200, note: "closed by #214: the Activity page can load" },
  { path: "/quarantine", method: "GET", served: true, status: 200, note: "closed by #214: the Quarantine page can load" },
  { path: "/operations", method: "GET", served: true, status: 200, note: "closed by #214: GET is declared now, not POST only" },
  // Served, and refused for a reason that is not absence: both carry
  // requireCSRF and NOT requireDestructiveGate (router.go, and
  // handlers_artifacts.go's own comment says so), so the 403 is this
  // probe sending no CSRF token rather than anything about the product.
  // A browser driving them through the real UI carries the token.
  { path: "/catalog/scan", method: "POST", served: true, status: 403, note: "closed by #214; 403 here is CSRF, not a gate" },
  { path: "/catalog/rebuild", method: "POST", served: true, status: 403, note: "closed by #214; 403 here is CSRF, not a gate" },

  { path: "/version", method: "GET", served: false, status: 404, note: "the contract calls it /system/version" },
  { path: "/health", method: "GET", served: false, status: 404, note: "the engine serves /health/live outside /api/v1" },

  // EPIC L's workflow surface (backupd#813/#814/#816). Every mutating
  // one carries `requireCSRF` and, deliberately, NOT
  // `requireDestructiveGate` (apps/common/webhost/router.go): resuming a
  // cleanup is how an operator un-quiesces a machine, and putting it
  // behind the gate that refuses `POST /operations` would leave a source
  // stuck on a deployment that has not turned destructive operations on.
  // So 403 here is this probe sending no token, exactly as the catalog
  // rows above, and a browser driving the real banner carries one. A row
  // flipping to 200 means the CSRF requirement came off something that
  // unwinds hooks on a live machine.
  { path: "/settings/workflow", method: "GET", served: true, status: 200, note: "the deployment-wide hook configuration" },
  { path: "/settings/workflow", method: "PATCH", served: true, status: 403, note: "configure hooks deployment-wide; 403 is CSRF, not a gate" },
  { path: "/settings/workflow/environment", method: "GET", served: true, status: 200, note: "the deployment-wide hook environment" },
  { path: "/settings/workflow/environment/E2E_PROBE", method: "PUT", served: true, status: 403, note: "set a hook variable; 403 is CSRF, not a gate" },
  { path: "/settings/workflow/environment/E2E_PROBE", method: "DELETE", served: true, status: 403, note: "unset a hook variable; 403 is CSRF, not a gate" },
  { path: "/workflow-runs", method: "GET", served: true, status: 200, note: "the workflow run journal" },
  { path: "/workflow-recovery", method: "GET", served: true, status: 200, note: "the hold set the Run control is gated on" },
  // A run id that cannot exist, deliberately: `requireCSRF` refuses
  // before the handler looks one up, so this probe cannot resume or
  // acknowledge anything. A 404 here would mean the CSRF middleware came
  // off and the handler answered instead.
  { path: "/workflow-recovery/e2e-no-such-run/resume-cleanup", method: "POST", served: true, status: 403, note: "resume an interrupted run's cleanup; 403 is CSRF, not a gate" },
  { path: "/workflow-recovery/e2e-no-such-run/acknowledge", method: "POST", served: true, status: 403, note: "acknowledge a held run; 403 is CSRF, not a gate" },

  // The per-set half, against a set this deployment really has: the
  // source and set segments below are substituted at run time, because a
  // GET on a set nobody configured answers 404 and would be recorded
  // here as an absent route.
  { path: "/backup-sets/{source}/{set}/workflow", method: "GET", served: true, status: 200, note: "one set's hook configuration" },
  { path: "/backup-sets/{source}/{set}/workflow", method: "PATCH", served: true, status: 403, note: "configure one set's hooks; 403 is CSRF, not a gate" },
  { path: "/backup-sets/{source}/{set}/workflow/environment", method: "GET", served: true, status: 200, note: "one set's hook environment" },
  { path: "/backup-sets/{source}/{set}/workflow/environment/E2E_PROBE", method: "PUT", served: true, status: 403, note: "set one set's hook variable; 403 is CSRF, not a gate" },
  { path: "/backup-sets/{source}/{set}/workflow/environment/E2E_PROBE", method: "DELETE", served: true, status: 403, note: "unset one set's hook variable; 403 is CSRF, not a gate" },
  // EPIC Q (retnd#953), the assurance and recovery surface. Reads are served
  // and answer 200. Every write carries `requireCSRF` and, deliberately, NOT
  // `requireDestructiveGate`: recovery is outside the gate (Q1.1), and the
  // assurance policy is configuration. So a 403 here is this probe sending no
  // CSRF token, and a row flipping to 200 means the requirement came off;
  // one flipping to a 403 that names the gate means a recovery became
  // impossible on every deployment this repository can build.
  { path: "/settings/assurance", method: "GET", served: true, status: 200, note: "the deployment-wide assurance policy" },
  { path: "/settings/assurance", method: "PATCH", served: true, status: 403, note: "change it; 403 is CSRF, not a gate" },
  { path: "/assurance/due", method: "GET", served: true, status: 200, note: "the scrub schedule, per copy" },
  { path: "/backup-sets/{source}/{set}/assurance", method: "GET", served: true, status: 200, note: "one set's resolved policy" },
  { path: "/backup-sets/{source}/{set}/assurance", method: "PATCH", served: true, status: 403, note: "give a set its own policy; 403 is CSRF, not a gate" },
  { path: "/backup-sets/{source}/{set}/assurance", method: "DELETE", served: true, status: 403, note: "hand a set back to the deployment; 403 is CSRF, not a gate" },
  // A name that cannot exist: `requireCSRF` refuses before the handler looks
  // an artifact up, so this probe mints nothing.
  { path: "/backups/{source}/{set}/e2e-no-such-artifact/recovery", method: "POST", served: true, status: 403, note: "mint a recovery grant; 403 is CSRF, and notably not the destructive gate" },
];

/** The CLI verbs this matrix's rows depend on, and whether the product has
 *  them.
 *
 *  This table exists because the one above could not have caught the drift
 *  that made it necessary. UI_CALLS pins the routes ui/shared's client
 *  requests, so it notices a UI-side gap opening or closing and it is blind
 *  to the CLI half entirely. Both rows that went stale (edit a backup set,
 *  and a backup set's own retention policy) were CLI-side gaps: the verb
 *  landed, the matrix went on saying it had not, and nothing anywhere went
 *  red. A coverage matrix that can quietly stop being true is worse than no
 *  matrix, because people believe it.
 *
 *  Read black-box, out of the binary's own usage text, rather than by
 *  grepping the Go source for a registration. The usage block is what an
 *  operator is told the product can do, so pinning that is pinning the
 *  claim rather than the implementation, and it does not break every time
 *  somebody refactors how commands dispatch.
 *
 *  `present: false` rows are the load-bearing ones. They are the matrix's
 *  gap claims, and each goes red the day someone lands the verb, which is
 *  the signal that a row needs rewriting. */
const CLI_VERBS: { verb: string; present: boolean; note: string }[] = [
  { verb: "backup-set create", present: true, note: "the create row's CLI half" },
  {
    verb: "backup-set patch",
    present: true,
    note: "landed in backupd#350; the edit row moved from gap to unproved with it"
  },
  {
    verb: "backup-set retention",
    present: true,
    note: "landed in backupd#333; the per-set retention row was added for it"
  },
  { verb: "settings patch", present: true, note: "the settings row's CLI half" },
  { verb: "quarantine", present: true, note: "the revalidate half of the quarantine row" },
  { verb: "catalog rebuild", present: true, note: "the catalog recovery row's CLI half" },
  {
    verb: "backup-set remove",
    present: true,
    note: "the remove row's CLI half, landed by backupd#391. This entry used to read `backup-set delete` and `present: false`, which is the mistake the exhaustiveness case below exists to stop repeating"
  },
  {
    verb: "backup-set enabled",
    present: true,
    note: "the enable/disable row's CLI half. This entry used to read `backup-set enable` and `present: false`, which is the same mistake the remove row made: the verb had shipped under a name nobody pinned, and the matrix went on calling it a gap"
  },
  {
    verb: "backup-set read-only",
    present: true,
    note: "a set's read-only posture, pinned so the exhaustiveness case below has an entry for every subverb `backup-set` offers"
  },
  {
    verb: "backup-set edit-hold",
    present: true,
    note: "the edit hold, same reason as the row above"
  },
  {
    verb: "backup-set test-connection",
    present: true,
    note: "the standalone connection test the SSH row records as having no CLI counterpart at all. It has one now, under `backup-set`, which is what the exhaustiveness case is for"
  },

  // EPIC L (backupd#813/#814/#816). Every mutating workflow action the
  // Web UI offers has a CLI counterpart, and the two that do NOT are
  // the interesting rows: there is no cancel verb anywhere, and the CLI
  // refuses `fetch --skip-workflow-scripts` by design.
  {
    verb: "backup-set workflow",
    present: true,
    note: "one set's hook configuration and environment: `workflow <set>`, `workflow patch <set>`, `workflow env <set> list|set|unset`"
  },
  {
    verb: "settings workflow",
    present: true,
    note: "the deployment-wide hook configuration and environment, the CLI half of Settings > Workflow"
  },
  {
    verb: "validate workflow",
    present: true,
    note: "the CLI half of the card's `Check this set's hooks`: the same validation report, findings and two verdicts"
  },
  {
    verb: "workflow run",
    present: true,
    note: "`run list|show|steps|log`, the CLI half of the run history, the run page and the step terminal"
  },
  {
    verb: "workflow recovery",
    present: true,
    note: "`recovery show|resume-cleanup|acknowledge`, the CLI half of the recovery banner and both of its buttons"
  },
  // EPIC Q (retnd#953). Recovery and assurance arrived on both surfaces, with
  // the two exceptions MATRIX.md's EPIC Q section names (no route starts a
  // scrub, and nothing starts a recovery test but the schedule).
  { verb: "settings assurance", present: true, note: "the deployment-wide assurance policy: `settings assurance [patch ...]` and `settings assurance due`" },
  { verb: "backup-set assurance", present: true, note: "one set's resolved policy, its own override, and `--reset`" },
  { verb: "scrub", present: true, note: "check the durable copies now: the CLI half of a scrub the browser can only show the command for" },
  { verb: "recover", present: true, note: "stream one retained copy to stdout, a staging name or a medium: the CLI half of Recover artifact" },
  {
    verb: "activity",
    present: false,
    note: "the activity feed row: no CLI command exposes an event log"
  }
];

/** The binary's whole usage block, which it prints on an unknown command.
 *
 *  Square brackets are stripped and whitespace is collapsed before anything
 *  is matched against it. The usage text wraps and marks optional operands,
 *  so `settings patch` is printed as `settings [patch [--timezone T]` and a
 *  plain substring search misses it. I found that by running this table
 *  against the real binary and watching it claim `settings patch` had been
 *  removed from a product that has it, which is the failure mode this whole
 *  case exists to prevent, so it seemed worth fixing rather than working
 *  around by picking a looser verb string. */
function cliUsage(cliPath: string): string {
  return normaliseUsage(rawCliUsage(cliPath));
}

/** The usage block exactly as the binary prints it, lines intact. */
function rawCliUsage(cliPath: string): string {
  const res = spawnSync(cliPath, ["--help"], { encoding: "utf8" });
  return (res.stdout ?? "") + (res.stderr ?? "");
}

function normaliseUsage(raw: string): string {
  return raw.replace(/[[\]]/g, " ").replace(/\s+/g, " ");
}

/** Every subverb the binary offers under one command, read off the usage
 *  block's own indented entries.
 *
 *  This exists because CLI_VERBS was a spot-check and a spot-check cannot
 *  see a verb that shipped under a name nobody pinned. The table asserted
 *  `backup-set delete` was absent, which was true and useless: the product
 *  had shipped `backup-set remove`, the matrix row still said neither
 *  surface had one, and nothing anywhere went red. Enumerating what the
 *  binary actually offers turns "I pinned the wrong string" from invisible
 *  into a failure. */
function cliSubverbs(raw: string, family: string): string[] {
  const found = new Set<string>();
  for (const line of raw.split("\n")) {
    const m = /^ {2}([a-z][a-z-]*) ([a-z][a-z-]*)/.exec(line);
    if (m && m[1] === family) found.add(m[2]);
  }
  return [...found].sort();
}

/** The (method, path) pairs api/v1/openapi.json declares. Method matters:
 *  /operations is in the contract for POST only, and the UI client calls
 *  GET on it, so comparing paths alone would report agreement where there
 *  is none. That is exactly the mistake the first version of this case
 *  made, and it is why the pair is the unit here. */
function contractOperations(sourceDir: string): Set<string> {
  const raw = JSON.parse(readFileSync(resolve(sourceDir, "api/v1/openapi.json"), "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const ops = new Set<string>();
  for (const [path, methods] of Object.entries(raw.paths)) {
    for (const method of Object.keys(methods)) ops.add(method.toUpperCase() + " " + path);
  }
  return ops;
}

test.describe("the matrix's gap rows", () => {
  test("every path the UI client calls is served, or is a gap this matrix names", async ({ page, pair }) => {
    await signIn(page, pair.ui);

    // The set every per-set row is probed against. Read from the
    // deployment rather than written down, because a set id this suite
    // invented would answer 404 and be recorded as an absent route.
    const sets = (await (await page.request.get(pair.ui.uiUrl + "/api/v1/backup-sets")).json()) as {
      backup_sets?: { id?: string }[];
    };
    const anySet = (sets.backup_sets ?? []).map((s) => s.id ?? "").find((id) => id.includes("/"));
    expect(
      anySet,
      "this fixture configures no backup set, so every per-set row below would be probed against " +
        "a path nobody serves and recorded as an absent route"
    ).toBeTruthy();

    const surprises: string[] = [];
    for (const call of UI_CALLS) {
      const [source, set] = (anySet ?? "/").split("/");
      const path = call.path.replace("{source}", encodeURIComponent(source)).replace(
        "{set}",
        encodeURIComponent(set)
      );
      const url = pair.ui.uiUrl + "/api/v1" + path;
      // `fetch` rather than the per-verb helpers: EPIC L's configuration
      // surface writes with PATCH, PUT and DELETE, and a table that
      // could only express GET and POST would have to leave the
      // mutating half of a whole feature unpinned.
      const res = await page.request.fetch(url, { method: call.method });
      const reachable = res.status() !== 404 && res.status() !== 405;
      if (reachable !== call.served) {
        surprises.push(
          `${call.method} ${call.path} returned ${res.status()}, but this matrix records it as ` +
            (call.served ? "served" : "absent") +
            ` (${call.note})`
        );
      } else if (res.status() !== call.status) {
        // Same verdict on present-or-absent, different answer. Worth
        // failing on its own: a route going 403 -> 200 means a gate or a
        // CSRF requirement came off, and 200 -> 403 means one went on,
        // and MATRIX.md states which of those each row is.
        surprises.push(
          `${call.method} ${call.path} returned ${res.status()}, and this matrix records ${call.status} ` +
            `(${call.note})`
        );
      }
    }
    expect(
      surprises,
      "MATRIX.md and the product disagree. If the product was fixed, that is good news and the matrix has to be " +
        "updated; what must not happen is the matrix keeping a gap row nobody rechecks:\n" +
        surprises.join("\n")
    ).toEqual([]);
  });

  test("the absent paths are absent from the authoritative contract too", async ({ pair }) => {
    // The engine and the contract have to agree about the gap, otherwise
    // it is a routing bug rather than a missing feature, and the fix is a
    // different one. This reads api/v1/openapi.json from the checkout the
    // build under test came from, so it cannot drift from what ran.
    const source = process.env.RETND_UI_DIR ? resolve(process.env.RETND_UI_DIR, "../..") : (pair.build.source_dir ?? "");
    const declared = contractOperations(source);

    for (const call of UI_CALLS.filter((c) => !c.served)) {
      expect(
        declared.has(call.method + " " + call.path),
        `${call.method} ${call.path} is refused by the engine but declared in api/v1/openapi.json, which would be a ` +
          `routing bug rather than a missing feature`
      ).toBe(false);
    }
    // The control: an operation this matrix records as served must be in
    // the contract, or the checks above are reading an unrelated file.
    expect(declared.has("GET /system/version")).toBe(true);
    // And the pair really is the unit rather than the path. /operations
    // used to make this point, declared for POST while the UI client
    // called GET on it, but backupd#214 declared the GET too and
    // the example stopped being asymmetric. /backup-sets/test-connection
    // still is: POST is declared, GET is not, so a path-only comparison
    // would report agreement about a method nobody serves.
    expect(declared.has("POST /operations")).toBe(true);
    expect(declared.has("GET /operations")).toBe(true);
    expect(declared.has("POST /backup-sets/test-connection")).toBe(true);
    expect(declared.has("GET /backup-sets/test-connection")).toBe(false);
  });


  test("the CLI verbs this matrix claims, and the ones it claims are missing", async ({ pair }) => {
    // The check the matrix was missing. Both stale rows were CLI-side, and
    // UI_CALLS above cannot see the CLI at all, so the matrix drifted for
    // weeks with every suite green.
    const usage = cliUsage(pair.build.cli);

    // Anti-vacuity first. An empty read, or a binary that failed to start,
    // would let every assertion below pass by finding nothing.
    expect(
      usage.length,
      "retnd printed no usage at all, so this case compared nothing"
    ).toBeGreaterThan(200);
    expect(
      usage,
      "the usage block does not mention `version`, so this is not the usage text this case thinks it is reading"
    ).toContain("version");

    const wrong: string[] = [];
    for (const v of CLI_VERBS) {
      const found = usage.includes(v.verb);
      if (found && !v.present) {
        wrong.push(
          `${v.verb} EXISTS now and this matrix records it as absent (${v.note}). ` +
            `A row is claiming a gap that has closed, so rewrite the row and flip this entry.`
        );
      }
      if (!found && v.present) {
        wrong.push(
          `${v.verb} is GONE and this matrix records it as present (${v.note}). ` +
            `Either the verb was renamed or a row is claiming coverage that no longer exists.`
        );
      }
    }
    expect(wrong.join("\n"), "the matrix and the CLI disagree:\n" + wrong.join("\n")).toEqual("");
  });


  test("every subverb the binary offers under a covered command has an entry", async ({ pair }) => {
    // The case that would have caught the mistake this table just made.
    //
    // The case above asks "is each verb I pinned where I said it is", which
    // is only ever as good as the strings somebody thought to pin. This one
    // asks the opposite question, "is there anything here I did not pin",
    // and that is the one that notices a verb shipping under a name the
    // matrix never considered.
    const raw = rawCliUsage(pair.build.cli);
    // `workflow` joins `backup-set` here because EPIC L put a whole
    // feature's inspection surface under one noun with two levels below
    // it, which is exactly the shape a verb hides in: `workflow run log`
    // shipped under a name this matrix would never have guessed, and a
    // spot-check of the two nouns somebody thought of is how the remove
    // row stayed wrong for weeks.
    const covered = ["backup-set", "workflow"];

    for (const family of covered) {
      const offered = cliSubverbs(raw, family);

      // Anti-vacuity: a family that parses to nothing would let this pass
      // by finding nothing to check, which is exactly the shape of failure
      // this whole file is about.
      expect(
        offered.length,
        `parsed no subverbs at all under "${family}", so this case compared nothing. ` +
          `Either the usage block's shape changed or cliSubverbs is reading it wrong`
      ).toBeGreaterThan(1);

      const pinned = new Set(
        CLI_VERBS.filter((v) => v.verb.startsWith(family + " ")).map((v) => v.verb.slice(family.length + 1))
      );
      const unpinned = offered.filter((sub) => !pinned.has(sub));
      expect(
        unpinned.join(", "),
        `${family} offers ${unpinned.map((s) => `"${family} ${s}"`).join(", ")} and this matrix has no entry for it. ` +
          `A verb can ship under a name nobody pinned, which is how the remove row stayed a gap after ` +
          `backupd#391 closed it. Add an entry and check the MATRIX.md row that verb belongs to`
      ).toEqual("");
    }
  });

  test("the destructive gate, not a missing route, is what blocks the mutation rows", async ({ page, pair }) => {
    // Run backup and retention apply are the two rows an operator would
    // most want proved equivalent, and they are blocked differently from
    // the rows above: the routes exist and the contract declares them, but
    // apps/common/webhost's NewEngine never sets a destructive gate, so
    // NotYetImplementedGate refuses every one of them. The CLI has no such
    // gate, so `fetch` and `run` work. That asymmetry is the gap.
    await signIn(page, pair.ui);
    const res = await page.request.post(pair.ui.uiUrl + "/api/v1/operations", {
      data: { type: "run_cycle" },
      headers: { "X-CSRF-Token": await csrf(page) }
    });
    expect(res.status(), "the destructive gate has opened, so the mutation rows can now be proved").toBe(403);
    expect(await res.text()).toContain("DESTRUCTIVE_OPERATIONS_DISABLED");
  });
});

async function csrf(page: import("@playwright/test").Page): Promise<string> {
  const cookie = (await page.context().cookies()).find((c) => c.name === "retnd_csrf");
  if (!cookie) throw new Error("no retnd_csrf cookie, so a CSRF-gated request cannot be made");
  return cookie.value;
}
