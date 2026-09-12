import type { Page } from "@playwright/test";

import {
  NEEDS_BREAKABLE_ENGINE,
  canBreakEngine,
  resolveEngineControl,
  startEngine,
  stopEngine,
  withEngineStopped
} from "../harness/engine";
import { expect, needs, test } from "./fixtures";

/**
 * backupd#795, against the deployment rather than against the browser.
 *
 * An operator upgraded a UGREEN NAS, opened the Activity page, and was
 * shown nothing at all. Their `backupd-web serve-ui` container was logging
 * `dial tcp: lookup rclone-manager on 127.0.0.11:53: no such host`: the
 * engine container had been renamed underneath it, so the reverse proxy
 * had an upstream name that no longer resolved, and every `/api/v1` call
 * the page made died one hop behind the web server.
 *
 * # What this file does that `activity-failure.spec.ts` cannot
 *
 * That file reproduces both failure SHAPES with `page.route`: a 200
 * carrying bytes the build cannot parse (#598), and a fetch that rejects
 * (#730/#795). Both are real substitutions - the app, the bundle off
 * serve-ui, the router, the error boundary and the session are all the
 * deployment's own - and both are cheap enough to run on every Suite B
 * run, which is why they stay.
 *
 * But they substitute the outcome INSIDE the browser, and #795 happened
 * OUTSIDE it. Nothing a route handler does makes serve-ui try to reach an
 * engine and fail, so nothing in that file can fail on:
 *
 *   - what serve-ui's reverse proxy actually answers when its upstream is
 *     gone, and whether that answer carries the `X-Correlation-Id` its own
 *     `proxy_error` log line quotes;
 *   - what the build does with THAT answer, as opposed to with a rejected
 *     fetch - a bodyless 502 from the gateway is a third shape, and it is
 *     the one the reported NAS actually produced;
 *   - whether the page an operator lands on says which of the two machines
 *     failed.
 *
 * So this file asks the rig to stop the engine container for real, and
 * asserts on what a browser is then shown. Every request it makes leaves
 * the page, crosses the edge network, reaches serve-ui, and fails where
 * the NAS's failed.
 *
 * # Why the break happens mid-session
 *
 * serve-ui proxies the whole of /api/v1, `auth/session` included, so with
 * the engine already down at page load the bundle's auth fetch fails, the
 * app renders its login screen, and there is no Activity page to look at
 * (harness/engine.ts has the detail). The NAS did not hit that because the
 * tab was already open and already signed in when the engine went away.
 * These cases reproduce that order: load the app against a healthy engine,
 * take the engine away, then navigate with the router the way an operator
 * clicking the sidebar does.
 *
 * # Cost, and the heal
 *
 * Each case stops and restarts a container, so each buys its own timeout.
 * Every one of them restores the engine in a `finally`, and the whole file
 * restores it again in `afterAll`, because one deployment is shared by the
 * entire run: an engine left stopped here would not fail this file, it
 * would fail every file after it for reasons none of them mention.
 */

/** The one string the product must never render as a correlation id
 *  (#598). Repeated from `activity-failure.spec.ts` rather than shared,
 *  because the two files must be able to disagree about everything except
 *  this. */
const NOT_AN_ID = "correlation id unavailable";

/** A service that DID NOT ANSWER, in whichever of its two honest forms
 *  this deployment produces: the browser's fetch rejected outright, or
 *  serve-ui answered for it and said it could not reach the engine. */
const DID_NOT_ANSWER = /did not answer|could not reach|unreachable|no response|not responding/i;

/** And the words that belong to the OTHER failure - a service that
 *  answered with something this build could not parse (#598). Borrowing
 *  them here would send an operator to read logs on the machine that was
 *  working. */
const ANSWERED_UNREADABLY = /could not read the answer/i;

interface ActivityTraffic {
  /** Every answer the page got for an activity read, in order. */
  readonly responses: Array<{ status: number; correlationId: string | null }>;
  /** Every activity read that got no answer at all, with the browser's own
   *  reason. */
  readonly failures: string[];
}

/** Records what the ACTIVITY calls on this page do at the transport level.
 *
 *  This is the file's proof that it is not the other file: a `page.route`
 *  reproduction produces no response and no request failure here, because
 *  the request never leaves the browser. Every case below asserts that
 *  something really went out and really did not come back well. */
