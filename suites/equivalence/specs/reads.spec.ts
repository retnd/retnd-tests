import { expect, signIn, test } from "../harness/fixtures";
import { runCli } from "../harness/tools";

// Matrix rows: the materially state-revealing reads. A read is in scope
// here because an operator acts on it: if the Web UI and the CLI disagree
// about which backup sets exist, one of them is about to be used to make a
// decision about a set the other does not think is there.
test.describe("read equivalence", () => {
  test("the Backup sets page lists exactly what `sources` lists", async ({ page, pair }) => {
    const sources = runCli(pair.build, pair.cli.work, ["sources"]);
    expect(sources.code, sources.stderr).toBe(0);

    // `sources` prints "source/set" per configured backup set, indented,
    // with key=value details after it.
    const cliIds = sources.stdout
      .split("\n")
      .map((line) => /^\s+(\S+\/\S+)\s/.exec(line)?.[1])
      .filter((id): id is string => Boolean(id))
      .sort();
    expect(cliIds.length, "the fixture has no backup sets, so this row would pass vacuously").toBeGreaterThan(0);

    await signIn(page, pair.ui);
    await page.goto(pair.ui.uiUrl + "/sets");

    // The set identifier is the second half of the CLI's "source/set".
    for (const id of cliIds) {
      const set = id.split("/")[1];
      await expect(
        page.getByText(set, { exact: false }).first(),
        `the Backup sets page does not show ${set}, which \`sources\` lists`
      ).toBeVisible();
    }

    // And the other direction, so a page that shows everything cannot pass
    // by showing too much: the count the UI reports has to match.
    await expect(page.getByText(new RegExp(`\\b${cliIds.length} sets?\\b`))).toBeVisible();
  });

  test("the same commit answers through both surfaces", async ({ page, pair }) => {
    // Matrix row: "Version and build provenance". The CLI half works; the
    // UI half is a gap, and contract-gaps.spec.ts pins why. What IS
    // provable, and worth proving, is that the engine the browser is
    // talking to and the binary the CLI side runs are one build. Without
    // that, every other row in this suite compares two products.
    // No --config: the usage banner exempts version from it and the binary
    // refuses one outright (backupdproject/backupd#189), so the helper's
    // default would fail this on a usage error before it could compare
    // anything. Suite A's version/no-config-flag is the case that pins it.
    const version = runCli(pair.build, pair.cli.work, ["version"], { config: false });
    expect(version.code, version.stderr).toBe(0);
    expect(version.stdout).toContain(pair.build.commit);

    await signIn(page, pair.ui);
    const served = await page.request.get(pair.ui.uiUrl + "/api/v1/system/version");
    expect(served.status()).toBe(200);
    expect((await served.json()).commit).toBe(pair.build.commit);
  });
});
