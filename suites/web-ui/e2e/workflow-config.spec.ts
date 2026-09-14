import {
  HOST_RUNNER,
  INHERITING_ONLY,
  NO_HOOKS_SENTENCE,
  WorkflowScreens
} from "./workflow-page";
import {
  FINDINGS_INFO_CODE,
  FINDINGS_SCRIPT,
  FINDINGS_WARNING_CODE,
  HAPPY_BEFORE,
  REJECTED_ERROR_CODE,
  REMOTE_BEFORE,
  SECRET_ENV_NAME,
  SFTP_ONLY_SCRIPT
} from "./workflow-scripts";
import { expect, needs, test } from "./fixtures";
import {
  EXEC_SET_VAR,
  FINDINGS_SET_VAR,
  NEEDS_WORKFLOW_CONTROL,
  NO_HOOKS_SET_VAR,
  REJECTED_SET_VAR,
  SECRET_SET_VAR,
  SECRET_VALUE_VAR,
  SFTP_ONLY_SET_VAR,
  WORKFLOW_SET_VAR,
  needsFixture,
  readBackupSetWorkflow,
  resolveWorkflowControl,
  withRunnerStopped
} from "../harness/workflow";

/**
 * What a backup set says about its hooks BEFORE anything runs
 * (backupd#816, the configuration half of EPIC L in a browser).
 *
 * # Why these cases are not unit tests of the same component
 *
 * Because every sentence on this card is a claim about a filesystem and
 * an sshd that the browser cannot see. "This script runs on the Host
 * Workflow Runner" is a claim about a Unix socket on the manager;
 * "this connection cannot run a command" is a claim about what a real
 * sshd did when a real exec channel was opened on it. ui/shared's own
 * tests render the card over a fixture, which proves the card draws what
 * it is handed and cannot prove that what it is handed is true.
 *
 * The card only reaches the state these cases read by asking the engine
 * for a validation report, which opens a connection to the source host
 * AND to the Host Workflow Runner. So a red here is one of two real
 * things: the product drew the wrong answer, or the deployment could not
 * produce one.
 *
 * # The SFTP-only case is the sharpest one in the file
 *
 * A source account confined to `internal-sftp` authenticates perfectly,
 * transfers bytes perfectly, and cannot run a hook. That is the
 * RECOMMENDED posture for a backup source, so it is not a fault, and a
 * product that reported it as a connection failure would send an operator
 * to fix a thing that is not broken. The rig provides it as a genuinely
 * confined account on a real sshd - not as a refusal simulated in the
 * app - and this file asserts the product tells the two apart.
 */

