import { HOST_RUNNER, WorkflowScreens } from "./workflow-page";
import {
  AFTER_FAIL,
  BEFORE_FAIL,
  GLOBAL_BEFORE,
  GLOBAL_BEFORE_DIR_VAR,
  GLOBAL_BEFORE_LINE,
  HAPPY_AFTER,
  HAPPY_AFTER_LINE,
  HAPPY_BEFORE,
  HAPPY_BEFORE_LINE,
  REMOTE_BEFORE,
  REMOTE_BEFORE_LINE
} from "./workflow-scripts";
import { expect, needs, test } from "./fixtures";
import {
  AFTER_FAIL_SET_VAR,
  BEFORE_FAIL_SET_VAR,
  BYPASSED_RUN_VAR,
  CANCELED_RUN_VAR,
  EXEC_SET_VAR,
  UNCONFIRMED_RUN_VAR,
  WORKFLOW_SET_VAR,
  needsFixture,
  runAppearMs,
  newestRun,
  waitForNewRun,
  waitForRunToSettle,
  withGlobalBeforeDir
} from "../harness/workflow";

/**
 * Hooks that really execute, watched from a browser (backupd#816).
 *
 * # What each case here costs, and why it is worth it
 *
 * Every case in this file presses the product's own Run control and waits
 * for a real backup: three files over SFTP from one container to another,
 * with real scripts executed either on the manager through the Host
 * Workflow Runner or on the source machine over an SSH exec channel. That
 * is seconds rather than milliseconds, and it is the only way any of
 * these sentences can be asserted at all.
 *
 * The alternative - rendering the run page over a fixture - is what
 * ui/shared's own tests already do, and it cannot fail on a runner socket
 * that is not mounted, an exec account that cannot run a command, a hook
 * whose exit code the engine loses, or a status split that is right in
 * the component and wrong in the journal behind it. Those are the
 * failures L9 exists to catch.
 *
 * # The one thing every case does before it presses anything
 *
 * It reads the newest run this set already has, so that "the run that
 * just started" is a run this case caused rather than one it inherited. A
 * set with history would otherwise hand back yesterday's run instantly
 * and every assertion below would be about the wrong thing.
 *
 * # Why the verdicts are read from the named groups
 *
 * `WorkflowStatusSplit` draws three verdicts and the whole point of the
 * component is that they are SEPARATE: "the backup succeeded and the
 * cleanup did not" is the most operationally important sentence in EPIC
 * L. A case that asserted `toContainText("Success")` on the page would
 * pass with all three folded into one, which is precisely the defect.
 */

// A run is a real backup plus real hooks, and this suite cannot start
// one: the destructive gate refuses the product's own Run control
// (backupd#92), so each case waits for the scheduler's next pass at the
// shortest legal interval the product allows. The suite-wide 90s is for
// pages; this file waits on a deployment to come round to a set.
test.describe.configure({ timeout: 480_000 });