function recordActivityTraffic(page: Page): ActivityTraffic {
  const responses: Array<{ status: number; correlationId: string | null }> = [];
  const failures: string[] = [];
  page.on("response", (response) => {
    if (!response.url().includes("/api/v1/activity")) return;
    responses.push({
      status: response.status(),
      correlationId: response.headers()["x-correlation-id"] ?? null
    });
  });
  page.on("requestfailed", (request) => {
    if (!request.url().includes("/api/v1/activity")) return;
    failures.push(request.failure()?.errorText ?? "no reason given");
  });
  return { responses, failures };
}

test.describe("the engine, taken away under a loaded browser", () => {
  // The engine is put back however this file ends, including the one path
  // a per-case `finally` cannot cover: a case that exceeds its own timeout
  // is abandoned mid-await and never runs its own cleanup.
  test.afterAll(async () => {
    const control = resolveEngineControl();
    if (control !== null) await startEngine(control);
  });

  test("the Activity page says the engine could not be reached, instead of drawing an empty feed", async ({
    bm,
    page
  }) => {
    needs(canBreakEngine(), NEEDS_BREAKABLE_ENGINE);
    // An empty timeline is a claim about the DEPLOYMENT - "nothing has
    // happened here" - and it is a false one on a deployment the rig
    // seeded with a real backup. That is the whole of what #795 gave its
    // operator, and it is only a lie that can be caught on a deployment
    // that really does hold events.
    needs(
      bm.facts.activityEvents > 0,
      "at least one recorded activity event, so an empty feed would be a false claim rather than a true one"
    );
    test.setTimeout(300_000);

    const control = resolveEngineControl()!;
    const traffic = recordActivityTraffic(page);
    // Loaded, and signed in, while the engine is still there. Same as the
    // operator's tab before the upgrade renamed the container.
    await bm.goto("/");

    await withEngineStopped(control, async () => {
      // The router, not a reload: a reload would re-run the auth fetch and
      // put the browser on the login screen, which is a different bug (and
      // one #795's fix also addresses) rather than this one.
      await bm.navigateTo("Activity");

      await expect(page.getByRole("alert")).toBeVisible();
      await expect(page.getByText("No matching events")).toHaveCount(0);
      // And the request really left this browser. Without this the case
      // would pass against a `page.route` stub, which is the thing this
      // file exists not to be.
      expect(traffic.responses.length + traffic.failures.length).toBeGreaterThan(0);
    });
  });

  test("names a service that did not answer, not one that answered unreadably", async ({
    bm,
    page
  }) => {
    needs(canBreakEngine(), NEEDS_BREAKABLE_ENGINE);
    test.setTimeout(300_000);

    const control = resolveEngineControl()!;
    await bm.goto("/");

    await withEngineStopped(control, async () => {
      await bm.navigateTo("Activity");
      const alert = page.getByRole("alert");
      await expect(alert).toBeVisible();

      // The distinction an operator acts on. One of these sends them to
      // look at why the engine is not answering; the other sends them to
      // look at a build that cannot parse a good answer. The reported NAS
      // needed the first and was given a sentence that named neither.
      await expect(alert).toContainText(DID_NOT_ANSWER);
      await expect(alert).not.toContainText(ANSWERED_UNREADABLY);

      // Nothing answered from behind the proxy, so there may be no
      // correlation id to quote - and the product's answer to that must be
      // to say nothing, never to print the placeholder as though it were
      // one (#598).
      await expect(page.locator("body")).not.toContainText(NOT_AN_ID);
      await expect(page.locator("body")).not.toContainText("unavailable");

      // §37: the exception's words are a diagnostic, the frames under it
      // are somebody's filesystem.
      const body = await page.locator("body").innerText();
      expect(body).not.toContain("    at ");
      expect(body).not.toMatch(/\/src\/[A-Za-z]+\.tsx?/);
    });
  });

  test("what the browser is actually handed is a gateway failure it can quote", async ({
    bm,
    page
  }) => {
    needs(canBreakEngine(), NEEDS_BREAKABLE_ENGINE);
    test.setTimeout(300_000);

    const control = resolveEngineControl()!;
    const traffic = recordActivityTraffic(page);
    await bm.goto("/");

    await withEngineStopped(control, async () => {
      await bm.navigateTo("Activity");
      await expect(page.getByRole("alert")).toBeVisible();

      // Two honest shapes, and which one this deployment produces is the
      // deployment's business, not this suite's: serve-ui can answer for
      // the engine it could not reach, or the browser can get nothing at
      // all. What is asserted is that it is one of them, and that the
      // first one carries the id its own log line quotes.
      //
      // That header is the whole reason this case cannot live in
      // `activity-failure.spec.ts`: an aborted route produces no response
      // to read it off.
      expect(traffic.responses.length + traffic.failures.length).toBeGreaterThan(0);
      for (const answer of traffic.responses) {
        expect(answer.status).toBeGreaterThanOrEqual(500);
        // A 502 with no correlation id is a failure nobody can trace: the
        // operator has a red banner, the proxy has a `proxy_error` line,
        // and nothing joins them.
        expect(answer.correlationId ?? "").not.toBe("");
      }
    });
  });

  test("the dashboard's Recent activity panel surfaces it too", async ({ bm, page }) => {
    needs(canBreakEngine(), NEEDS_BREAKABLE_ENGINE);
    needs(bm.facts.configured, "a configured deployment, so the dashboard renders its panels at all");
    test.setTimeout(300_000);

    const control = resolveEngineControl()!;
    await bm.goto("/activity");

    await withEngineStopped(control, async () => {
      // The surface an operator lands on first, reached the way they reach
      // it. A panel that read this call and never read its error draws an
      // empty list here, which on a seeded deployment is indistinguishable
      // from a NAS where nothing has ever happened.
      await bm.navigateTo("Dashboard");
      const panel = page.getByRole("region", { name: "Recent activity" });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("alert")).toBeVisible();
      await expect(panel.getByRole("alert")).toContainText(DID_NOT_ANSWER);
      await expect(panel).not.toContainText(NOT_AN_ID);
    });
  });

  test("Try again re-issues the read, and the page comes back when the engine does", async ({
    bm,
    page
  }) => {
    needs(canBreakEngine(), NEEDS_BREAKABLE_ENGINE);
    needs(
      bm.facts.activityEvents > 0,
      "at least one recorded activity event, so the recovered page has something to draw"
    );
    test.setTimeout(300_000);

    const control = resolveEngineControl()!;
    const traffic = recordActivityTraffic(page);
    await bm.goto("/");

    await stopEngine(control);
    try {
      await bm.navigateTo("Activity");
      const alert = page.getByRole("alert");
      await expect(alert).toBeVisible();

      // Pressed against a service that is still down: the button has to
      // leave evidence it ran, or it is a control people press harder at
      // an unchanged screen.
      const before = traffic.responses.length + traffic.failures.length;
      await alert.getByRole("button", { name: /try again/i }).click();
      await expect(alert.getByText(/tried again at/i)).toBeVisible();
      expect(traffic.responses.length + traffic.failures.length).toBeGreaterThan(before);

      // And then the operator fixes their deployment. This is the case
      // that keeps every assertion in this file honest: a build that drew
      // that banner permanently would satisfy all of them.
      await startEngine(control);
      await page.getByRole("alert").getByRole("button", { name: /try again/i }).click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByRole("listitem").first()).toBeVisible();
    } finally {
      // Already running by the happy path; the rig acks a redundant start
      // rather than refusing it, so this costs one round trip and covers
      // every path that did not get that far.
      await startEngine(control);
    }
  });

  test("leaves the deployment the way the rest of the run expects to find it", async ({
    bm,
    page
  }) => {
    // Not a formality, and not a duplicate of the recovery case above: that
    // one proves a live page recovers, this one proves a COLD one does. A
    // full load re-runs the auth fetch through serve-ui into the engine, so
    // this is the assertion that the restarted container is serving
    // sessions again - which is the precondition every spec after this file
    // depends on and none of them states.
    needs(canBreakEngine(), NEEDS_BREAKABLE_ENGINE);
    test.setTimeout(120_000);

    await bm.goto("/activity");
    await expect(page.getByRole("alert")).toHaveCount(0);
    needs(bm.facts.activityEvents > 0, "at least one recorded activity event, so the feed has rows to draw");
    await expect(page.getByRole("listitem").first()).toBeVisible();
  });
});
