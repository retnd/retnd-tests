import { setTimeout as sleep } from "node:timers/promises";

import { TRUNCATION_MARKER, WorkflowScreens } from "./workflow-page";
import { HOSTILE, MANY_AFTER, MANY_BEFORE, SLOW_SCRIPT } from "./workflow-scripts";
import { expect, needs, test } from "./fixtures";
import {
  HOSTILE_SET_VAR,
  MANY_STEPS_SET_VAR,
  SLOW_SET_VAR,
  needsFixture,
  runAppearMs,
  newestRun,
  readWorkflowSteps,
  waitForNewRun,
  waitForRunToSettle
} from "../harness/workflow";

/**
 * The step log terminal, against output a hostile hook really wrote
 * (backupd#816, the #815 half of EPIC L).
 *
 * # What a component test cannot say here
 *
 * `StepLogTerminal`'s own unit tests feed it records and assert on what
 * it draws, which proves the sanitiser. They cannot prove the thing an
 * operator is actually exposed to, because the bytes in those tests were
 * written by the test. Here the bytes were written by a script that ran
 * in the hook image, were captured by the engine, stored in SQLite,
 * served over HTTP, proxied, parsed by the real bundle and painted by a
 * real browser. Every one of those hops can undo a sanitiser.
 *
 * So the assertions are about EFFECTS and not about markup: did the tab
 * navigate, did anything fetch `hostile.invalid`, did the document title
 * change, did the window resize. A product that rendered the escape
 * sequences as inert text passes all four; a product that handed them to
 * a terminal emulator with link handling on fails at least one.
 *
 * # One viewer, however many steps
 *
 * #815 requires exactly one mounted terminal on a run with many steps,
 * with the other steps' scrollbacks kept for instant switching. Both
 * halves are asserted the same way a browser can observe them: by
 * counting mounted panels, and by counting REQUESTS - coming back to a
 * step that has already been read must not read it again.
 */

// A run is a real backup plus real hooks, and this suite cannot start
// one: the destructive gate refuses the product's own Run control
// (backupd#92), so each case waits for the scheduler's next pass at the
// shortest legal interval the product allows. The suite-wide 90s is for
// pages; this file waits on a deployment to come round to a set.
test.describe.configure({ timeout: 480_000 });

/** The follower's delay, in the throttled case. Long enough that a
 *  duration computed from when the log finished arriving would be
 *  obviously wrong, short enough that the case still finishes. */
const FOLLOWER_DELAY_MS = 1_200;

/** A duration the terminal printed, back as milliseconds.
 *
 *  The product formats one of four ways ("412 ms", "3.4 s", "41 s",
 *  "2m 7s"), and a case that stripped the non-digits would read "2m 7s"
 *  as 27. `null` for anything else, including the em dash a step with no
 *  recorded duration draws, so the caller reports what it was shown
 *  rather than comparing against a silent zero. */
function millisecondsFrom(label: string): number | null {
  const text = label.trim();
  const ms = /^([\d.]+) ms$/u.exec(text);
  if (ms !== null) return Number(ms[1]);
  const seconds = /^([\d.]+) s$/u.exec(text);
  if (seconds !== null) return Number(seconds[1]) * 1_000;
  const minutes = /^(\d+)m (\d+)s$/u.exec(text);
  if (minutes !== null) return (Number(minutes[1]) * 60 + Number(minutes[2])) * 1_000;
  const hours = /^(\d+)h (\d+)m$/u.exec(text);
  if (hours !== null) return (Number(hours[1]) * 3_600 + Number(hours[2]) * 60) * 1_000;

  return null;
}

