import { readFileSync, writeFileSync } from "node:fs";

import { expect, signIn, test } from "../harness/fixtures";
import { compareState, runCli } from "../harness/tools";

// Matrix row: "Settings write: retention policy".
//
// The setting under test is FR-19 last-known-good protection, chosen
// because it is the one retention setting whose effect is visible in the
// product's own read surface: `retention --dry-run` drops LAST_KNOWN_GOOD
// from the tier attribution and prints a different explanation line. A row
// whose change nothing can observe would pass whether or not either side
// did anything, which is the failure mode this suite is built to avoid,
// so every assertion below is paired with a before-and-after that proves
// the change actually landed.
test.describe("settings write: last-known-good protection", () => {
  test("turning it off in the Web UI leaves the same backend state as editing the config and running check", async ({
    page,
    pair
  }) => {
    const preview = (work: string) => runCli(pair.build, work, ["retention", "--dry-run"]).stdout;

    const uiBefore = preview(pair.ui.work);
    const cliBefore = preview(pair.cli.work);
    expect(uiBefore, "the two sides did not start from the same retention decisions").toBe(
      cliBefore.replaceAll(pair.cli.work, pair.ui.work)
    );
    expect(uiBefore, "the fixture does not exercise last-known-good protection at all").toContain("LAST_KNOWN_GOOD");

    // ---- the Web UI side
    await signIn(page, pair.ui);
    await page.goto(pair.ui.uiUrl + "/settings");

    const toggle = page.getByLabel(/Protect the newest known-good backup/);
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await page.getByRole("button", { name: "Save retention policy" }).click();
    await page
      .getByRole("dialog", { name: /Disable last-known-good protection/i })
      .getByRole("button", { name: "Disable protection" })
      .click();
    await expect(page.getByText(/Retention policy saved/)).toBeVisible();

    // ---- the CLI side: FR-5 says the config file is the CLI's write
    // surface for policy, and `check` is how it is validated afterwards.
    // There is no `backup-manager settings set`; the matrix says so rather
    // than inventing one.
    const config = pair.cli.config;
    const edited = readFileSync(config, "utf8").replace("protect_last_known_good: true", "protect_last_known_good: false");
    expect(edited, "the fixture config did not carry the setting this row edits").not.toBe(readFileSync(config, "utf8"));
    writeFileSync(config, edited);
    const check = runCli(pair.build, pair.cli.work, ["check"]);
    expect(check.code, check.stderr).toBe(0);

    // ---- both changes really landed, before anything is compared
    expect(preview(pair.ui.work), "the Web UI save did not reach the backend").not.toBe(uiBefore);
    expect(preview(pair.cli.work), "the config edit did not change what the CLI decides").not.toBe(cliBefore);

    // ---- and they landed as the same backend state
    const result = compareState(pair.build, pair.ui.work, pair.cli.work, {
      // config.yaml: written by the engine's YAML writer on one side and by
      // hand on the other, so the two are textually different and
      // semantically the same. The read surface below is what settles
      // whether they mean the same thing, which is the whole reason this
      // comparison is not a file diff.
      // local-auth.json: only the UI side has an enrolled administrator,
      // because a browser has to sign in and the CLI has no equivalent to
      // enrol one with. Setup asymmetry, named rather than absorbed.
      ignoreFiles: ["config.yaml", "local-auth.json"],
      maskVolatile: true
    });
    expect(result.equal, "the Web UI and the CLI left different backend state:\n" + result.report).toBe(true);
  });
});
