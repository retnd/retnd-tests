import { destructive, expect, needs, test } from "./fixtures";
import type { Retnd } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

/**
 * Storage destinations, in a browser: the drive this deployment's backups
 * land on as an entry of its own, the mark that says where a NEW
 * retention tier starts, and the picker under every tier in both editors.
 *
 * backupd#622 (H2.2), under EPIC H. The issue's complaint was that
 * the feature was half-built: a tier could already name a destination and
 * there was no way to pick one, the settings list showed declared S3
 * mediums only so the one destination every deployment has appeared
 * nowhere, and the same check was called "Verify" here, `preflight` on the
 * command line and "Test connection" on the source side of the same
 * product.
 *
 * # What this file needs from the deployment
 *
 * This paragraph used to open "Suite B drives the MOCK api", and
 * everything under it followed from that. It does not any more, and the
 * consequence for this file is bigger than for any other in the suite:
 * every case here is written against a CONFIGURATION, and the mock's
 * configuration was fixed. Three destinations, always: the local drive,
 * `offsite_s3` on a content class, `offsite_cold` on an archive class,
 * with a three-tier chain across them.
 *
 * A real deployment declares whatever it was configured with, and a fresh
 * one declares nothing at all: one destination, the drive, and no choice
 * to make. So each block below states the shape it needs (a content-class
 * medium and an archive-class one, declared) and reads the ids out of the
 * deployment rather than naming them. Both are two lines of configuration
 * for the topology, which is why these are stated preconditions rather
 * than mock-only.
 *
 * Two things this file still does not claim, unchanged by the move:
 *
 *   - the three local failure modes. A missing path, a directory the
 *     service user cannot write to and a filesystem with no room are told
 *     apart by WHICH STEP failed, and arranging each one means arranging a
 *     filesystem. `suites/cli/cases/medium/test-connection-local-*` drives
 *     the real binary against a real directory for each of the three.
 *
 *   - the backend's own refusals. The card hides Remove on the default
 *     rather than offering it and taking a 409, so the browser can prove
 *     the courtesy and not the gate. `MEDIUM_IS_DEFAULT` itself is
 *     `suites/cli/cases/medium/remove-refuses-the-default`.
 *
 * And one thing changed direction. What used to be an eight-step report
 * from a fixture is now an eight-step report from a real check against a
 * real endpoint, so "the report says which step failed" has stopped being
 * a claim about a renderer.
 *
 * # Where each destination's controls come from
 *
 * The card gives a row Test connection always, Make default unless it
 * already carries the mark, Edit unless it is the local drive, and Remove
 * unless it is either. Two of those absences are the invariants: the
 * local entry cannot be un-declared because it was never declared, and
 * the default cannot be removed while it carries the mark. They are
 * ABSENT rather than disabled, which is a decision the product's own doc
 * argues, so the assertions below are counts of zero against a control
 * that exists elsewhere on the same page. Every one of them has its
 * positive control in the same case.
 */

/** Every step a test connection reports, in the engine's own order. The
 *  list is here rather than inside one case because three cases assert
 *  it: what makes a report a report is that it says WHICH step failed,
 *  and a surface that collapsed it into one word would pass a check for
 *  the word. */
const REPORT_STEPS = [
  "credentials",
  "reach",
  "deliverable",
  "write",
  "read_back",
  "storage_class",
  "verification",
  "delete"
] as const;

/** The Storage destinations card on the settings page. */
const card = (page: Page) => page.getByRole("region", { name: "Storage destinations" });

/** This deployment's own declared destinations, by role.
 *
 *  These replaced the literals `offsite_s3` and `offsite_cold`. What the
 *  cases are about is the difference between a class that can take
 *  delivery and one that cannot, never those two names, and a deployment
 *  is free to call them anything. */
const contentMedium = (bm: Retnd) => bm.facts.mediums.find((m) => m.archive !== true)!;
const archiveMedium = (bm: Retnd) => bm.facts.mediums.find((m) => m.archive === true)!;

