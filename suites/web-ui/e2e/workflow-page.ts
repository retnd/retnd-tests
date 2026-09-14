import type { Locator, Page } from "@playwright/test";

/**
 * The workflow screens, as a browser reaches them (EPIC L, backupd#816).
 *
 * # Why a page object and not selectors in each spec
 *
 * Because there are four of these files and they all reach the same six
 * surfaces, and a suite whose selectors are copied is a suite that reports
 * one product change as four unrelated failures. The rule this file
 * follows is the one the rest of the suite follows: find things by ROLE
 * and by the words an operator reads, never by a class name and never by a
 * test id the product would have to keep for this suite's benefit.
 *
 * Two exceptions are deliberate and both are noted where they appear: the
 * workflow card and the stages card are plain `<section class="card">`
 * elements with an `<h2>` inside rather than named regions, so they are
 * found BY that heading, which is the same thing a reader does.
 *
 * # The names here are the product's
 *
 * Every string below was read out of ui/shared/src at the commit under
 * test, and the two that most invite an invented value are written down
 * with their source, because getting either subtly wrong produces a
 * confident green that asserts nothing:
 *
 *   - the step log panel is named "Log for <script>" (StepLogTerminal's
 *     `<section aria-label>`), and the scrollback inside it is a
 *     `role="log"` named "Captured output of <script>";
 *   - the truncation line is this product's own words and never the
 *     script's, so a hook cannot forge it.
 */

/** The marker the terminal draws where the engine stopped recording.
 *
 *  Copied from `stepterminal/sanitize.ts` rather than matched loosely,
 *  because a loose match is exactly what a hostile script would satisfy:
 *  the whole point of the product's wording is that the marker cannot be
 *  produced by the output it is marking. */
export const TRUNCATION_MARKER =
  "──── this product stopped recording here · the log limit for this step was reached · the script kept running ────";

/** What a local step's "Runs on" cell says. The Host Workflow Runner is
 *  the only executor of a local hook, and the cell naming it is what
 *  distinguishes a hook that ran on the manager from one that ran on the
 *  source machine. */
export const HOST_RUNNER = "Host Workflow Runner";

/** The recovery banner's title, which is also the sentence that explains
 *  why the Run control is unavailable. */
export const HOLD_TITLE = "This backup set will not run until a workflow run is accounted for";

/** The quiet empty state: one sentence, no table, no findings. */
export const NO_HOOKS_SENTENCE = "No hooks are configured for this backup set";

/** A set that configures nothing of its own but inherits the
 *  deployment's stages says so in the card header, and that is a
 *  different state from the quiet one. */
export const INHERITING_ONLY = "inheriting the deployment's global stages only";

export class WorkflowScreens {
  constructor(readonly page: Page) {}

  /** The backup set detail page. Two path segments, each encoded, exactly
   *  as `backupSetPath` builds it. */
  async gotoSet(backupSetId: string): Promise<void> {
    const [source, set] = backupSetId.split("/");
    await this.page.goto("/sets/" + encodeURIComponent(source) + "/" + encodeURIComponent(set));
  }

  async gotoRun(runId: string): Promise<void> {
    await this.page.goto("/workflow-runs/" + encodeURIComponent(runId));
  }

  /** The Workflow card on a backup set's page.
   *
   *  Found by its own heading, because the card is a `<section>` with no
   *  accessible name. Scoping every workflow assertion to it is what
   *  keeps a case about hooks from passing on a word that happened to
   *  appear in the retention card. */
  card(): Locator {
    return this.page
      .locator("section.card")
      .filter({ has: this.page.getByRole("heading", { level: 2, name: "Workflow", exact: true }) });
  }

  /** The one control that starts a backup, hooks and all.
   *
   *  Unavailable while the set is held for recovery, while the hold list
   *  is still being read, and while it could not be read at all - which
   *  is the gate backupd#814 added and the one the recovery cases
   *  assert against. */
  runControl(): Locator {
    return this.page.getByRole("button", { name: "Run this backup set", exact: true });
  }

