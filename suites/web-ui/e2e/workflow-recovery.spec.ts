import { request } from "@playwright/test";

import { signIn } from "../harness/session";
import { HOLD_TITLE, WorkflowScreens } from "./workflow-page";
import { CRASH_CLEANUP, CRASH_CLEANUP_LINE, CRASH_HOLD } from "./workflow-scripts";
import { expect, needs, test } from "./fixtures";
import {
  type WireWorkflowHold,
  CRASH_SET_VAR,
  NEEDS_WORKFLOW_CONTROL,
  acknowledgeHolds,
  crashIntoHook,
  needsFixture,
  readWorkflowRecovery,
  readWorkflowRun,
  resolveWorkflowControl,
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

// ONE crash cycle, and the budget is mostly waiting rather than
// asserting: nothing here can start a run, so the case waits for the
// scheduler to bring the slowest set in the deployment round, then for
// the rig to stop and restart the engine and prove it healthy, then for
// reconciliation. See harness/workflow.ts's runAppearMs and
// catchRunInFlight for the arithmetic.
test.describe.configure({ timeout: 1_200_000 });

test.describe("a workflow run that was interrupted", () => {
  test.beforeEach(async ({ bm }) => {
    needs(
      bm.facts.workflow.served,
      "a build that serves /api/v1/workflow-recovery: there is no recovery axis without it"
    );
  });

  // ONE crash, both settlements.
  //
  // This was two cases, and two cases could not finish. Nothing here
  // can start a run - the destructive gate refuses the product's own
  // Run control (backupd#92) - so each case waits for the scheduler,
  // and the crash fixture is the slowest set in the deployment: its
  // hook holds for the better part of a minute before its backup even
  // starts, and the poll interval has a one-minute floor the product
  // enforces. A second case therefore waits out a second full cycle,
  // and it was doing so while carrying the risk that the first left a
  // hold behind - a held set is never scheduled again, so one starved
  // case starves the next.
  //
  // The trade is stated rather than hidden: one crash means the two
  // settlements are no longer independent, and the ACKNOWLEDGE path is
  // exercised for its refusals plus whatever hold the resume leaves.
  // Two cases that cannot finish prove less than one that does.
  test("a crashed run is held, and both ways out of the hold work", async ({
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
    // deployment (backupd#92), so this waits for the scheduler, catches
    // the run while its hold script is executing, and asks the rig to
    // take the engine away underneath it.
    //
    // crashIntoHook retries: a crash that lands after the hook finished
    // leaves nothing to reconcile, which is a timing miss rather than a
    // product answer, and the honest response is the next scheduled run
    // rather than an assertion about a run that completed. It returns
    // only when reconciliation really raised a hold, and fails naming
    // every attempt when none did.
    //
    // One run raises more than one hold - the engine records the global
    // scope and the set scope separately - so what is required is a
    // hold belonging to THIS set, about the run that was interrupted.
    const crashed = await crashIntoHook(bm.api, control!, set!);
    const started = crashed.run;
    expect(crashed.step.script_name).toBe(CRASH_HOLD);
    expect(crashed.hold.run_id).toBe(started.run_id);
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

    // The acknowledgement's REFUSALS, taken while the banner is up and
    // before anything is settled: the dialog only exists on the banner,
    // so once the hold is gone this is unreachable. The service
    // requires a reason and so does the product - there is no "clear
    // this" and no "ignore this", because the alternative to both is a
    // source machine left in a state nothing can see.
    await wf.acknowledgeControl().click();
    const submit = wf.recordAcknowledgement();
    await expect(submit).toBeDisabled();
    await wf.acknowledgeReason().fill("   ");
    await expect(submit, "whitespace was accepted as a reason").toBeDisabled();
    await wf.acknowledgeControl().click();
    await expect(submit).toHaveCount(0);

    // Then the way out that actually unwinds the hook, from that run's
    // own retained spool.
    await wf.resumeControl().click();

    // One crash raises a hold per scope - the engine records the global
    // one and the set one separately - and a resume settles the run's
    // obligation rather than the list. So whatever is left after it is
    // settled through the OTHER way out, which is how this case keeps
    // both settlements against one crash. When the resume cleared
    // everything there is nothing left to acknowledge, and that is said
    // out loud rather than passed over.
    const left = await waitForNoHold(bm.api, set!, 60_000).then(
      () => [] as WireWorkflowHold[],
      async () => (await readWorkflowRecovery(bm.api))?.filter((h) => h.backup_set_id === set!) ?? []
    );
    if (left.length > 0) {
      await expect(banner).toBeVisible();
      await wf.acknowledgeControl().click();
      await wf.acknowledgeReason().fill(
        "e2e: the resume unwound this run's hooks and this scope is being accounted for by hand"
      );
      await expect(wf.recordAcknowledgement()).toBeEnabled();
      await wf.recordAcknowledgement().click();
      await waitForNoHold(bm.api, set!);
    } else {
      console.log(
        "e2e: the resume settled every hold this crash raised, so the acknowledgement's submit " +
          "path had nothing left to clear and only its refusals were exercised"
      );
    }
    await expect(banner).toBeHidden({ timeout: 120_000 });

    // And the control comes back, which is the whole point of settling
    // it: a set that stayed blocked after a successful settlement would
    // have to be unblocked from a terminal. Gated on the set being idle
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

  // Settle whatever this file's crash left behind, however a case ended.
  //
  // Not tidiness: a set carrying an unresolved hold is a set the ENGINE
  // refuses to run again, so a case that failed before settling its own
  // hold does not fail alone - it starves every later case waiting for
  // the scheduler to come round to that set, and each of those reports
  // "the scheduler did not run this set", which says nothing about what
  // broke. Acknowledged rather than resumed, because resuming EXECUTES
  // owed hooks and that is a thing under test rather than a thing to do
  // behind a case's back.
  test.afterEach(async ({ bm, deployment }) => {
    const set = deployment.workflow.crashSet;
    if (set === null) return;
    const settled = await acknowledgeHolds(
      bm.api,
      set,
      "e2e: settled by the suite so the scheduler will run this set again; the case that caused " +
        "this hold ended without clearing it"
    );
    if (settled > 0) {
      console.log(
        "e2e: acknowledged " + settled + " leftover recovery hold(s) on " + set +
          " so later cases are not starved of a scheduled run"
      );
    }
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