test.describe("a workflow run, driven from the browser", () => {
  test.beforeEach(async ({ bm }) => {
    needs(
      bm.facts.workflow.served,
      "a build that serves /api/v1/workflow-runs: this file is about EPIC L and a build " +
        "predating it records no workflow runs"
    );
  });

  test("a local hook really runs, and the run page says where", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.happySet;
    needs(set !== null, needsFixture(WORKFLOW_SET_VAR));

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    const before = await newestRun(bm.api, set!);
    await expect(wf.runControl()).toBeEnabled();
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
    expect(settled.state, "the happy fixture's run ended in " + settled.state).toBe("success");

    await wf.gotoRun(settled.run_id);
    await expect(page.getByRole("heading", { level: 1, name: /Workflow run/ })).toBeVisible();
    await expect(wf.verdict("Backup")).toContainText("Success");
    await expect(wf.verdict("Workflow")).toContainText("Success");
    await expect(wf.verdict("Cleanup")).toContainText("Success");

    // Both hooks, each attributed to the executor that really ran it.
    // "Local Host · Host Workflow Runner" is a claim about a Unix socket
    // on the manager, and it is the claim this whole rig exists to make
    // checkable.
    for (const script of [HAPPY_BEFORE, HAPPY_AFTER]) {
      const row = wf.stepRow(script);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(HOST_RUNNER);
      await expect(row).toContainText("exit 0");
    }

    // And what the script printed, read out of the durable log through
    // the product's own terminal.
    await wf.stepRow(HAPPY_BEFORE).click();
    await expect(wf.output(HAPPY_BEFORE)).toContainText(HAPPY_BEFORE_LINE, { timeout: 30_000 });
    await wf.stepRow(HAPPY_AFTER).click();
    await expect(wf.output(HAPPY_AFTER)).toContainText(HAPPY_AFTER_LINE, { timeout: 30_000 });
  });

  test("a remote hook really runs on the source machine", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.execSet;
    needs(set !== null, needsFixture(EXEC_SET_VAR));
    // backupd#915: a remote hook that PASSES the exec-capability probe
    // still dies at run time with `transport_lost` about seventy
    // milliseconds in, so the run this case is written against does not
    // reach a success this deployment could show. Blocked rather than
    // weakened: an assertion rewritten to accept the failure would go on
    // passing after the bug is fixed and would stop being about a hook
    // that ran. The capability half is NOT blocked and is asserted in
    // workflow-config.spec.ts, which is what keeps the remote posture
    // covered meanwhile.
    needs(
      false,
      "backupd#915 to be fixed: a remote hook fails at run time with transport_lost although " +
        "exec_capability validates, so no deployment can currently show a remote hook that ran"
    );

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    const before = await newestRun(bm.api, set!);
    await expect(wf.runControl()).toBeEnabled();
    // Observed rather than initiated; see the first case in this file.

    const started = await waitForNewRun(bm.api, set!, before?.run_id ?? null, runAppearMs());
    const settled = await waitForRunToSettle(bm.api, started.run_id);
    expect(settled.state, "the remote-exec fixture's run ended in " + settled.state).toBe("success");

    await wf.gotoRun(settled.run_id);
    const row = wf.stepRow(REMOTE_BEFORE);
    await expect(row).toContainText("Remote");
    // The negative matters as much as the positive: a remote hook
    // attributed to the host runner would be telling an operator their
    // script ran on the manager.
    await expect(row).not.toContainText(HOST_RUNNER);

    await row.click();
    // The line the script printed on the far side. Nothing on the
    // manager could have produced it: the hook is only ever sent over
    // the exec channel.
    await expect(wf.output(REMOTE_BEFORE)).toContainText(REMOTE_BEFORE_LINE, { timeout: 30_000 });
  });

  test("a failing before hook skips the backup instead of running it", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.beforeFailSet;
    needs(set !== null, needsFixture(BEFORE_FAIL_SET_VAR));

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    const before = await newestRun(bm.api, set!);
    // Observed rather than initiated; see the first case in this file.

    const started = await waitForNewRun(bm.api, set!, before?.run_id ?? null, runAppearMs());
    const settled = await waitForRunToSettle(bm.api, started.run_id);

    await wf.gotoRun(settled.run_id);
    // The whole reason a "before" hook exists: it is allowed to stop the
    // backup. A product that transferred anyway would be backing up a
    // database nobody quiesced.
    await expect(wf.verdict("Backup")).toContainText("Skipped");
    await expect(wf.verdict("Workflow")).toContainText("Failed");
    // The cause is named beside the verdict, because "Failed" on its own
    // sends an operator to the step list to do a search the page can do
    // for them.
    await expect(wf.verdict("Workflow")).toContainText(BEFORE_FAIL);
    await expect(wf.stepRow(BEFORE_FAIL)).toContainText("exit 7");
  });

  test("a failing after hook leaves a good backup and a failed workflow, said separately", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.afterFailSet;
    needs(set !== null, needsFixture(AFTER_FAIL_SET_VAR));

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    const before = await newestRun(bm.api, set!);
    // Observed rather than initiated; see the first case in this file.

    const started = await waitForNewRun(bm.api, set!, before?.run_id ?? null, runAppearMs());
    const settled = await waitForRunToSettle(bm.api, started.run_id);

    await wf.gotoRun(settled.run_id);
    // The split, asserted as a split. Each verdict is read out of its
    // own named group, so a build that folded the three into one badge
    // fails here however that badge is worded.
    await expect(wf.verdict("Backup")).toContainText("Success");
    await expect(wf.verdict("Workflow")).toContainText("Failed");
    await expect(wf.verdict("Workflow")).toContainText(AFTER_FAIL);
    // And they are really different cells, not one string that happens
    // to contain both words.
    await expect(wf.verdict("Backup")).not.toContainText("Failed");
  });

  test("a deployment-wide before stage runs for a set that configures none", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.happySet;
    needs(set !== null, needsFixture(WORKFLOW_SET_VAR));
    const dir = (process.env[GLOBAL_BEFORE_DIR_VAR] ?? "").trim();
    needs(
      dir !== "",
      "the rig to seed a global stage directory and name it in " + GLOBAL_BEFORE_DIR_VAR +
        ": it is attached to no set until this case attaches it, so that the deployment's " +
        "ordinary state still has a set with no hooks at all"
    );

    // Borrowed and handed straight back. A global stage runs for EVERY
    // set, so leaving it configured would change what every later spec
    // is looking at - including the one that asserts a set with no hooks
    // says so.
    await withGlobalBeforeDir(bm.api, dir, async () => {
      const wf = new WorkflowScreens(page);
      await wf.gotoSet(set!);
      const before = await newestRun(bm.api, set!);
    // Observed rather than initiated; see the first case in this file.

      const started = await waitForNewRun(bm.api, set!, before?.run_id ?? null, runAppearMs());
      const settled = await waitForRunToSettle(bm.api, started.run_id);

      await wf.gotoRun(settled.run_id);
      // Five stages, in the order a run executes them, and this one is
      // the stage that belongs to the deployment rather than to the set.
      await expect(wf.stagesCard()).toContainText("Global before");
      const row = wf.stepRow(GLOBAL_BEFORE);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(HOST_RUNNER);
      await row.click();
      await expect(wf.output(GLOBAL_BEFORE)).toContainText(GLOBAL_BEFORE_LINE, { timeout: 30_000 });
    });
  });

  test("a finished run is reachable again from the backup set that owns it", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.happySet;
    needs(set !== null, needsFixture(WORKFLOW_SET_VAR));
    const run = await newestRun(bm.api, set!);
    needs(
      run !== null,
      "at least one recorded workflow run for " + set + ": the history list is empty until " +
        "something has run, and the cases above are what put one there"
    );

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    const entry = wf.historyEntry(run!.run_id);
    await expect(entry).toHaveCount(1);
    // All three verdicts on the row, because the pair a history list is
    // scanned for is a green backup beside a failed workflow.
    await expect(entry).toContainText("backup ");
    await expect(entry).toContainText("workflow ");
    await expect(entry).toContainText("cleanup ");

    await entry.click();
    await expect(page).toHaveURL(new RegExp("/workflow-runs/" + run!.run_id + "$"));
    await expect(wf.verdict("Backup")).toBeVisible();
  });

  test("a run whose hooks were bypassed says so rather than reporting them skipped", async ({ bm, deployment, page }) => {
    const runId = deployment.workflow.bypassedRun;
    needs(
      runId !== null,
      "a run recorded with its hooks bypassed, named in " + BYPASSED_RUN_VAR + ". Nothing in " +
        "the shipped bundle can cause one - there is no bypass control - so the rig has to " +
        "produce it and this case asserts only what the product renders for it"
    );

    const wf = new WorkflowScreens(page);
    await wf.gotoRun(runId!);
    // Beside the state and not as a footnote: a "Skipped" workflow
    // verdict with no explanation reads as an engine that chose not to
    // run hooks rather than an operator who asked for that.
    await expect(page.getByText("Scripts bypassed")).toBeVisible();
    await expect(wf.verdict("Workflow")).toContainText("Hooks were bypassed for this run");
  });

  test("a canceled run still accounts for the cleanup it owed", async ({ bm, deployment, page }) => {
    const runId = deployment.workflow.canceledRun;
    needs(
      runId !== null,
      "a canceled run, named in " + CANCELED_RUN_VAR + ". There is no cancel control in the " +
        "shipped bundle, so a browser cannot cause this state"
    );

    const wf = new WorkflowScreens(page);
    await wf.gotoRun(runId!);
    await expect(wf.verdict("Cleanup")).toBeVisible();
    // The sentence that matters about a canceled run is what happened to
    // the hooks it still owed, not that it was canceled.
    await expect(wf.verdict("Cleanup")).not.toContainText("Not reported");
  });

  test("a step whose process could not be confirmed gone says so at page level", async ({ bm, deployment, page }) => {
    const runId = deployment.workflow.unconfirmedRun;
    needs(
      runId !== null,
      "a run holding a step with termination_confirmed=false, named in " + UNCONFIRMED_RUN_VAR
    );

    const wf = new WorkflowScreens(page);
    await wf.gotoRun(runId!);
    // A banner and not a table cell, because this is a fact about a
    // MACHINE rather than about a row: the script may still be running
    // on the host it was sent to, and nothing in this product can end
    // it.
    const banner = page.getByRole("alert").filter({ hasText: "Termination unconfirmed" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("may still be running");
  });
});
