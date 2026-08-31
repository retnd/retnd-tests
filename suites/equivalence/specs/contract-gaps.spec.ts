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
// /api/v1 contract (api/v1/openapi.json, issue #166) defines 19 paths.
// ui/shared/src/api/client.ts calls thirteen more that are in neither the
// contract nor the engine's router, so against a real backend the
// Dashboard, Backups, Activity and Quarantine pages cannot load at all.
// The contract-drift gate does not catch it because it compares the
// GENERATED bindings, and client.ts is hand-written on top of them.
// findings/DISC-007.md has the write-up.

/** Paths ui/shared/src/api/client.ts requests, and whether the engine
 *  actually serves them. Derived by reading both sides, then confirmed
 *  against a running engine by the cases below. */
const UI_CALLS: { path: string; method: "GET" | "POST"; served: boolean; note: string }[] = [
  { path: "/system/version", method: "GET", served: true, note: "the engine's version route" },
  { path: "/system/capabilities", method: "GET", served: true, note: "platform capabilities" },
  { path: "/backup-sets", method: "GET", served: true, note: "the one list the UI gets right" },
  { path: "/settings", method: "GET", served: true, note: "read half of the settings row" },
  { path: "/validators", method: "GET", served: true, note: "wizard picklist" },
  { path: "/auth/session", method: "GET", served: true, note: "session probe" },

  { path: "/version", method: "GET", served: false, note: "the contract calls it /system/version" },
  { path: "/health", method: "GET", served: false, note: "the engine serves /health/live outside /api/v1" },
  { path: "/backups", method: "GET", served: false, note: "no route at all: the Backups page cannot load" },
  { path: "/activity", method: "GET", served: false, note: "no route at all: the Activity page cannot load" },
  { path: "/quarantine", method: "GET", served: false, note: "no route at all: the Quarantine page cannot load" },
  { path: "/operations", method: "GET", served: false, note: "POST /operations exists, GET does not" },
  { path: "/catalog/scan", method: "POST", served: false, note: "no route: catalog recovery cannot be driven" },
  { path: "/catalog/rebuild", method: "POST", served: false, note: "no route: `catalog rebuild` has no UI equivalent" }
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
    // And the pair really is the unit: /operations is declared for POST
    // while the UI client calls GET on it, so a path-only comparison would
    // have called that agreement.
    expect(declared.has("POST /operations")).toBe(true);
    expect(declared.has("GET /operations")).toBe(false);
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