test.describe("the step log terminal", () => {
  test.beforeEach(async ({ bm }) => {
    needs(
      bm.facts.workflow.served,
      "a build that serves the workflow routes: there is no step terminal without them"
    );
  });

  test("hostile output is drawn and never acted on", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.hostileSet;
    needs(set !== null, needsFixture(HOSTILE_SET_VAR));

    // Everything the hook tried to do, watched from outside the page.
    const offsite: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("hostile.invalid")) offsite.push(req.url());
    });
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    const before = await newestRun(bm.api, set!);
    // NOT pressed: `POST /api/v1/operations` is refused with
    // DESTRUCTIVE_OPERATIONS_DISABLED on every deployment, because
    // `NewEngine` never sets a destructive gate (backupd#92). That is a
    // pre-existing product gate and nothing to do with EPIC L, so this
    // case OBSERVES the run the scheduler starts instead of initiating
    // one. Every assertion below is still made in a browser against a
    // run whose hooks really executed; only the button press is
    // unavailable.
    const started = await waitForNewRun(bm.api, set!, before?.run_id ?? null, runAppearMs());
    const settled = await waitForRunToSettle(bm.api, started.run_id);

    await wf.gotoRun(settled.run_id);
    const titleBefore = await page.title();
    const sizeBefore = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    navigations.length = 0;

    await wf.stepRow(HOSTILE).click();
    const output = wf.output(HOSTILE);
    // The plain line the script also printed. Asserted FIRST, because
    // every "nothing happened" below is worthless unless the output
    // really reached the screen: a terminal that rendered none of it
    // would pass all four negatives.
    await expect(output).toContainText("e2e-hook hostile output done", { timeout: 30_000 });

    // OSC 0 set a window title. A terminal with title integration on
    // would have changed the browser tab's.
    expect(await page.title(), "the hook's OSC 0 changed the document title").toBe(titleBefore);
    expect(await page.title()).not.toContain("e2e-hostile-title");

    // OSC 8 built a hyperlink. Nothing may have become clickable, and
    // nothing may have been fetched.
    await expect(output.locator("a")).toHaveCount(0);
    expect(offsite, "the page requested the hyperlink the hook wrote").toEqual([]);
    expect(navigations, "the page navigated while rendering hook output").toEqual([]);

    // CSI 8;40;100t asked for a resize.
    expect(
      await page.evaluate(() => [window.innerWidth, window.innerHeight]),
      "the hook's window-manipulation sequence changed the viewport"
    ).toEqual(sizeBefore);

    // And the sequences are not sitting in the DOM as text that some
    // later copy path could re-animate: the escape byte itself is gone.
    expect(await output.innerText()).not.toContain("\u001b");
  });

  test("one terminal is mounted however many steps a run has", async ({
    bm,
    deployment,
    page
  }) => {
    const set = deployment.workflow.manySteps;
    needs(set !== null, needsFixture(MANY_STEPS_SET_VAR));

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    const before = await newestRun(bm.api, set!);
    // Observed rather than initiated; see the first case in this file.
    const started = await waitForNewRun(bm.api, set!, before?.run_id ?? null, runAppearMs());
    const settled = await waitForRunToSettle(bm.api, started.run_id);

    const steps = await readWorkflowSteps(bm.api, settled.run_id);
    needs(
      steps.length >= 4,
      "a run with at least four script steps: " + settled.run_id + " recorded " + steps.length +
        ", and 'only one terminal is mounted' says nothing about a run with one step"
    );

    // Which log reads happen, by step. This is how "the other steps'
    // scrollbacks are kept" is observed from a browser: coming back to a
    // step that has been read must not read it again.
    const reads: string[] = [];
    page.on("request", (req) => {
      const match = /\/workflow-runs\/[^/]+\/steps\/([^/]+)\/logs/u.exec(req.url());
      if (match !== null) reads.push(match[1]);
    });

    await wf.gotoRun(settled.run_id);
    // Nothing is mounted until a step is chosen, and the page says so
    // rather than drawing an empty panel.
    await expect(wf.everyTerminal()).toHaveCount(0);
    await expect(page.getByText("No step is selected")).toBeVisible();

    const first = MANY_BEFORE[0];
    const second = MANY_BEFORE[1];
    await wf.stepRow(first).click();
    await expect(wf.terminal(first)).toBeVisible();
    await expect(wf.everyTerminal()).toHaveCount(1);

    await wf.stepRow(second).click();
    await expect(wf.terminal(second)).toBeVisible();
    // The one that matters: switching must MOVE the viewer, not add one.
    await expect(wf.everyTerminal()).toHaveCount(1);
    await expect(wf.terminal(first)).toHaveCount(0);

    // Walk the rest, so the count is asserted across every step rather
    // than across the two that happened to be adjacent.
    for (const script of [...MANY_BEFORE.slice(2), ...MANY_AFTER]) {
      await wf.stepRow(script).click();
      await expect(wf.terminal(script)).toBeVisible();
      await expect(wf.everyTerminal()).toHaveCount(1);
    }

    const firstStep = steps.find((step) => step.script_name === first);
    needs(firstStep !== undefined, "the run to hold a step named " + first);
    const readsBefore = reads.filter((id) => id === firstStep!.step_id).length;
    expect(readsBefore, "the first step's log was never read at all").toBeGreaterThan(0);

    await wf.stepRow(first).click();
    await expect(wf.terminal(first)).toBeVisible();
    // Held, not re-read. A viewer that fetched the whole log again on
    // every switch is the one #815 replaced, and on a run with six
    // steps an operator comparing a failure against what ran before it
    // pays for that on every click.
    expect(
      reads.filter((id) => id === firstStep!.step_id).length,
      "coming back to a step re-read its log instead of using the scrollback it kept"
    ).toBe(readsBefore);
  });

  test("a slow follower does not change how long the script took", async ({
    bm,
    deployment,
    page
  }) => {
    const set = deployment.workflow.slowSet;
    needs(set !== null, needsFixture(SLOW_SET_VAR));

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    const before = await newestRun(bm.api, set!);
    // Observed rather than initiated; see the first case in this file.
    const started = await waitForNewRun(bm.api, set!, before?.run_id ?? null, runAppearMs());
    const settled = await waitForRunToSettle(bm.api, started.run_id);

    const steps = await readWorkflowSteps(bm.api, settled.run_id);
    const step = steps.find((s) => s.script_name === SLOW_SCRIPT);
    needs(step !== undefined, "the run to hold a step named " + SLOW_SCRIPT);
    needs(
      typeof step!.duration_ms === "number",
      "the engine to have recorded a duration for " + SLOW_SCRIPT + ": without one there is " +
        "nothing for the screen to disagree with"
    );

    // The follower is throttled in the BROWSER and not in the rig, which
    // is the honest place for it: the question is whether the viewer's
    // own delivery rate leaks into what it reports about the script, and
    // a rig that slowed the engine down would be measuring the engine.
    await page.route(/\/workflow-runs\/[^/]+\/steps\/[^/]+\/logs/u, async (route) => {
      await sleep(FOLLOWER_DELAY_MS);
      await route.continue();
    });

    await wf.gotoRun(settled.run_id);
    await wf.stepRow(SLOW_SCRIPT).click();
    const terminal = wf.terminal(SLOW_SCRIPT);
    await expect(terminal).toBeVisible();
    // The duration the engine recorded, rendered the way the product
    // renders it. A viewer that timed the script from its own reads
    // would report several extra seconds here, and an operator would
    // chase a hook that is not slow.
    const shown = await terminal
      .locator("dt", { hasText: /^Duration$/u })
      .locator("xpath=following-sibling::dd[1]")
      .innerText();
    const asMs = millisecondsFrom(shown);
    expect(asMs, "the terminal reported a duration of " + JSON.stringify(shown)).not.toBeNull();
    // A magnitude rather than an exact string: the product rounds for
    // display, and the defect this guards is a second of follower delay
    // showing up as script time.
    expect(Math.abs((asMs as number) - (step!.duration_ms as number))).toBeLessThan(
      FOLLOWER_DELAY_MS
    );
  });

  test("a log the engine stopped recording says so in this product's words", async ({
    bm,
    deployment,
    page
  }) => {
    const set = deployment.workflow.slowSet;
    needs(set !== null, needsFixture(SLOW_SET_VAR));
    const run = await newestRun(bm.api, set!);
    needs(run !== null, "a recorded run of " + set + " to read a log from");

    const steps = await readWorkflowSteps(bm.api, run!.run_id);
    const step = steps.find((s) => s.script_name === SLOW_SCRIPT);
    needs(step !== undefined, "the run to hold a step named " + SLOW_SCRIPT);

    const page1 = await bm.api.get(
      "/api/v1/workflow-runs/" + encodeURIComponent(run!.run_id) + "/steps/" +
        encodeURIComponent(step!.step_id) + "/logs"
    );
    const body = (await page1.json()) as { truncated?: boolean };
    needs(
      body.truncated === true,
      "a step whose log the engine really truncated. " + SLOW_SCRIPT + " printed less than the " +
        "per-step limit, so there is no truncation to render and asserting the marker anyway " +
        "would be asserting a string this suite invented"
    );

    const wf = new WorkflowScreens(page);
    await wf.gotoRun(run!.run_id);
    await wf.stepRow(SLOW_SCRIPT).click();
    // The product's own sentence, never the script's: a marker whose
    // text came from the hook is a marker a hook can forge.
    await expect(wf.terminal(SLOW_SCRIPT)).toContainText(TRUNCATION_MARKER);
  });
});
