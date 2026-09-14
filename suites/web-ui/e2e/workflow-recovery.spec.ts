import { request } from "@playwright/test";

import { signIn } from "../harness/session";
import { HOLD_TITLE, WorkflowScreens } from "./workflow-page";
import { CRASH_CLEANUP, CRASH_CLEANUP_LINE, CRASH_HOLD } from "./workflow-scripts";
import { expect, needs, test } from "./fixtures";
import {
  CRASH_SET_VAR,
  NEEDS_WORKFLOW_CONTROL,
  catchRunInFlight,
  crashEngine,
  needsFixture,
  readWorkflowRecovery,
  readWorkflowRun,
  resolveWorkflowControl,
  runAppearMs,
  waitForHold,
  waitForNoHold,
  waitForSetIdle
} from "../harness/workflow";

/**
 * A run this product could not finish, and the two ways out of it
 * (backupd#816 against #814's recovery axis).
 *
 * # Why the engine is really crashed
 *
 * Because `recovery_required` is not a state anything can be asked to
 * enter. It is what reconciliation FINDS: a run whose row says it was
 * executing hooks and whose process is gone. Every cheaper way of
 * producing it - writing the row, stubbing the read, driving the banner
 * over a fixture - asserts the banner and not the state, and the defect
 * that matters here is a deployment that comes back up and quietly
 * forgets that a source machine was left quiesced.
 *
 * So the rig stops the engine container while a hook is genuinely
 * executing, starts it again, and waits until serve-ui has proxied a
 * healthcheck through to it. What this file then asserts is what an
 * operator meets afterwards: a backup set that will not run, a banner
 * that says why, and two settlements that really settle it.
 *
 * # Why the hold list rather than the run's own state
 *
 * A run row carries `recovery_state`, which describes that run.
 * `GET /workflow-recovery` is the engine's own hold set, and it is what
 * the next run is actually refused against. A screen gating on the
 * former would be predicting a refusal rather than reporting one - and
 * would keep predicting it after somebody resumed the cleanup from a
 * terminal. The specs follow the product here on purpose.
 *
 * # Each case settles what it caused
 *
 * One deployment is shared by the whole run. A hold left standing does
 * not fail this file: it fails every later case that presses Run on that
 * set, with an error about a disabled button and no mention of why.
 */

// Two crash cycles, each waiting for the scheduler to come round to the
// crash set before there is a live hook to crash into. See
// harness/workflow.ts's runAppearMs for why nothing here presses Run.
test.describe.configure({ timeout: 900_000 });