/** The precondition every block in this file shares. Stated once, and in
 *  terms of what the topology would have to declare rather than in terms
 *  of what the mock happened to. */
function needsTwoKindsOfDestination(bm: Retnd) {
  needs(
    bm.facts.mediums.some((m) => m.archive !== true) && bm.facts.mediums.some((m) => m.archive === true),
    "a deployment declaring both a content-class storage medium and an archive-class one. Every " +
      "case here turns on the difference between a destination that can take delivery and one that " +
      "cannot, and a deployment that declares nothing has one destination and no difference to draw"
  );
}

/** One destination's row, by the id it goes by. */
const row = (page: Page, id: string) => page.getByRole("group", { name: "Storage destination " + id });

/** One retention tier's row in whichever editor is open. */
const tier = (page: Page, n: number) => page.getByRole("group", { name: "Tier " + n });

/** A tier's destination picker, by the accessible name the whole suite
 *  queries it by. Positive by construction: every use below asserts
 *  something ABOUT it, so a rename is red here rather than silently
 *  matching nothing (see backups.spec.ts's own note on that shape). */
const picker = (page: Page, n: number) =>
  tier(page, n).getByRole("combobox", { name: "Storage medium for tier " + n });

/** The ids a `<select>` is currently offering, in order. Read off the
 *  option values rather than the labels, because what a tier stores is
 *  the id and a label is free to be reworded. */
async function optionValues(select: Locator): Promise<string[]> {
  return select.locator("option").evaluateAll((nodes) =>
    nodes.map((n) => (n as HTMLOptionElement).value)
  );
}