test.describe("a backup set's workflow configuration, in a browser", () => {
  test.beforeEach(async ({ bm }) => {
    needs(
      bm.facts.workflow.served,
      "a build that serves /api/v1/settings/workflow: every case here is about EPIC L, and a " +
        "build predating it has no workflow surface to assert on"
    );
  });

  test("a set with no hooks says so in one sentence and draws nothing else", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.noHooksSet;
    needs(set !== null, needsFixture(NO_HOOKS_SET_VAR));

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    const card = wf.card();
    await expect(card).toBeVisible();

    // Which empty state is the honest one depends on the DEPLOYMENT, not
    // on this set: a global stage runs for every set, so a deployment
    // that configures one has no set that runs nothing. Both are real
    // states and the product words them differently, so the fact decides
    // which sentence is asserted rather than the spec hoping for one.
    const globals =
      bm.facts.workflow.globalBeforeDir !== "" || bm.facts.workflow.globalAfterDir !== "";
    if (globals) {
      await expect(card).toContainText(INHERITING_ONLY);
    } else {
      await expect(card).toContainText(NO_HOOKS_SENTENCE);
      // The whole point of the quiet path: no table, no findings, no
      // history. New noise on every existing set is the failure mode
      // this wave was one edit away from.
      await expect(card.getByRole("table")).toHaveCount(0);
      await expect(card).not.toContainText("Recent workflow runs");
    }
  });

  test("a configured set names the directories its hooks come from", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.happySet;
    needs(set !== null, needsFixture(WORKFLOW_SET_VAR));

    // The anchor comes from the service, not from the page: a card that
    // rendered a plausible directory would pass a case that only looked
    // at the card.
    const configured = await readBackupSetWorkflow(bm.api, set!);
    needs(
      configured !== null && configured.configured,
      "the rig to configure hook directories on " + set + ": the service reports it as " +
        "unconfigured, so there is nothing for the card to name"
    );

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    const card = wf.card();
    await expect(card).toContainText(configured!.before_dir ?? "");
    await expect(card).toContainText(configured!.after_dir ?? "");
    await expect(card).toContainText("Script timeout");
  });

  test("checking a set's hooks lists every script and where each one runs", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.happySet;
    needs(set !== null, needsFixture(WORKFLOW_SET_VAR));

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    await wf.checkControl().click();

    // The table only exists once the engine has answered, and answering
    // means it reached the Host Workflow Runner. There is no fixture
    // path to this table.
    const table = wf.scriptTable();
    await expect(table).toBeVisible({ timeout: 30_000 });
    const row = wf.scriptRow(HAPPY_BEFORE);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Local Host");
    // The column this whole L7 surface exists for: a hook that runs on
    // the manager and one that runs on the source machine are different
    // things to an operator deciding what a script may touch.
    await expect(row).toContainText(HOST_RUNNER);

    // Two verdicts, kept apart. A set whose hooks are sound says so
    // without claiming anything about the backup set itself.
    await expect(wf.card()).toContainText("Hooks valid");
  });

  test("a remote hook names the connection it runs over, and not the host runner", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.execSet;
    needs(set !== null, needsFixture(EXEC_SET_VAR));

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    await wf.checkControl().click();
    await expect(wf.scriptTable()).toBeVisible({ timeout: 30_000 });

    const row = wf.scriptRow(REMOTE_BEFORE);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Remote");
    // The negative is the assertion. A remote script whose "Runs on"
    // said Host Workflow Runner would be telling an operator their hook
    // executes on the manager, which is the opposite of true and the
    // exact mistake that makes somebody quiesce the wrong machine.
    await expect(row).not.toContainText(HOST_RUNNER);
  });

  test("an SFTP-only source is refused a remote hook, in words, and is not called broken", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.sftpOnlySet;
    needs(set !== null, needsFixture(SFTP_ONLY_SET_VAR));

    // Half of this case is that the SAME source transfers bytes
    // perfectly. Read from the catalogue rather than asserted by running
    // one: the engine's own preflight refuses a run of a set whose hooks
    // cannot execute, so the artifacts the rig ingested before it
    // attached the hook are what prove the transfer path works.
    const [source, name] = set!.split("/");
    const ingested = bm.facts.backups.filter(
      (artifact) => artifact.source_name === source && artifact.set_name === name
    );
    needs(
      ingested.length > 0,
      "the topology to have ingested at least one backup from " + set + " before attaching its " +
        "remote hook: without it, 'SFTP works and exec does not' is only half asserted"
    );

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    await wf.checkControl().click();
    const card = wf.card();

    // The engine's own check id, which is a closed vocabulary and not a
    // sentence: `exec_capability` is the one that means "this account
    // authenticates and cannot run a command".
    const finding = card.getByText("exec_capability", { exact: true });
    await expect(finding).toBeVisible({ timeout: 60_000 });
    // Scoped to the finding's own row rather than swept over the card:
    // "error" appears in plenty of prose, and a case that matched it
    // anywhere would pass against an exec_capability finding reported
    // as a warning - which is the difference between "your hooks will
    // not run" and "you might want to look at this".
    await expect(finding.locator("..")).toContainText("error");
    await expect(card).toContainText("Hooks not valid");

    // And the half that keeps this from reading as a fault: the set
    // itself is fine, and the product says a confined source is a
    // supported setup with a named way out of it.
    await expect(card).toContainText("Valid for backup");
    await expect(card).toContainText("An SFTP-only source can move bytes and cannot run a hook");
    await expect(wf.scriptRow(SFTP_ONLY_SCRIPT)).toHaveCount(1);
  });

  test("with the Host Workflow Runner stopped, the check says the runner is why", async ({ bm, deployment, page }) => {
    const control = resolveWorkflowControl();
    needs(control !== null, NEEDS_WORKFLOW_CONTROL);
    const set = deployment.workflow.happySet;
    needs(set !== null, needsFixture(WORKFLOW_SET_VAR));

    await withRunnerStopped(control!, async () => {
      const wf = new WorkflowScreens(page);
      await wf.gotoSet(set!);
      await wf.checkControl().click();
      const card = wf.card();

      // `runner_health` is the engine's own id for "the Host Workflow
      // Runner did not answer". A deployment whose runner is gone and
      // whose card still said "Hooks valid" would be promising an
      // operator that a local hook will run tonight.
      await expect(card.getByText("runner_health", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(card).toContainText("Hooks not valid");
    });
  });

  test("a secret-backed variable shows where it comes from and never what it is", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.secretSet;
    needs(set !== null, needsFixture(SECRET_SET_VAR));
    const secret = deployment.workflow.secretValue;
    needs(
      secret !== null,
      "the rig to hand over the plaintext in " + SECRET_VALUE_VAR + ": without it this case can " +
        "only check that a row exists, which is not the assertion"
    );

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    const preview = wf.environmentPreview();
    await expect(preview).toBeVisible();
    const row = preview.getByRole("row").filter({ hasText: SECRET_ENV_NAME });
    await expect(row).toHaveCount(1);
    // A secret is a LOCATION and never a value: the contract has no
    // field a resolved secret could arrive in, and the cell says so out
    // loud rather than leaving a blank that reads as "not set".
    await expect(row).toContainText("never shown");

    // The invariant, swept over the whole document rather than over the
    // cell: a reveal control, a title attribute or a debug panel
    // anywhere on this page would be the same defect.
    expect(await page.content()).not.toContain(secret!);
  });

  test("a finding carries its code, its position and the line it fired at", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.findingsSet;
    needs(set !== null, needsFixture(FINDINGS_SET_VAR));

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    await wf.checkControl().click();
    await expect(wf.scriptTable()).toBeVisible({ timeout: 30_000 });

    // The badge is the way in, and opening it is the assertion that the
    // cell is an affordance rather than a decoration.
    const badge = wf.findingsControl(FINDINGS_SCRIPT);
    await expect(badge).toHaveAttribute("aria-expanded", "false");
    await badge.click();
    await expect(badge).toHaveAttribute("aria-expanded", "true");

    const card = wf.card();
    await expect(card.getByText(FINDINGS_WARNING_CODE, { exact: true }).first()).toBeVisible();
    await expect(card.getByText(FINDINGS_INFO_CODE, { exact: true }).first()).toBeVisible();
    // A position is `line:col`, and the column is the half nobody can
    // use without counting - which is why the panel draws the source
    // line under it. Both halves are asserted, because a panel with a
    // code and no position sends an operator to read the whole file.
    await expect(card.getByText(/^\d+:\d+$/).first()).toBeVisible();
    // The excerpt itself: the bytes the verification read and hashed,
    // carried with the finding. Asserted through the line the rule fired
    // on rather than through a class name.
    await expect(card).toContainText("cd ");
  });

  test("a clean script says so rather than showing an empty panel", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.happySet;
    needs(set !== null, needsFixture(WORKFLOW_SET_VAR));

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    await wf.checkControl().click();
    await expect(wf.scriptTable()).toBeVisible({ timeout: 30_000 });

    await wf.findingsControl(HAPPY_BEFORE).click();
    // The contrast that makes the case above mean something. An empty
    // panel and a panel nobody filled in look identical; this sentence
    // is the product saying which one it is.
    await expect(wf.card()).toContainText(
      "This script parses, and backupd's own shell rules reported nothing about it."
    );
  });

  test("a hook with an error-severity finding is not called valid", async ({ bm, deployment, page }) => {
    const set = deployment.workflow.rejectedSet;
    needs(set !== null, needsFixture(REJECTED_SET_VAR));

    const wf = new WorkflowScreens(page);
    await wf.gotoSet(set!);
    await wf.checkControl().click();
    const card = wf.card();
    await expect(wf.scriptTable()).toBeVisible({ timeout: 30_000 });

    // The gate, not the report. An error-severity finding is what
    // REFUSES a save of a workflow configuration, and a card that
    // reported one while still claiming the hooks are valid would be
    // offering a save the service is about to refuse.
    await expect(card).toContainText("Hooks not valid");
    await expect(card.getByText(REJECTED_ERROR_CODE, { exact: true }).first()).toBeVisible();
  });
});