test.describe("a workflow run that was interrupted", () => {
  test.beforeEach(async ({ bm }) => {
    needs(
      bm.facts.workflow.served,
      "a build that serves /api/v1/workflow-recovery: there is no recovery axis without it"
    );
  });

  test("resuming the cleanup runs the hooks the interrupted run still owed", async ({
    bm,
    deployment,
    page
  }) => {
    const control = resolveWorkflowControl();
    needs(control !== null, NEEDS_WORKFLOW_CONTROL);
    const set = deployment.workflow.crashSet;
    needs(set !== null, needsFixture(CRASH_SET_VAR));

    // Crash INTO a live hook. Nothing here starts the run: the
    // destructive gate refuses the product's own Run control on every
    // deployment (backupd#92), so this waits for the scheduler and
    // catches the run while its hold script is executing. A run
    // observed a moment after it finished is an ordinary outcome at a
    // one-minute cadence, and catchRunInFlight waits for the next one
    // rather than crashing an idle engine and finding nothing to
    // reconcile.
    const caught = await catchRunInFlight(bm.api, set!);
    const started = caught.run;
    expect(caught.step.script_name).toBe(CRASH_HOLD);
    await crashEngine(control!);

    // What reconciliation found, read from the hold set the Run control
    // is gated on. One run can raise more than one hold - the engine
    // records the global scope and the set scope separately - so this
    // asks for a hold belonging to this set and checks it is about the
    // run that was interrupted, rather than assuming there is exactly
    // one.
    const hold = await waitForHold(bm.api, set!, runAppearMs());
    expect(hold.run_id).toBe(started.run_id);
    const reconciled = await readWorkflowRun(bm.api, started.run_id);
    expect(reconciled?.state).toBe("recovery_required");

    const wf = new WorkflowScreens(page);

    // The operator's view: the set will not run, and the only thing on
    // screen explaining why is the banner.
    await wf.gotoSet(set!);
    const banner = wf.recoveryBanner();
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(started.run_id);
    await expect(banner).toContainText("may still be quiesced, mounted or paused");
    // Disabled AND disabled FOR THIS REASON. A bare disabled assertion
    // is not enough on a scheduled deployment: the same control is
    // unavailable while a run of the set is busy, so "it was disabled"
    // can be true for a reason that has nothing to do with the hold.
    // The hold was confirmed through the recovery API above and the
    // banner explaining it is on screen, and the control's own hover
    // title names the hold when the deployment draws hover titles at
    // all (they are a user setting, so its absence is not a failure -
    // its presence saying something ELSE is).
    const run = wf.runControl();
    await expect(run).toBeDisabled();
    const why = await run.getAttribute("title");
    if (why !== null) {
      expect(why, "the Run control is disabled for a reason other than the hold").toContain(
        "held for recovery"
      );
    }

    // The way out that actually unwinds the hook, from that run's own
    // retained spool.
    await wf.resumeControl().click();
    await expect(banner).toBeHidden({ timeout: 120_000 });
    await waitForNoHold(bm.api, set!);
    // And the control comes back, which is the whole point of settling
    // it: a set that stayed blocked after a successful resume would have
    // to be unblocked from a terminal. Gated on the set being idle
    // first, because the same control is legitimately disabled while a
    // scheduled run of this set is in flight, and at a one-minute
    // cadence that is a large fraction of the time.
    await waitForSetIdle(bm.api, set!);
    await page.reload();
    await expect(wf.runControl()).toBeEnabled();

    // The cleanup really executed: the "after" hook this run was owed
    // ran, and its output is in the journal.
    await wf.gotoRun(started.run_id);
    const cleanup = wf.stepRow(CRASH_CLEANUP);
    await expect(cleanup).toHaveCount(1);
    await cleanup.click();
    await expect(wf.output(CRASH_CLEANUP)).toContainText(CRASH_CLEANUP_LINE, { timeout: 60_000 });
  });

  test("acknowledging is a reason in words, and nothing less unblocks the set", async ({
    bm,
    deployment,
    page
  }) => {
    const control = resolveWorkflowControl();
    needs(control !== null, NEEDS_WORKFLOW_CONTROL);
    const set = deployment.workflow.crashSet;
    needs(set !== null, needsFixture(CRASH_SET_VAR));

    // Same sequencing as the case above: caught mid-hook rather than
    // initiated, because nothing here can start a run.
    const caught = await catchRunInFlight(bm.api, set!);
    await crashEngine(control!);
    await waitForHold(bm.api, set!, runAppearMs());

    const wf = new WorkflowScreens(page);
    expect(caught.step.script_name).toBe(CRASH_HOLD);

    await wf.gotoSet(set!);
    const banner = wf.recoveryBanner();
    await expect(banner).toBeVisible();
    // Disabled for the hold, not merely disabled; see the case above.
    const run = wf.runControl();
    await expect(run).toBeDisabled();
    const why = await run.getAttribute("title");
    if (why !== null) {
      expect(why, "the Run control is disabled for a reason other than the hold").toContain(
        "held for recovery"
      );
    }

    await wf.acknowledgeControl().click();
    const submit = wf.recordAcknowledgement();
    // The service requires a reason and so does the product: there is no
    // "clear this" and no "ignore this", because the alternative to both
    // is a source machine left in a state nothing can see.
    await expect(submit).toBeDisabled();
    await wf.acknowledgeReason().fill("   ");
    await expect(submit, "whitespace was accepted as a reason").toBeDisabled();

    await wf.acknowledgeReason().fill(
      "e2e: thawed the fixture by hand and confirmed the source is not quiesced"
    );
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(banner).toBeHidden({ timeout: 120_000 });
    await waitForNoHold(bm.api, set!);
    // Idle first: this control is legitimately disabled while a
    // scheduled run of the set is in flight, which at a one-minute
    // cadence it often is.
    await waitForSetIdle(bm.api, set!);
    await page.reload();
    await expect(wf.runControl()).toBeEnabled();
  });

  test.afterAll(async ({ deployment }) => {
    // The one path a `finally` cannot cover: a case that exceeds its own
    // timeout is abandoned mid-await and never reaches its settlement.
    // A set left held does not fail this file - it fails every later one
    // that presses Run, with an error about a disabled button and no
    // mention of a hold. So the state is REPORTED here rather than
    // silently cleared: clearing it would hide the fact that a case
    // above did not finish, and this suite's whole argument is that a
    // check nobody notices stopping is worse than no check.
    const jar = (await signIn(deployment)).map((c) => c.name + "=" + c.value).join("; ");
    const api = await request.newContext({
      baseURL: deployment.baseURL,
      extraHTTPHeaders: { cookie: jar }
    });
    try {
      const holds = await readWorkflowRecovery(api);
      if (holds !== null && holds.length > 0) {
        console.log(
          "e2e: the deployment is still holding " + holds.length + " workflow run(s) for " +
            "recovery: " + holds.map((hold) => hold.backup_set_id).join(", ") + ". Every later " +
            "case that runs one of those sets will find its Run control unavailable."
        );
      }
    } finally {
      await api.dispose();
    }
  });
});

test.describe("the recovery banner on the run it is about", () => {
  test("names the run, its spool and both ways out", async ({ bm, page }) => {
    const holds = await readWorkflowRecovery(bm.api);
    needs(
      holds !== null && holds.length > 0,
      "a deployment currently holding a workflow run. The crash cases above settle what they " +
        "cause, so this one asserts only when something is genuinely held: it is the case that " +
        "would catch a hold the product cannot describe"
    );

    const hold = holds![0];
    const wf = new WorkflowScreens(page);
    await wf.gotoRun(hold.run_id);
    const banner = wf.recoveryBanner();
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(HOLD_TITLE);
    // The resume is offered first and as the primary action, because it
    // is the one that unwinds the hook; an acknowledgement unblocks the
    // set and changes nothing on the machine.
    await expect(wf.resumeControl()).toBeVisible();
    await expect(wf.acknowledgeControl()).toBeVisible();
    if (hold.spool_ref !== undefined && hold.spool_ref !== "") {
      await expect(banner).toContainText(hold.spool_ref);
    }
  });
});
