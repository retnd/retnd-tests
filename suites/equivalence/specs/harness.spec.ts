import { compareState, runCli } from "../harness/tools";
import { expect, signIn, test } from "../harness/fixtures";

// The RED half of Suite C's plan, and the first thing to get right: a
// comparison nobody has seen fail is not a comparison. tools/equivstate
// has its own Go boundary tests for the differ itself; these prove the
// harness AROUND it, which is where a suite like this usually goes green
// by accident.
test.describe("the equivalence harness", () => {
  test("two untouched sides of the same scenario agree on every dimension", async ({ pair }) => {
    const result = compareState(pair.build, pair.ui.work, pair.cli.work, {
      // The engine has run one cycle over the UI side by now (it starts a
      // scheduler in the same process), so this is not a comparison of two
      // idle trees. config.yaml is ignored for the reason the settings
      // spec explains: the two sides' writers differ textually.
      // config.yaml: the two sides' writers differ textually, and the read
      // surface below is what settles whether they mean the same thing.
      // local-auth.json: this side has an enrolled administrator because a
      // browser has to sign in to drive it, and the CLI has no equivalent
      // to enrol one with. That asymmetry is setup, not a finding, and it
      // is named here rather than absorbed silently.
      // local-auth.json.lock is named separately because the suffix match
      // above does not reach it: it is the advisory flock apps/common/auth
      // /local's Service.New takes for its whole process lifetime
      // (rclone-manager#322), so whether it exists in a snapshot records
      // which side still had a server running, not any backend state this
      // suite compares.
      ignoreFiles: ["config.yaml", "local-auth.json", "local-auth.json.lock"],
      maskVolatile: true
    });
    expect(result.report).toBeTruthy();
    expect(result.equal, "two fresh materialisations of one scenario:\n" + result.report).toBe(true);
  });

  test("a deliberately divergent pair is caught", async ({ pair }) => {
    // The positive control for the case above. One backup set is removed
    // from one side's config through the CLI-side file, which every read
    // command in the comparison can see.
    const fs = await import("node:fs");
    const config = fs.readFileSync(pair.cli.config, "utf8");
    fs.writeFileSync(pair.cli.config, config.replace(/poll_interval:.*/, "poll_interval: 99m"));

    const result = compareState(pair.build, pair.ui.work, pair.cli.work, { maskVolatile: true });
    expect(result.equal, "a divergent pair was reported as equal:\n" + result.report).toBe(false);
  });

  test("the browser reaches the real built app, signed in against the real engine", async ({ page, pair }) => {
    await signIn(page, pair.ui);
    // Proof it is the real client and not the mock: the mock is compiled
    // out of a production bundle, and this page's data came over HTTP from
    // the engine this test started.
    const version = await page.request.get(pair.ui.uiUrl + "/api/v1/system/version");
    expect(version.status()).toBe(200);
    expect((await version.json()).commit).toBe(pair.build.commit);
  });

  test("the CLI side is driven by the same binary the comparison reads with", async ({ pair }) => {
    const result = runCli(pair.build, pair.cli.work, ["sources"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("production");
  });
});
