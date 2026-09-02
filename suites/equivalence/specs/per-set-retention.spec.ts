import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, signIn, test } from "../harness/fixtures";
import { compareState, runCli } from "../harness/tools";

// Matrix row: "Give a backup set its own retention policy, and take it
// back off" (spdrman/rclone-manager#333).
//
// This row exists because the matrix's own status vocabulary makes the
// distinction that matters: a capability that lands on one surface and
// not the other is a GAP, and the whole reason #333 was not closed by the
// config-layer change is that a field an operator can only reach by hand
// editing config.yaml is not the whole feature. So the claim here is not
// "the UI can do it" but "the UI and the CLI reach the same backend state
// doing it", in both directions.
//
// # The chain the two sides write has to be spelled the same way twice
//
// The UI edits the CHAIN (a tiers list), because that is the general form
// and the only one that can express a policy of any shape. The CLI's
// --policy-file takes the contents of a config.yaml `retention:` block,
// which is the same spelling. Neither side is given the deployment's
// calendar, so both inherit it, which is what an override that omits a
// timezone means and the one thing about this feature that silently costs
// an operator a day's worth of restore points when it goes wrong.
//
// # What makes the change observable at all
//
// `retention --dry-run` names the policy for a set that decides for
// itself and prints the chain it decided with, and prints nothing extra
// for a set that inherits. That line is the read-surface evidence this
// row rests on: both sides go from silent to naming an identical chain,
// and then back to silent when the override is cleared. Without it the
// comparison would be between two directories that agree because neither
// changed.
const OVERRIDE_POLICY = `# The contents of a config.yaml "retention:" block, key omitted.
# No timezone and no week start: an override that names neither inherits
# the deployment's, which is exactly what the Web UI side submits when its
# "reckon this policy in the deployment's calendar" box is left ticked.
tiers:
  - name: daily
    granularity: day
    keep: 3
  - name: weekly
    granularity: week
    keep: 3
    window_unit: month
  - name: monthly
    granularity: month
    keep: 12
`;

test.describe("per-set retention: overriding, and going back to inheriting", () => {
  test("giving one backup set its own policy, and clearing it, leaves the same backend state either way", async ({
    page,
    pair
  }) => {
    const preview = (work: string) => runCli(pair.build, work, ["retention", "--dry-run"]).stdout;
    const normalise = (out: string) => out.replaceAll(pair.cli.work, pair.ui.work);

    const uiStart = preview(pair.ui.work);
    const cliStart = preview(pair.cli.work);
    expect(uiStart, "the two sides did not start from the same retention decisions").toBe(
      normalise(cliStart)
    );
    expect(
      uiStart,
      "the fixture already has a set deciding for itself, so this row would prove nothing about creating one"
    ).not.toContain("retained under this set's own policy");

    // ---- the Web UI side
    await signIn(page, pair.ui);
    await page.goto(pair.ui.uiUrl + "/sets/production/postgres-primary");

    await expect(page.getByText(/Retained under the deployment's retention policy/)).toBeVisible();
    await page.getByRole("button", { name: "Give this set its own policy" }).click();

    // The editor opens on the deployment's whole chain, which is what
    // stops a first save being half a policy. Narrowing daily from 7 to 3
    // is the whole edit; every other tier is submitted exactly as it was
    // read, which is also what proves the form is not quietly dropping
    // the tiers it did not touch.
    const daily = page.getByRole("group", { name: "Tier 1" });
    await daily.getByLabel("Keep").fill("3");
    await page.getByRole("button", { name: "Save this set's policy" }).click();
    await expect(page.getByText(/Retained under this backup set's own policy/)).toBeVisible();

    // ---- the CLI side
    const policyPath = resolve(pair.cli.work, "override.yaml");
    writeFileSync(policyPath, OVERRIDE_POLICY);
    const set = runCli(pair.build, pair.cli.work, [
      "backup-set",
      "retention",
      "production/postgres-primary",
      "--policy-file",
      policyPath
    ]);
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout, "the CLI did not report the set as deciding for itself").toContain(
      "retained under: this backup set's own policy"
    );

    // ---- both changes really landed, before anything is compared
    const uiOverridden = preview(pair.ui.work);
    const cliOverridden = preview(pair.cli.work);
    expect(uiOverridden, "the Web UI save did not reach the backend").not.toBe(uiStart);
    expect(cliOverridden, "the CLI write did not change what this deployment decides").not.toBe(cliStart);
    expect(uiOverridden).toContain("retained under this set's own policy");
    expect(normalise(cliOverridden)).toContain("retained under this set's own policy");

    // ---- and they landed as the same backend state
    const overridden = compareState(pair.build, pair.ui.work, pair.cli.work, {
      // config.yaml: the two sides reach the same policy through the same
      // service writer, but the UI side's file also carries the backup set
      // the browser never touched in a different key order than the hand
      // written fixture, so this row settles equivalence through the read
      // surface exactly as the settings row does.
      // local-auth.json (+ .lock): only the UI side enrols an
      // administrator, because a browser has to sign in and the CLI has no
      // way to enrol one. Setup asymmetry, named rather than absorbed.
      // override.yaml: the CLI side's own input file, which only exists
      // because the CLI needs somewhere to read a chain from. It is not
      // backend state; the Web UI's equivalent is a form.
      ignoreFiles: ["config.yaml", "local-auth.json", "local-auth.json.lock", "override.yaml"],
      maskVolatile: true
    });
    expect(
      overridden.equal,
      "the Web UI and the CLI left different backend state after the override:\n" + overridden.report
    ).toBe(true);

    // ---- and now the other direction, which is the operation that has no
    // spelling on a sparse update at all: back to inheriting.
    await page.getByRole("button", { name: "Return to the deployment's policy" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Return to the deployment's policy" })
      .click();
    await expect(page.getByText(/Retained under the deployment's retention policy/)).toBeVisible();

    const cleared = runCli(pair.build, pair.cli.work, [
      "backup-set",
      "retention",
      "production/postgres-primary",
      "--inherit"
    ]);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(cleared.stdout).toContain("retained under: the deployment's policy (inherited)");

    // Back to exactly where both sides started, which is the issue's own
    // "with no residue of the chain it used to declare": a set that had
    // been overridden and cleared has to be indistinguishable from one
    // that never was, not merely resolved to the same chain.
    expect(preview(pair.ui.work), "clearing left the Web UI side somewhere new").toBe(uiStart);
    expect(normalise(preview(pair.cli.work)), "clearing left the CLI side somewhere new").toBe(uiStart);

    const inheriting = compareState(pair.build, pair.ui.work, pair.cli.work, {
      ignoreFiles: ["config.yaml", "local-auth.json", "local-auth.json.lock", "override.yaml"],
      maskVolatile: true
    });
    expect(
      inheriting.equal,
      "the Web UI and the CLI left different backend state after clearing the override:\n" + inheriting.report
    ).toBe(true);
  });
});
