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
