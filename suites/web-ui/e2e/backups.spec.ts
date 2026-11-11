import { retentionClasses } from "../harness/api";
import { expect, mockOnly, needs, test } from "./fixtures";
import type { Retnd } from "./fixtures";

/**
 * The backups table and one backup's detail, against a real deployment.
 *
 * The split here is the cleanest in the suite, and it is worth reading
 * before the cases.
 *
 * The TABLE and the DETAIL page are real: their columns, their vocabulary,
 * their refusals and their lifecycle ordering are claims about the app,
 * and they hold on whatever the deployment happens to hold, so long as it
 * holds something. Each of those cases needs one backup and says so.
 *
 * The COPIES block is the exception, and it is the sharpest example in the
 * whole suite of the trap the brief named. Every case in it is written
 * against three artifacts by name (`postgres-prod-20260828.dump.zst`,
 * `billing-20260827.sql.gz`, `media-week34.tar`), on named storage
 * classes (`STANDARD_IA`, `DEEP_ARCHIVE`), verified to named depths, one
 * of them on a medium nothing can reach. That is not a state a deployment
 * gets into; it is a fixture somebody wrote to make five different
 * readings expressible in one page. So those cases each state which
 * placement they would need, read the deployment's real placements to
 * decide, and skip with that reading printed rather than passing against
 * whatever happens to be there.
 *
 * None of them was deleted, and none was loosened into a shape that
 * cannot fail. A case about telling "unreachable" from "gone" is worth
 * nothing if it is rewritten to accept either.
 */

/** How many column headers the backups table should have, built from the
 *  columns this deployment actually draws rather than from a total.
 *
 *  Seven is the number of columns that carry information: Time, Backup
 *  set, Artifact, Size, Assurance, Retention and Status. The table also
 *  draws an Actions column of its own (visually hidden title), a leading
 *  select-all checkbox column for an operator who may recover, an
 *  Encryption column once the deployment has encryption to speak of, and
 *  Medium when it declares a storage medium. The first two are about who
 *  is looking and the last two about what the deployment holds, so a bare
 *  total goes red every time one of them appears and says nothing about
 *  whether the seven are there. */
async function expectedColumnHeaders(page: import("@playwright/test").Page, mediums: boolean) {
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  for (const col of ["Time", "Backup set", "Artifact", "Size", "Assurance", "Retention", "Status"]) {
    await expect(table.getByRole("columnheader", { name: col, exact: true })).toHaveCount(1);
  }
  await expect(table.getByRole("columnheader", { name: "Actions", exact: true })).toHaveCount(1);
  const select = await page.getByRole("checkbox", { name: "Select all matching backups" }).count();
  const encryption = await table.getByRole("columnheader", { name: "Encryption", exact: true }).count();
  return 7 + 1 + select + encryption + (mediums ? 1 : 0);
}