  /** Reads every script in the set's directories, hashes it and verifies
   *  its shell. Executes nothing. The button renames itself once it has
   *  been pressed, so both spellings are accepted. */
  checkControl(): Locator {
    return this.card().getByRole("button", { name: /^(Check this set's hooks|Check again|Checking)/ });
  }

  /** The validation report's script table, found by the column that only
   *  it has. The card holds three tables once the environment editor has
   *  rendered, so naming the column is what keeps this off the wrong
   *  one. */
  scriptTable(): Locator {
    return this.card()
      .getByRole("table")
      .filter({ has: this.page.getByRole("columnheader", { name: "Runs on", exact: true }) });
  }

  /** One row of that table, by the script's own filename. */
  scriptRow(scriptName: string): Locator {
    return this.scriptTable().getByRole("row").filter({ hasText: scriptName });
  }

  /** The Findings cell's control. A real button rather than a
   *  decoration: the badge states a verdict and the panel it opens is
   *  the only place that verdict's reasons exist, so a count with no way
   *  to see what it counted is a number nobody can act on. */
  findingsControl(scriptName: string): Locator {
    return this.scriptRow(scriptName).getByRole("button");
  }

  /** The inheritance preview: what a hook will actually receive. This is
   *  the table a resolved secret would have to appear in, and the one the
   *  secret cases sweep. */
  environmentPreview(): Locator {
    return this.card()
      .getByRole("table")
      .filter({ has: this.page.getByRole("columnheader", { name: "Effective value", exact: true }) });
  }

  /** A run in the card's "Recent workflow runs" list. Each is a button
   *  that navigates to the run page. */
  historyEntry(runId: string): Locator {
    return this.card().getByRole("button").filter({ hasText: runId });
  }

  /** The recovery banner, on either the set page or the run page. A
   *  danger-toned WarningBanner is `role="alert"`, so it is found the way
   *  a screen reader is told about it. */
  recoveryBanner(): Locator {
    return this.page.getByRole("alert").filter({ hasText: HOLD_TITLE });
  }

  resumeControl(): Locator {
    return this.recoveryBanner().getByRole("button", { name: /^(Resume cleanup|Resuming)/ });
  }

  acknowledgeControl(): Locator {
    return this.recoveryBanner().getByRole("button", { name: /^(Acknowledge|Cancel acknowledgement)/ });
  }

  /** The reason a person takes responsibility in. Required by the
   *  service, so the submit below stays disabled until it has words in
   *  it. */
  acknowledgeReason(): Locator {
    return this.page.locator("#workflow-acknowledge-reason");
  }

  recordAcknowledgement(): Locator {
    return this.recoveryBanner().getByRole("button", { name: /^(Record acknowledgement|Recording)/ });
  }

  /* -------------------------------------------------------------- */
  /* The run page                                                    */
  /* -------------------------------------------------------------- */

  /** One of the three verdicts, by name: "Backup", "Workflow" or
   *  "Cleanup". Each is its own named group, so which verdict is which
   *  stays answerable without relying on column position. */
  verdict(which: "Backup" | "Workflow" | "Cleanup"): Locator {
    return this.page.getByRole("group", { name: which + " status", exact: true });
  }

  /** The five stages and their steps. */
  stagesCard(): Locator {
    return this.page
      .locator("section.card")
      .filter({ has: this.page.getByRole("heading", { level: 2, name: "Stages", exact: true }) });
  }

  /** One step's row. A real button with `aria-pressed`, which is what
   *  makes "which step's output am I reading" answerable without sight -
   *  and what lets a case assert that exactly one is selected. */
  stepRow(scriptName: string): Locator {
    return this.stagesCard().getByRole("button").filter({ hasText: scriptName });
  }

  everyStepRow(): Locator {
    return this.stagesCard().getByRole("button");
  }

  /** The single mounted log viewer. Named for the step it is showing, so
   *  "the terminal switched" and "a second terminal appeared" are
   *  different observations rather than the same one. */
  terminal(scriptName: string): Locator {
    return this.page.getByRole("region", { name: "Log for " + scriptName, exact: true });
  }

  /** Every mounted log viewer, however many there are. The count is the
   *  assertion: #816 requires exactly one on a run with many steps. */
  everyTerminal(): Locator {
    return this.page.locator("section[aria-label^='Log for ']");
  }

  /** The scrollback itself, as opposed to the panel around it. */
  output(scriptName: string): Locator {
    return this.page.getByRole("log", { name: "Captured output of " + scriptName, exact: true });
  }

  followControl(scriptName: string): Locator {
    return this.terminal(scriptName).getByRole("button", { name: /^(Following output|Follow output)$/ });
  }
}
