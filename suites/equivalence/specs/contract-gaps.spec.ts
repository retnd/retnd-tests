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
// pages unable to load against a real backend. rclone-manager#214
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
  method: "GET" | "POST";
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

  // Closed by rclone-manager#214 (aba87b7), which landed inside this
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
  { path: "/health", method: "GET", served: false, status: 404, note: "the engine serves /health/live outside /api/v1" }
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
    note: "landed in rclone-manager#350; the edit row moved from gap to unproved with it"
  },
  {
    verb: "backup-set retention",
    present: true,
    note: "landed in rclone-manager#333; the per-set retention row was added for it"
  },
  { verb: "settings patch", present: true, note: "the settings row's CLI half" },
  { verb: "quarantine", present: true, note: "the revalidate half of the quarantine row" },
  { verb: "catalog rebuild", present: true, note: "the catalog recovery row's CLI half" },
  {
    verb: "backup-set remove",
    present: true,
    note: "the remove row's CLI half, landed by rclone-manager#391. This entry used to read `backup-set delete` and `present: false`, which is the mistake the exhaustiveness case below exists to stop repeating"
  },
  {
    verb: "backup-set enable",
    present: false,
    note: "the enable/disable row stays a gap on this side; POST .../enabled is served"
  },
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

    const surprises: string[] = [];
    for (const call of UI_CALLS) {
      const url = pair.ui.uiUrl + "/api/v1" + call.path;
      const res = call.method === "GET" ? await page.request.get(url) : await page.request.post(url);
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
    const source = process.env.RM_UI_DIR ? resolve(process.env.RM_UI_DIR, "../..") : (pair.build.source_dir ?? "");
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
    // called GET on it, but rclone-manager#214 declared the GET too and
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
      "backup-manager printed no usage at all, so this case compared nothing"
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
    const covered = ["backup-set"];

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
          `rclone-manager#391 closed it. Add an entry and check the MATRIX.md row that verb belongs to`
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
  const cookie = (await page.context().cookies()).find((c) => c.name === "bm_csrf");
  if (!cookie) throw new Error("no bm_csrf cookie, so a CSRF-gated request cannot be made");
  return cookie.value;
}