test.describe("backups table", () => {
  test.beforeEach(async ({ bm }) => {
    needs(bm.facts.configured, "a configured deployment: this page refuses with NOT_CONFIGURED before the first backup set exists");
    needs(
      bm.facts.backups.length > 0,
      "at least one ingested backup. A real deployment has none until a cycle runs and something " +
        "lands, where the mock's catalogue was populated on every page load"
    );
    await bm.goto("/backups");
  });

  test("is called Backups, never Restore points", async ({ bm, page }) => {
    await expect(bm.heading("Backups")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(/restore point/i);
  });

  test("states plainly that it does not perform restore", async ({ page }) => {
    // The footer used to say "retained, verified copies", and "verified" was
    // the one word EPIC Q (retnd#985, #987) took away: a copy is Stored,
    // Content verified or Recovery tested now, each as its own claim, so a
    // footer calling every row verified would contradict the chips above it.
    // The sentence that replaces it is the boundary sentence (retnd#987,
    // docs/adr/0029): the product recovers and exports, and putting the bytes
    // back into an application stays with the operator. Which exact words the
    // footer settles on is retnd#1057's to decide, so this holds the part both
    // wordings share: the card footer, below the "Showing N artifacts" count,
    // speaks about restoring into an application.
    const footer = page.locator(".card__footer").filter({ hasText: /Showing \d+ artifacts?/ });
    await expect(footer).toBeVisible();
    await expect(footer).toContainText(/restor(e|ing)/i);
    await expect(footer).toContainText(/application/i);
    await expect(footer).not.toContainText(/verified copies/i);
  });

  test("renders a real table with all seven documented columns", async ({ page }) => {
    const table = page.getByRole("table");
    await expect(table).toBeVisible();
    // Assurance sits where Validation used to: retnd#1057 retired the
    // Validation column (the green "Verified" badge) and put the three claims,
    // Stored, Content verified and Recovery tested, in its place.
    for (const col of ["Time", "Backup set", "Artifact", "Size", "Assurance", "Retention", "Status"]) {
      await expect(table.getByRole("columnheader", { name: col })).toBeVisible();
    }
  });

  test("uses column headers, not styled divs", async ({ bm, page }) => {
    // Seven or eight, and which one is a fact about the deployment rather
    // than about the page. The eighth is Medium, and it is there when this
    // instance has a copy somewhere other than the local backup root.
    //
    // The old case pinned eight, because the mock always had one. Pinning
    // a number the deployment decides would make this red on every
    // deployment that declares no storage medium, which is FR-35's
    // supported case and the state a fresh install is in.
    //
    // The count is back to what it was before EPIC Q (retnd#985): the
    // Assurance column took the place of Validation rather than joining it,
    // and carries the three claims, Stored, Content verified and Recovery
    // tested, inside its cells.
    const expected = await expectedColumnHeaders(page, bm.facts.mediums.length > 0);
    await expect(page.getByRole("columnheader")).toHaveCount(expected);
    await expect(page.getByRole("columnheader", { name: "Assurance" })).toHaveCount(1);
    await expect(page.getByRole("columnheader", { name: "Validation" })).toHaveCount(0);
    const rows = await page.getByRole("row").count();
    expect(rows).toBeGreaterThan(1);
  });

  test("a backup can hold several retention classifications at once", async ({ bm, page }) => {
    // A real state rather than a fixture: the newest backup of a
    // deployment with a daily/weekly/monthly chain is all three at once,
    // once retention has classified it. It just has not necessarily
    // happened yet on this deployment, so the premise is read off the
    // catalogue instead of assumed.
    const multi = bm.facts.backups.find((b) => retentionClasses(b).length > 1);
    needs(
      multi !== undefined,
      "a backup carrying more than one retention class. Retention has to have classified this " +
        "deployment's catalogue first; until it runs, every artifact carries at most one"
    );
    const row = page.getByRole("row").filter({ hasText: multi!.name });
    // Two of its real classes, whichever two they are, on its own row.
    for (const cls of retentionClasses(multi!).slice(0, 2)) {
      await expect(row).toContainText(new RegExp(cls, "i"));
    }
  });

  test("marks the protected artifact distinctly", async ({ bm, page }) => {
    // My first version of this comment said last-known-good protection is
    // on by default so any deployment holding a backup has a protected
    // row, and the first real run said otherwise: every row read
    // "unclassified", and nothing was marked.
    //
    // Protection is a RETENTION verdict, and retention has to have run
    // and classified the catalogue before any artifact is the newest
    // known-good of anything. A deployment that has ingested backups and
    // never applied retention has no protected row, correctly, and the
    // mock hid that by shipping a catalogue that was already classified.
    needs(
      bm.facts.backups.some((b) => retentionClasses(b).length > 0),
      "a catalogue retention has classified. Every artifact here is unclassified, which is what an " +
        "ingested-but-never-retained deployment really looks like, and nothing in it is protected yet"
    );
    await expect(page.getByText("Protected").first()).toBeVisible();
  });

  test("status distinguishes removed from retained remote sources", async ({ page }) => {
    await expect(page.getByText(/Remote source (removed|retained)/).first()).toBeVisible();
  });

  test("filters by backup set", async ({ bm, page }) => {
    needs(
      bm.facts.sets.length > 1,
      "more than one backup set: filtering one of one removes nothing, so the case would pass " +
        "against a control wired to nothing"
    );
    const before = await page.getByRole("row").count();
    await page.getByLabel("Filter by backup set").selectOption({ index: 1 });
    await expect(page.getByRole("row")).not.toHaveCount(before);
  });

  test("retention preview requires a set to be chosen first", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Preview retention" })).toBeDisabled();
    await page.getByLabel("Filter by backup set").selectOption({ index: 1 });
    await expect(page.getByRole("button", { name: "Preview retention" })).toBeEnabled();
  });

  test("row click opens the artifact detail", async ({ page }) => {
    await page.getByRole("row").nth(1).click();
    await expect(page.getByText("Artifact ID")).toBeVisible();
  });

  test("offers no arbitrary file-delete action", async ({ page }) => {
    await expect(page.getByRole("button", { name: /delete remote/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^delete file/i })).toHaveCount(0);
  });

});