test.describe("the storage destinations list", () => {
  test.beforeEach(async ({ bm, page }) => {
    needsTwoKindsOfDestination(bm);
    await bm.goto("/settings");
    await expect(card(page)).toBeVisible();
  });

  test("leads with the drive backups land on, and names which drive that is", async ({ bm, page }) => {
    // First, not merely present. #622's words are "always carries an entry
    // for the local hard drive, showing the main drive it writes to", and
    // an entry buried under three buckets is a different answer to "where
    // do my backups go" than the first thing on the list.
    const rows = card(page).getByRole("group");
    await expect(rows.first()).toHaveAttribute("aria-label", "Storage destination local");

    // Naming the drive is the point. An entry that said only "local"
    // leaves an operator with two NAS volumes exactly as badly off as an
    // entry that was missing, which is what the issue says in as many
    // words. The path is this deployment's real backup root rather than
    // the fixture's `/data/backups`, so a card that printed a constant
    // would now fail here.
    const capacity = ((await (await bm.api.get("/api/v1/settings")).json()) as {
      capacity?: { backup_root?: string };
    }).capacity;
    expect(capacity?.backup_root, "the service reports no backup root").toBeTruthy();
    await expect(row(page, "local")).toContainText(capacity!.backup_root!);

    // And the declared ones are still there, which is the control: the
    // local entry was added to this list rather than replacing it.
    for (const medium of bm.facts.mediums) {
      await expect(row(page, medium.id)).toBeVisible();
    }
  });

  test("says the local entry is not something the configuration declares, and offers no way to edit or remove it", async ({ bm, page }) => {
    const local = row(page, "local");

    // The two absences. Both are refused by the backend as well; this is
    // the courtesy in front of that, and the reason it is an absence
    // rather than a disabled control is that there is no state an
    // operator could reach in which either would work.
    await expect(local.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(local.getByRole("button", { name: "Remove" })).toHaveCount(0);

    // The positive control for both, on the same page, in the same run:
    // a declared destination that is not the default has both buttons.
    // Without this the two counts above would be satisfied by a page that
    // failed to render any buttons at all.
    const declared = row(page, archiveMedium(bm).id);
    await expect(declared.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(declared.getByRole("button", { name: "Remove" })).toBeVisible();

    // And the row says why, rather than leaving an operator to work out
    // what would bring the missing buttons back.
    await expect(local).toContainText(/not something the configuration declares/i);
  });

  test("marks exactly one destination as the default, and says what the mark governs", async ({ bm, page }) => {
    needs(
      bm.facts.mediums.length > 0,
      "a declared destination, so a default mark is a choice rather than a foregone conclusion"
    );
    // Exactly one. A list with two defaults is a list no deployment can
    // be in, and a renderer that highlighted every row would pass a
    // "the default is visible" assertion.
    await expect(card(page).getByText("Default", { exact: true })).toHaveCount(1);
    await expect(row(page, "local").getByText("Default", { exact: true })).toBeVisible();

    // What it governs, in the words that stop somebody reading it as a
    // migration: a NEW tier starts here, nothing already somewhere moves.
    await expect(row(page, "local")).toContainText(/tier created from here on starts on this destination/i);
    await expect(row(page, "local")).toContainText(/Moving that mark moves no backup and rewrites no tier/i);
  });

  /** Moves the default mark and moves it back, which against a real
   *  deployment is a real write to the configuration both ways. It is safe
   *  to run unguarded for the reason the case itself asserts: the mark
   *  governs where a NEWLY created tier starts and nothing else, so moving
   *  it rewrites no tier and relocates no backup, and the case ends with
   *  it where it found it. The case below it, which removes a declared
   *  destination, is the one that cannot say that. */
  test("hides Remove on the destination that carries the mark, and gives it back when the mark moves", async ({ bm, page }) => {
    const other = archiveMedium(bm).id;

    // Before: a declared destination is removable and local is not, and
    // the only difference between them here is the mark.
    await expect(row(page, other).getByRole("button", { name: "Remove" })).toBeVisible();

    await row(page, other).getByRole("button", { name: "Make default" }).click();
    await expect(row(page, other).getByText("Default", { exact: true })).toBeVisible();

    // After: the same row has no Remove, and the row that lost the mark
    // has gained the "Make default" control it did not have. Both
    // directions, so this cannot pass by nothing having re-rendered.
    await expect(row(page, other).getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(row(page, "local").getByRole("button", { name: "Make default" })).toBeVisible();
    await expect(card(page).getByText("Default", { exact: true })).toHaveCount(1);

    // Give it back, and Remove comes back with it. That is the sentence
    // the refusal makes: move the mark first, then remove. It is also this
    // case putting the deployment back the way it found it.
    await row(page, "local").getByRole("button", { name: "Make default" }).click();
    await expect(row(page, other).getByRole("button", { name: "Remove" })).toBeVisible();
  });

  test("moving the mark rewrites no tier", async ({ bm, page }) => {
    // The whole content of "default" is where the NEXT tier starts, and
    // the failure this guards against is a settings word that quietly
    // relocates backups. The chain before and after has to be the same
    // chain, which is checked by reading the pickers rather than by
    // trusting a toast.
    //
    // The old version pinned the fixture's chain, `["local", "local",
    // "offsite_s3"]`, before comparing. That literal was never the claim:
    // whatever this deployment's chain is, moving the mark must not touch
    // it. What the literal did buy is a premise, that there was a chain to
    // read at all, and that is kept as a count.
    const tiers = await card(page).page().getByRole("group", { name: /^Tier \d+$/ }).count();
    expect(tiers, "no retention tiers to read").toBeGreaterThan(0);
    const indices = Array.from({ length: tiers }, (_, i) => i + 1);

    const before = await Promise.all(indices.map((n) => picker(page, n).inputValue()));
    const target = contentMedium(bm).id;

    await row(page, target).getByRole("button", { name: "Make default" }).click();
    await expect(row(page, target).getByText("Default", { exact: true })).toBeVisible();

    const after = await Promise.all(indices.map((n) => picker(page, n).inputValue()));
    expect(after).toEqual(before);

    // And back, so the deployment the next spec reads is the one this
    // found.
    await row(page, "local").getByRole("button", { name: "Make default" }).click();
    await expect(row(page, "local").getByText("Default", { exact: true })).toBeVisible();
  });

  test("cannot be emptied, whatever an operator removes", async ({ bm, page }) => {
    // Removes a declared destination from the configuration, for real, and
    // nothing here puts it back: this is the one case in the file that
    // changes what every later spec is looking at.
    destructive();
    // #622's second invariant ("there is never zero destinations") as far
    // as a browser can reach it: not that the engine refuses an empty
    // list, but that no sequence of clicks on this card produces one.
    //
    // Three destinations, three different reasons the list survives, and
    // each one is exercised rather than argued:

    // One removal really works, so nothing below passes because Remove is
    // broken.
    await row(page, archiveMedium(bm).id).getByRole("button", { name: "Remove" }).click();
    await expect(row(page, archiveMedium(bm).id)).toHaveCount(0);

    // The second is refused, by the rule that predates this issue: copies
    // are recorded there, and un-declaring it would leave this deployment
    // with no way to reach them (FR-30, backupd#594). The refusal
    // stays a refusal, which #622 says explicitly it is not replacing.
    const holdsCopies = contentMedium(bm).id;
    await row(page, holdsCopies).getByRole("button", { name: "Remove" }).click();
    await expect(row(page, holdsCopies)).toContainText(/still holds copies/i);
    await expect(row(page, holdsCopies)).toBeVisible();

    // The third has no Remove at all, and that is the new part: the drive
    // is not declared, so there is nothing to un-declare.
    await expect(row(page, "local").getByRole("button", { name: "Remove" })).toHaveCount(0);

    // So the list still has the drive, still has exactly one default, and
    // the card's own "no destinations at all" hole stays unreachable. That
    // paragraph exists in the product as a deliberate dead end; a run that
    // reached it would mean the invariant had gone.
    await expect(row(page, "local")).toBeVisible();
    await expect(card(page).getByText("Default", { exact: true })).toHaveCount(1);
    await expect(card(page)).not.toContainText(/reports no storage destinations at all/i);
  });

  test("calls the check Test connection, and runs it on the local drive rather than greying it out", async ({ page }) => {
    // Against the deployment's own backup root now, which is the part the
    // header used to say Suite B could not have: the eight steps below are
    // a real check answering about a real directory.
    // The naming half of the issue. "Verify" was this card's word for the
    // same question the source side of this product calls "Test
    // connection", and one operator learning two words for one button is
    // the whole complaint.
    await expect(card(page).getByRole("button", { name: "Verify" })).toHaveCount(0);
    await expect(row(page, "local").getByRole("button", { name: "Test connection" })).toBeEnabled();

    // The local drive has something to test, which is the part that did
    // not exist: a local destination can be missing, unwritable or full.
    // What is asserted here is that the button ANSWERS for it, per step,
    // in the same report every other destination gets. Which step fails
    // for which reason is a claim about a real filesystem and lives in
    // Suite A (see this file's header).
    await row(page, "local").getByRole("button", { name: "Test connection" }).click();

    // Never one word. A report collapsed into OK or FAILED throws away
    // the diagnosis, which is why the renderer draws EVERY step in the
    // engine's own order, skipped ones included, and why this asserts all
    // of them rather than a verdict.
    for (const step of REPORT_STEPS) {
      await expect(row(page, "local").getByText(step, { exact: true })).toBeVisible();
    }
  });

  test("echoes the command each control is equivalent to, under the button that produces it", async ({ bm, page }) => {
    // EPIC G's standing rule, applied to the two verbs #622 adds. The
    // local row prints the test-connection line and the line that would
    // move the mark, and prints neither `medium show local` nor `medium
    // remove local`, because a row that taught a command the engine
    // refuses would be worse than a row that taught none.
    const local = row(page, "local");
    await expect(local).toContainText("retnd medium test-connection local");
    await expect(local).not.toContainText("retnd medium remove local");

    await expect(row(page, contentMedium(bm).id)).toContainText(
      "retnd medium default " + contentMedium(bm).id
    );
    // And the destination that already carries the mark does not print a
    // line that would change nothing.
    await expect(local).not.toContainText("retnd medium default local");
  });
});

test.describe("picking a destination under a retention tier", () => {
  test.beforeEach(async ({ bm, page }) => {
    needsTwoKindsOfDestination(bm);
    await bm.goto("/settings");
    await expect(tier(page, 1)).toBeVisible();
  });

  test("gives every tier a picker, each one showing where that tier's backups actually go", async ({ bm, page }) => {
    // Every tier, not only the ones pointed somewhere unusual. The
    // failure this replaces is a form where the two local tiers had no
    // control at all, so there was no way to read where they wrote and no
    // way to move them.
    //
    // Each picker's value is checked against what the SERVICE says that
    // tier's destination is, rather than against the fixture's chain. That
    // is a stronger claim than the three literals it replaces: a form
    // rendering a plausible default instead of the configured value would
    // have satisfied them on the mock and fails here.
    const settings = (await (await bm.api.get("/api/v1/settings")).json()) as {
      retention?: { tiers?: Array<{ medium?: string }> };
    };
    const tiers = settings.retention?.tiers ?? [];
    expect(tiers.length, "the service reports no retention tiers").toBeGreaterThan(0);

    for (let n = 1; n <= tiers.length; n++) {
      await expect(picker(page, n)).toHaveValue(tiers[n - 1].medium || "local");
    }

    // The drive comes off the served list rather than being a literal
    // option, so it is named once for every surface. Reading the values
    // proves the local row is a destination in the menu and not a
    // hard-coded "" the tier means by pointing nowhere.
    expect(await optionValues(picker(page, 1))).toContain("local");
  });

  /**
   * What this case does NOT claim, said out loud rather than left for
   * somebody to assume from the name.
   *
   * #622's default governs where a NEWLY CREATED tier starts. Proving
   * that in a browser needs the mark to be somewhere other than the
   * drive, and half of what stopped this suite from getting it there has
   * gone: a page reload no longer builds a fresh in-memory mock, so a
   * default moved on the destinations card now survives one.
   *
   * The other half is still there and is a real finding rather than a
   * fixture artefact: moving the mark reloads that card's own list and
   * nothing tells the retention editor beside it, so a tier added straight
   * afterwards still starts on whatever was the default when the page
   * loaded (`findings/DISC-009.md`). It is not worked around here. When
   * somebody closes it, the case this comment is attached to is the one
   * that grows the assertion, against a real deployment.
   *
   * What IS asserted is the half that a browser can see and that the pin
   * gets wrong: a tier created here names a destination, by id, at the
   * moment it appears. Before #622 a new tier's draft carried "" and the
   * picker rendered blank-to-local, which is the two-spellings problem
   * arriving in a form.
   */
  test("gives a newly added tier a destination of its own, named rather than left empty", async ({ page }) => {
    // Nothing is saved, so nothing has to be put back: Add tier edits the
    // draft, and this case never presses Save.
    const existing = await page.getByRole("group", { name: /^Tier \d+$/ }).count();
    const before = await Promise.all(
      Array.from({ length: existing }, (_, i) => picker(page, i + 1).inputValue())
    );

    await page.getByRole("button", { name: "Add tier" }).click();

    const added = existing + 1;
    await expect(picker(page, added)).toHaveCount(1);
    await expect(picker(page, added)).toHaveValue("local");
    await expect(picker(page, added).locator("option:checked")).toHaveText("Local backup root");

    // And it did not disturb the chain it was appended to, whatever that
    // chain was.
    const after = await Promise.all(
      Array.from({ length: existing }, (_, i) => picker(page, i + 1).inputValue())
    );
    expect(after).toEqual(before);
  });

  test("tests the connection to a tier's destination without leaving the tier", async ({ page }) => {
    // The point of putting a picker here rather than sending somebody to
    // the settings card and back: a destination chosen under a tier needs
    // the same proof before it is trusted, and a detour to run it is a
    // detour most people will not take.
    const row1 = tier(page, 1);
    await row1.getByRole("button", { name: "Test connection" }).click();

    await expect(row1.getByText(/This destination is ready for a backup/i)).toBeVisible();
    for (const step of REPORT_STEPS) {
      await expect(row1.getByText(step, { exact: true })).toBeVisible();
    }
  });

  test("reports a destination that is not ready without refusing the save", async ({ bm, page }) => {
    // The archive class this deployment declares cannot take delivery at all,
    // and the report says so at the step that decides it. What matters
    // as much is the second sentence: the check is offered and never
    // required, because an operator who is about to fix the bucket, or
    // who knows something this check does not, is not served by a form
    // that refuses.
    await picker(page, 1).selectOption(archiveMedium(bm).id);
    await expect(picker(page, 1)).toHaveValue(archiveMedium(bm).id);

    const row1 = tier(page, 1);
    await row1.getByRole("button", { name: "Test connection" }).click();
    await expect(row1.getByText(/This destination is not ready/i)).toBeVisible();
    await expect(row1.getByText(/Saving is still allowed/i)).toBeVisible();
  });

  test("echoes the command that moves this one tier, with the acknowledgment the server demands", async ({ bm, page }) => {
    // The line an operator pastes has to be the line that works. A tier
    // moving off the local drive for the first time is refused without
    // --acknowledge-medium-disclosure, so the echo carries it; a tier
    // moving BACK to the drive discloses nothing and the flag would be
    // refused as acknowledging a write that needs no acknowledgment.
    const tierName = await tier(page, 1).getByLabel("Name").inputValue();
    const away = contentMedium(bm).id;

    await picker(page, 1).selectOption(away);
    await expect(tier(page, 1)).toContainText(
      "retnd settings patch --tier-medium " + tierName + "=" + away + " --acknowledge-medium-disclosure"
    );

    await picker(page, 1).selectOption("local");
    await expect(tier(page, 1)).toContainText("retnd settings patch --tier-medium " + tierName + "=local");
    await expect(tier(page, 1)).not.toContainText(
      "--tier-medium " + tierName + "=local --acknowledge-medium-disclosure"
    );
  });

  /**
   * Inline create, driven as far as this fixture can be driven, and the
   * stop is a finding rather than a shortcut.
   *
   * #622 asks for a destination made "without leaving the tier", and for
   * the check to be reachable "including for a destination just created
   * there". Everything up to and including that check is asserted below.
   *
   * The Save that follows still is not, and the reason changed with the
   * backend. It used to be `createMockApi`'s candidate check handing its
   * own `archive` boolean to the report builder's `deliverable`
   * parameter, which reported a STANDARD-class candidate as unable to
   * take delivery (`findings/DISC-008.md`). That fixture is gone. What
   * stops it now is that saving here DECLARES a storage destination on
   * the deployment every other spec is reading, permanently, and the
   * candidate would have to be a bucket somebody really owns. The check
   * against it is real, which is the half this case is about; declaring
   * it is the topology's call rather than this suite's.
   */
  test("opens a destination wizard inside the tier, and tests the candidate from there", async ({ bm, page }) => {
    const row1 = tier(page, 1);
    await row1.getByRole("button", { name: "Add a destination" }).click();

    // Inside the tier, which is the whole point: the alternative an
    // operator had was a detour to the settings page and back, and a
    // detour is what most people will not take.
    const wizard = row1.getByRole("group", { name: "Add a destination" });
    await expect(wizard).toBeVisible();

    // An id nothing on this deployment uses, so the candidate cannot
    // collide with a declared destination, and nothing is saved anyway.
    await wizard.getByLabel("Destination id").fill("nearline_eu");
    await wizard.getByLabel("Bucket").fill("nas-nearline");
    await wizard.getByRole("button", { name: "Next: credentials" }).click();

    // The credential is a REFERENCE and never material, which is what
    // lets this case exist at all: nothing here types a key, and the
    // environment-variable mode names a variable rather than carrying a
    // value.
    await wizard.locator("label").filter({ hasText: "An environment variable" }).getByRole("radio").check();
    await wizard.getByLabel("Environment variable name").fill("NEARLINE_EU_CREDENTIALS");
    await wizard.getByRole("button", { name: "Next: test connection" }).click();

    // The check ran here, on the candidate, per step, under the name the
    // rest of the product now uses. Whether it passed is the fixture's
    // business and DISC-008's; that it is the same report and reachable
    // from a tier is this case's.
    for (const step of REPORT_STEPS) {
      await expect(wizard.getByText(step, { exact: true })).toBeVisible();
    }
    await expect(wizard).toContainText(
      "retnd medium test-connection --candidate nearline_eu"
    );
    await expect(wizard.getByRole("button", { name: "Test connection again" })).toBeVisible();
    await expect(wizard.getByRole("button", { name: "Verify" })).toHaveCount(0);

    // Nothing was written by any of it, which against a real deployment
    // is a claim worth making twice: once on the page, and once against
    // the service that would be holding it.
    await expect(row(page, "nearline_eu")).toHaveCount(0);
    const settings = (await (await bm.api.get("/api/v1/settings")).json()) as {
      mediums?: Array<{ id: string }>;
    };
    expect((settings.mediums ?? []).map((m) => m.id)).not.toContain("nearline_eu");
  });
});

test.describe("a backup set's own retention policy", () => {
  test.beforeEach(async ({ bm, page }) => {
    needsTwoKindsOfDestination(bm);
    needs(bm.facts.sets.length > 0, "at least one backup set, so there is a per-set policy to open");
    await bm.goto("/sets");
    await page.getByRole("article").first().getByRole("button", { name: "Open" }).click();
    await page.getByRole("button", { name: /own policy|Edit this set's policy/ }).click();
    await expect(tier(page, 1)).toBeVisible();
  });

  test("offers the same picker under each of its tiers", async ({ bm, page }) => {
    // #622 asks for the picker "in both places a tier is edited", and a
    // per-set override is a whole chain that can name a destination per
    // tier exactly as the deployment's own policy can. This is the second
    // editor, reached the way an operator reaches it.
    await expect(picker(page, 1)).toHaveCount(1);
    await expect(picker(page, 1)).toHaveValue("local");
    expect(await optionValues(picker(page, 1))).toEqual(
      expect.arrayContaining(["local", ...bm.facts.mediums.map((m) => m.id)])
    );
  });

  test("tests a tier's destination from inside the set's own policy", async ({ page }) => {
    const row1 = tier(page, 1);
    await row1.getByRole("button", { name: "Test connection" }).click();
    for (const step of REPORT_STEPS) {
      await expect(row1.getByText(step, { exact: true })).toBeVisible();
    }
  });

  test("keeps the deployment-wide disclosure in front of the first tier this set sends away", async ({ bm, page }) => {
    // The picker being here does not weaken FR-27's consent gate: it is
    // the same panel, in front of the same write, and this is the case
    // that says adding a control did not quietly remove one. Nothing is
    // saved: the panel appearing is the whole assertion.
    await picker(page, 1).selectOption(contentMedium(bm).id);
    const panel = page.getByRole("group", { name: "Storage medium disclosure" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/I delete the copy on this machine/i);
  });
});
