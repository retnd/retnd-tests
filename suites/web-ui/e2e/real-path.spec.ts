import { expect, needs, test } from "./fixtures";

/**
 * The claim this whole move exists to make, in one file.
 *
 * Every other spec in this suite asserts something about the product. This
 * one asserts something about the RUN: that what a browser is showing came
 * out of a real engine, through a real reverse proxy, over a real session,
 * from real files a real sshd handed over. Until now no test in this
 * repository could fail on any of that, because the app under test was a
 * Vite dev server wired to `createMockApi` and the whole chain below the
 * browser did not exist.
 *
 * It is deliberately small and deliberately first-principles. If this file
 * is green, a red anywhere else in the suite is a claim about the product.
 * If this file is red, nothing else in the suite means what it says, and
 * that is worth being able to tell apart at a glance.
 *
 * # Why the anchor comes from outside
 *
 * The topology creates a backup set on the source machine and lets the
 * engine ingest from it before this suite starts, then names it in
 * `RETND_BACKUP_SET`. That name is the anchor: the suite did not choose it,
 * the page cannot invent it, and a build that rendered a plausible fixture
 * instead of the catalogue would fail here and pass everywhere else.
 *
 * A suite that read the name off the page it is testing would be checking
 * the page against itself, which is the shape the mock had.
 */

test.describe("the browser is looking at a real deployment", () => {
  test("the backup set the topology created is the one on the page", async ({ bm, page }) => {
    needs(
      bm.facts.seededBackupSet !== null,
      "the topology to name the set it seeded, through RETND_BACKUP_SET (e.g. e2e/vps)"
    );
    const [source, set] = bm.facts.seededBackupSet!.split("/");

    await bm.goto("/sets");
    // The card is found by the set's own name, which came from outside
    // this process. Nothing here typed it into the deployment and nothing
    // in the bundle knows it.
    const card = page.getByRole("article").filter({ hasText: set });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(source);
  });

  test("the service agrees with the page about which sets exist", async ({ bm, page }) => {
    // Two readings of one truth, taken in the same run. The mock could not
    // have this case at all: the page and the "API" were one in-memory
    // object, so they could not disagree even in principle. Here they are
    // a bundle in a browser and a Go process reading SQLite, with a proxy
    // hop between them, and agreeing is a property rather than a tautology.
    needs(bm.facts.sets.length > 0, "at least one configured backup set");

    await bm.goto("/sets");
    await expect(page.getByRole("article")).toHaveCount(bm.facts.sets.length);

    for (const set of bm.facts.sets) {
      await expect(page.getByRole("article").filter({ hasText: set.set_name })).toHaveCount(1);
    }
  });

  test("the backups on the page are the artifacts the engine ingested", async ({ bm, page }) => {
    needs(
      bm.facts.backups.length > 0,
      "at least one ingested backup: this is the case that ties a row on screen to a file that was " +
        "really transferred off the source machine"
    );

    await bm.goto("/backups");
    // One assertion per distinct source/set/name, not per artifact. A
    // filename is not unique on a real deployment: this fixture backs
    // twelve sets up from one source directory, so `payload.bin` is a
    // dozen rows, and a set that has run twice has two of its own. The
    // claim worth making is unchanged - a file that originated on the
    // source machine, travelled over SFTP, was recorded in SQLite and
    // came back through the proxy is on the page - and scoping the row
    // to the set it belongs to is what keeps it a claim rather than a
    // strict-mode violation.
    const seen = new Set<string>();
    for (const artifact of bm.facts.backups) {
      const key = artifact.source_name + "/" + artifact.set_name + "/" + artifact.name;
      if (seen.has(key)) continue;
      seen.add(key);
      await expect(
        page
          .getByRole("row")
          .filter({ hasText: artifact.name })
          .filter({ hasText: artifact.set_name })
          .first(),
        key + " is in the catalogue but not on the page"
      ).toBeVisible();
    }
  });

  test("the activity feed is a real journal, not an empty page that renders", async ({ bm, page }) => {
    needs(
      bm.facts.activityEvents > 0,
      "recorded activity events, which a deployment gets by really running an ingestion"
    );

    await bm.goto("/activity");
    // backupd#598's page, reading the real feed. An empty timeline
    // and a failed read look identical to an operator, which is what that
    // issue was about, so the claim here is that this one is neither.
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("listitem").first()).toBeVisible();
    // A timestamp, so what rendered is an event rather than a stray list
    // item from the shell.
    await expect(page.getByRole("listitem").first()).toContainText(/\d{2}:\d{2}:\d{2}/);
  });

  test("the version card reports the binary that is actually serving this", async ({ bm, page }) => {
    // The provenance card was a fixture's seven strings until this run.
    // Every one of them now comes out of the process answering the
    // request, and the service version is read back independently through
    // the API so the card cannot agree with itself.
    await bm.goto("/settings");
    const provenance = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "System information", exact: true }) });
    await expect(
      provenance.locator("dt").filter({ hasText: "Service version" }).locator("xpath=following-sibling::dd[1]")
    ).toHaveText(bm.facts.serviceVersion);
  });

  test("a page's data really travels over the wire, and a broken wire is visible", async ({ bm, page }) => {
    // The negative control for this entire file, and the one case that
    // would have been impossible before the move in the most literal
    // sense: there was no wire.
    //
    // If the pages were still drawing from an in-browser fixture, cutting
    // the network for one endpoint would change nothing on screen. Cutting
    // it changes the page, which is the proof that the page depends on the
    // service. The same technique the failure cases in
    // activity-failure.spec.ts use, turned around: there it reproduces a
    // reported symptom, here it shows the dependency exists.
    needs(bm.facts.sets.length > 0, "at least one configured backup set, so the list has something to lose");

    await bm.goto("/sets");
    await expect(page.getByRole("article").first()).toBeVisible();

    await page.route("**/api/v1/backup-sets*", (route) => route.abort("failed"));
    await page.reload();

    // Not "the page is blank": a page that failed to read its own data has
    // to say so, which is #598's rule applied to a different endpoint.
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(0);

    // And it comes back, so this case cannot pass against a build that is
    // permanently broken.
    await page.unroute("**/api/v1/backup-sets*");
    await page.reload();
    await expect(page.getByRole("article").first()).toBeVisible();
  });
});