/** What `?scenario=empty` stood in for, and the state a real container is
 *  genuinely in before a cycle has landed anything. It runs on a fresh
 *  deployment and states why it does not on a seeded one, which is the
 *  exact reverse of how it read against the mock. */
test.describe("a deployment that has ingested nothing yet", () => {
  test("explains what has not happened yet", async ({ bm, page }) => {
    needs(bm.facts.backups.length === 0, "a deployment holding no backups");
    await bm.goto("/backups");
    await expect(page.getByText("No backups yet")).toBeVisible();
    await expect(page.getByText(/has not completed its first successful ingestion/)).toBeVisible();
  });
});

test.describe("backup detail", () => {
  test.beforeEach(async ({ bm, page }) => {
    needs(bm.facts.backups.length > 0, "at least one ingested backup to open");
    await bm.goto("/backups");
    await page.getByRole("row").nth(1).click();
  });

  test("shows every documented artifact field", async ({ page }) => {
    // "Ingestion path", not "Local path". The old label read as "this is
    // where your backup is", which the field has never meant: it is where
    // ingestion landed, and it stays populated for a transfer still
    // running and for a backup whose local copy has since moved to a
    // storage medium. The Copies card asserted below is what answers the
    // other question now.
    for (const label of [
      "Artifact ID", "Backup set", "Remote original", "Ingestion path",
      "Producer timestamp", "Received timestamp", "Size", "Checksum",
      "Validation result", "Retention classes", "Remote source removed"
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
  });

  /** §15's ordering, and the one assertion in this file that got STRONGER
   *  by moving off the mock: the mock drew a fixed timeline, so the order
   *  was a property of a fixture. Here the phases were reached by a real
   *  cycle, in real time, and the page is rendering what the catalogue
   *  recorded.
   *
   *  The phases a backup has not reached are the change. The mock's
   *  artifact had reached all six; a real backup on a set that keeps its
   *  remote source never reaches the sixth, and one still being verified
   *  has not reached the fourth. So the assertion is about the ORDER of
   *  the phases this backup did reach, which is what §15 is about, rather
   *  than about all six being present. Remote deletion after commit is
   *  the rule, and a timeline missing remote deletion has not broken it. */
  test("renders the lifecycle in the only correct order", async ({ page }) => {
    const timeline = page.getByRole("region", { name: "Lifecycle" }).or(page.locator("ol").last());
    const text = await timeline.innerText();

    const order = [
      "DISCOVERED", "TRANSFERRED", "VERIFIED", "COMMITTED",
      "SAFE STATE PERSISTED", "REMOTE SOURCE DELETED"
    ];
    const reached = order.map((label) => ({ label, at: text.indexOf(label) })).filter((p) => p.at > -1);

    // The premise: a lifecycle with nothing in it satisfies every ordering
    // rule there is. Discovery is the one phase every artifact in the
    // catalogue has by definition.
    expect(reached.map((p) => p.label)).toContain("DISCOVERED");
    expect(reached.length).toBeGreaterThan(1);

    for (let i = 1; i < reached.length; i++) {
      // Remote deletion can never precede commit (§15).
      expect(
        reached[i].at,
        reached[i].label + " is rendered before " + reached[i - 1].label
      ).toBeGreaterThan(reached[i - 1].at);
    }
  });

  test("timestamps every reached phase", async ({ page }) => {
    const timeline = page.locator("ol").last();
    await expect(timeline).toContainText(/\d{2}:\d{2}:\d{2}/);
  });

  test("frames remote deletion as a consequence, not an action", async ({ page }) => {
    await expect(
      page.getByText(/lifecycle consequence of a proven NAS copy .* never an independent file operation/)
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);
  });

  test("returns to the table", async ({ bm, page }) => {
    await page.getByRole("button", { name: /Backups/ }).first().click();
    await expect(bm.heading("Backups")).toBeVisible();
  });
});

/**
 * backupd#240 (EPIC E, FR-34): where a backup's copies actually
 * are, and which of them anybody can read.
 *
 * Everything below is one question asked in different words: does this
 * surface tell "there is no copy" apart from "there is a copy nobody can
 * confirm" apart from "there is a copy nobody has checked"?
 *
 * That is not a stylistic worry. backupd#361 was a run cycle that
 * backed nothing up and reported success. A row reading "stored on
 * offsite_s3" for an unconfirmable copy, or a tick beside an unverified
 * one, is the same defect rendered in HTML, and an operator finds out it
 * was decorative at the one moment it matters.
 */
test.describe("where a backup's copies are", () => {
  const copies = (page: import("@playwright/test").Page) =>
    page.getByRole("region", { name: "Copies" });

  async function openBackup(bm: Retnd, page: import("@playwright/test").Page, filename: string) {
    await bm.goto("/backups");
    await page.getByRole("row").filter({ hasText: filename }).click();
    await expect(copies(page)).toBeVisible();
  }

  /** The first backup in this deployment's catalogue whose placements
   *  match what a case needs, or undefined.
   *
   *  This is what replaced three hardcoded filenames. Each case below says
   *  which PLACEMENT it is about, finds a backup that really has one, and
   *  drives the page to it. A deployment that has no such backup gets the
   *  reading printed instead of a green tick. */
  const withPlacement = (
    bm: Retnd,
    matches: (p: NonNullable<(typeof bm.facts.backups)[number]["placements"]>[number]) => boolean
  ) => bm.facts.backups.find((b) => (b.placements ?? []).some(matches));

  /** The columns are the app's, so they hold for any backup with a copy.
   *  What was fixture-shaped was the CONTENT: `offsite_s3` and
   *  `STANDARD_IA` are one deployment's declared medium and one storage
   *  class, and a deployment that declares nothing has neither. So the
   *  columns are asserted unconditionally and the contents are asserted
   *  against this deployment's own placement, whatever it is on. */
  test("lists one row per durable copy, with where it is and what it is on", async ({ bm, page }) => {
    const artifact = bm.facts.backups.find((b) => (b.placements ?? []).length > 0);
    needs(artifact !== undefined, "a backup with at least one recorded copy");
    await openBackup(bm, page, artifact!.name);

    const card = copies(page);
    for (const col of ["Where", "Location", "Copy size", "Class", "Access", "Verification"]) {
      await expect(card.getByRole("columnheader", { name: col })).toBeVisible();
    }
    // One row per placement the service recorded, and each row naming the
    // medium it is on. The count is the sharp half: a card that drew one
    // row for a backup with two copies is the defect this block exists
    // for, and no assertion on text alone can see it.
    const placements = artifact!.placements ?? [];
    await expect(card.getByRole("row")).toHaveCount(placements.length + 1);
    for (const placement of placements) {
      await expect(card.getByText(placement.medium === "local" ? "Local backup root" : placement.medium)).toBeVisible();
    }
  });

  /** Two copies of one backup, verified to different depths, and the page
   *  saying so. An existence check reported as content verification is
   *  worse than no check at all: it turns "nobody has read these bytes in
   *  a year" into a green tick.
   *
   *  Reaching it needs a backup with copies on two mediums that were
   *  verified differently, which is a deployment that declares a remote
   *  medium and has moved something to it. On a local-only deployment
   *  every copy is content-verified and the weaker rung has nothing to
   *  render, so the case says that rather than asserting one of the two
   *  and calling it covered. */
  test("reports the verification each copy actually achieved, never a stronger one", async ({ bm, page }) => {
    const artifact = bm.facts.backups.find((b) => {
      const classes = new Set((b.placements ?? []).map((p) => p.verification_class));
      return classes.size > 1;
    });
    needs(
      artifact !== undefined,
      "a backup with copies verified to different depths. That needs a declared remote medium and " +
        "something moved to it: on a local-only deployment every copy is content-verified"
    );
    await openBackup(bm, page, artifact!.name);

    const card = copies(page);
    await expect(card.getByText("Content verified")).toBeVisible();
    await expect(card.getByText("Existence only")).toBeVisible();
    // The backend's own words for what the weaker rung proves, rather
    // than the frontend's summary of them.
    await expect(card.getByText(/Proves an object exists at the recorded key/i)).toBeVisible();
  });

  test("says an archive copy needs a restore before anybody plans around it", async ({ bm, page }) => {
    const artifact = withPlacement(bm, (p) => p.access === "requires_restore");
    needs(
      artifact !== undefined,
      "a backup with a copy on an archive class. That needs a declared archive medium (DEEP_ARCHIVE " +
        "or equivalent) with a copy already on it, which no deployment reaches by running one cycle"
    );
    await openBackup(bm, page, artifact!.name);

    const card = copies(page);
    await expect(card.getByText("Needs a restore")).toBeVisible();
    // Twice, deliberately: once on the row and once in the footer's
    // disclosure. `first()` rather than a narrower matcher because both
    // are true statements about this copy and a spec that pinned one
    // spelling would break on a reworded footer.
    await expect(card.getByText(/cannot be read on demand/i).first()).toBeVisible();
    // No estimate anywhere. The provider reports no progress and no
    // completion time, so a number here could only be invented.
    await expect(card.getByText(/\b\d+\s*(hours|minutes)\b/)).toHaveCount(0);
    await expect(card.getByText("Readable now")).toHaveCount(0);
  });

  /** The distinction this whole block exists for, and the one it would be
   *  worst to loosen: "nothing here can confirm this copy" is not "the
   *  copy is gone". A deployment reaches it when a declared medium stops
   *  answering, which is a state the topology can arrange by taking the
   *  medium's endpoint away, and one no amount of running backups
   *  produces on its own. */
  test("says nothing can confirm a copy on a medium it cannot reach, and does not call it gone", async ({ bm, page }) => {
    const artifact = withPlacement(bm, (p) => p.access === "unreachable");
    needs(
      artifact !== undefined,
      "a backup with a copy on a medium this deployment cannot currently reach"
    );
    await openBackup(bm, page, artifact!.name);

    const card = copies(page);
    await expect(card.getByText("Out of reach")).toBeVisible();
    await expect(card.getByText(/nothing here can confirm this copy/i)).toBeVisible();
    await expect(card.getByText(/not the same as the copy being gone/i)).toBeVisible();
    await expect(card.getByText("Readable now")).toHaveCount(0);
  });

  test("says there is no copy at all, rather than showing the ingestion path as one", async ({ bm, page }) => {
    const artifact = bm.facts.backups.find((b) => (b.placements ?? []).length === 0);
    needs(
      artifact !== undefined,
      "a backup still arriving, with no confirmed copy yet. That is a window of seconds on a real " +
        "deployment rather than the permanent fixture the mock held"
    );
    await openBackup(bm, page, artifact!.name);

    const card = copies(page);
    await expect(card.getByText("No confirmed copy yet")).toBeVisible();
    await expect(card.getByText(/a partial file is not a copy/i)).toBeVisible();
    // The ingestion path is on the page, labelled as what it is, and it is
    // not inside the list of copies. That is the assertion: not that the
    // path is hidden, but that it is not presented as storage. The path is
    // this deployment's own rather than the fixture's.
    await expect(page.getByText("Ingestion path", { exact: true })).toBeVisible();
    await expect(card.getByRole("row")).toHaveCount(0);
  });

  test("states that retrieval is billed, and shows no figure for it", async ({ bm, page }) => {
    const artifact = withPlacement(bm, (p) => p.medium_type === "s3");
    needs(
      artifact !== undefined,
      "a backup with a copy on a provider that bills for retrieval, which needs a declared S3 medium"
    );
    await openBackup(bm, page, artifact!.name);

    await expect(copies(page).getByText(/billed by your provider/i)).toBeVisible();
    // backupd#211's rule: this product holds no price list and
    // does not know what an operator negotiated, so a figure would be one
    // it made up.
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/\$\s?\d/);
    expect(text).not.toMatch(/per\s+(GB|TB|gigabyte)/i);
  });

  test("shows a Medium column once this deployment declares one", async ({ bm, page }) => {
    needs(
      bm.facts.mediums.length > 0,
      "a deployment that declares a storage medium. With none declared the column is correctly " +
        "absent, which is FR-35's compatibility case and is asserted in its own block below"
    );
    await bm.goto("/backups");

    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader", { name: "Medium" })).toBeVisible();
    // This deployment's own declared medium, rather than the fixture's
    // `offsite_cold`.
    await expect(table.getByText(bm.facts.mediums[0].id)).toBeVisible();

    // A backup still arriving has no copy, and the cell says so rather
    // than being blank, which would read as "the column does not apply".
    const arriving = bm.facts.backups.find((b) => (b.placements ?? []).length === 0);
    if (arriving) {
      await expect(
        page.getByRole("row").filter({ hasText: arriving.name }).getByText("No copy yet")
      ).toBeVisible();
    }
  });
});

/**
 * FR-35's compatibility line, in a browser. A deployment that declares no
 * storage medium gets the pages it already had, and this is the only place
 * that can be checked end to end rather than argued.
 *
 * The line moved once, and only on one surface. backupd#622 made
 * the local hard drive a destination in its own right, so "declares
 * nothing" stopped meaning "has nowhere to send a backup" and started
 * meaning "has exactly one place, the drive it already writes to". The
 * two reading surfaces below are untouched by that and still assert the
 * old thing: no Medium column, no restore, no retrieval billing. The
 * retention form is the one that changed, and its case says so at
 * length.
 */
test.describe("a deployment that never heard of storage mediums", () => {
  // `?scenario=no-medium` was the mock's way of manufacturing this, and it
  // is the second scenario in the suite that turned out to describe a real
  // deployment's ordinary state rather than a fixture: an instance that
  // declares nothing is exactly what migration 0007's backfill leaves
  // every pre-EPIC-E installation as, and what a fresh container is.
  test.beforeEach(async ({ bm }) => {
    needs(
      bm.facts.mediums.length === 0,
      "a deployment declaring no storage medium. FR-35's compatibility line is about that instance " +
        "specifically, so it cannot be asserted against one that declares any"
    );
  });

  test("has no Medium column, and exactly seven columns, Assurance in the place Validation held", async ({ bm, page }) => {
    needs(bm.facts.backups.length > 0, "at least one ingested backup, so there is a table to count columns on");
    await bm.goto("/backups");

    const table = page.getByRole("table");
    await expect(table).toBeVisible();
    await expect(page.getByRole("columnheader")).toHaveCount(await expectedColumnHeaders(page, false));
    await expect(table.getByRole("columnheader", { name: "Assurance" })).toHaveCount(1);
    await expect(table.getByRole("columnheader", { name: "Validation" })).toHaveCount(0);
    await expect(table.getByRole("columnheader", { name: "Medium" })).toHaveCount(0);
    // The positive control: the table really rendered rows, so the
    // absence above is the absence of a column and not of the page.
    expect(await page.getByRole("row").count()).toBeGreaterThan(1);
  });

  test("still says where each backup's one copy is", async ({ bm, page }) => {
    needs(bm.facts.backups.some((b) => (b.placements ?? []).length > 0), "at least one backup with a copy recorded");
    await bm.goto("/backups");
    await page.getByRole("row").nth(1).click();

    const card = page.getByRole("region", { name: "Copies" });
    await expect(card.getByText("Local backup root")).toBeVisible();
    await expect(card.getByText("Content verified")).toBeVisible();
    // Nothing about mediums, restores or retrieval billing reaches an
    // instance that has none.
    await expect(card.getByText(/billed by your provider/i)).toHaveCount(0);
    await expect(card.getByText("Needs a restore")).toHaveCount(0);
  });

  /**
   * This case used to assert the opposite, and it is worth writing down
   * why rather than quietly turning it around, because BOTH halves of it
   * were wrong and only one of them was about the product.
   *
   * The claim was "a deployment that declares nothing gets no destination
   * picker", on the reasoning that with nowhere else to send a backup a
   * picker offers no choice. backupd#622 reverses that on purpose:
   * with the control absent there was no way to SEE where a tier's
   * backups go, so the only tier that could ever be pointed at S3 was one
   * edited outside the product, and the local hard drive is a destination
   * whether or not anything else is declared.
   *
   * The other half is this suite's own problem. The case was written as
   *
   *     await expect(tier1.getByLabel("Storage medium for tier 1")).toHaveCount(0)
   *
   * and a name-based locator asserted to be EMPTY cannot fail for the
   * reason it claims. "The control is not there" and "the control is
   * there under a different accessible name" both make that locator
   * resolve to nothing, and the case has no way to tell them apart, so it
   * went on passing through a rename of the very control it was about.
   * Its own control could not see it either: `getByLabel("Name")` names a
   * different field, which nobody had renamed. A case that stays green
   * whatever happens to the thing it is about is worse than no case,
   * because it occupies the space where a real one would go.
   *
   * So every assertion below is POSITIVE, and the picker is reached twice
   * by two independent routes: once through the DOM structure and the
   * visible label an operator reads, and once through the accessible name
   * five cases in settings-recovery.spec.ts query it by. A rename breaks
   * the second, a restructure breaks the first, and neither can pass by
   * matching nothing.
   */
  test("offers a destination picker on its one tier, on the local hard drive", async ({ bm, page }) => {
    await bm.goto("/settings");

    const tier1 = page.getByRole("group", { name: "Tier 1" });
    await expect(tier1).toBeVisible();

    // Route one: the visible label, through the DOM. The select carries
    // an aria-label of its own, which wins over the wrapping <label>, so
    // this genuinely does not go through the accessible name and is not
    // the same query twice.
    const storedOn = tier1.locator("label.field").filter({ hasText: "Stored on" }).locator("select");
    await expect(storedOn).toHaveCount(1);

    // Route two: the accessible name. This is the assertion the old case
    // had, with the count it should always have had.
    const picker = tier1.getByRole("combobox", { name: "Storage medium for tier 1" });
    await expect(picker).toHaveCount(1);

    // And they are the same control, so neither route can be satisfied by
    // some other select in the row.
    await expect(storedOn).toHaveAttribute("aria-label", "Storage medium for tier 1");

    // Where it points. A deployment that declared nothing still has one
    // destination, and the tier is on it: `local` on the wire, and the
    // words an operator reads on screen.
    await expect(picker).toHaveValue("local");
    await expect(picker.locator("option:checked")).toHaveText("Local backup root");

    // What FR-35 still gets: nothing declared means nothing to pick but
    // the drive. The one other entry is #595's named, disabled,
    // not-built row, which is not a destination this deployment has. So
    // the absence that matters here is asserted as a count over what the
    // menu offers rather than as an empty name-based locator.
    const selectable = picker.locator("option:not([disabled])");
    await expect(selectable).toHaveCount(1);
    await expect(selectable).toHaveText("Local backup root");

    // The tier really rendered, kept from the old case.
    await expect(tier1.getByLabel("Name")).toHaveValue("daily");
  });
});
