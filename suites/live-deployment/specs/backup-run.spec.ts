import { answersFor, createBackupSet, newKeyPair } from "../harness/wizard";
import { enrolAdministrator, expect, openApp, test, type Deployment } from "../harness/fixtures";

// The claim the whole suite is for: a deployment nobody had configured an
// hour ago has this machine's files on it, and they are the same bytes.
//
// Everything else here could be green against an engine that wrote
// nothing. The Backups page lists an artifact from the moment it is
// DISCOVERED, before a byte has moved; the backup set reports a state; the
// wizard reports a saved configuration. All three are the manager talking
// about itself. So the assertion that matters reads the manager's backup
// volume with a container of its own and compares each file's sha256
// against the digest the source machine itself reported for the same name
// at seeding time. scripts/e2e/two-machine-backup.sh makes exactly this
// comparison for the CLI path, and says why in one line that is worth
// repeating: a file that exists is not a backup.
//
// What this spec deliberately does not prove:
//
//   - that the Web UI can start a cycle. It cannot, on this build, and the
//     last test here pins that rather than leaving it to be discovered.
//     The cycle these assertions are about is the one the engine starts
//     for itself the moment a configuration is activated.
//   - retention, validators, quarantine, or a second cycle over the same
//     source. One pass over three files is the claim.

/** How long a first cycle gets. It is generous on purpose: the pass has to
 *  open an SSH connection, list a remote tree, pull a megabyte, verify and
 *  durably commit each artifact, and it took about twenty seconds on the
 *  machine this was written on. A budget that is too tight turns a slow
 *  host into a product failure, which is the one reading a red here must
 *  never have. */
const CYCLE_BUDGET_MS = 180_000;

/** The names on the manager's backup volume for one artifact.
 *
 *  Two files, not one: a durable commit writes a `<name>.manifest.json`
 *  sidecar next to the artifact. Naming both here is what keeps the
 *  "everything has landed" wait from being satisfied by a count.  */
function landedNames(name: string): string[] {
  return [`source/${name}`, `source/${name}.manifest.json`];
}

/** Waits until every artifact has been committed to the manager's volume.
 *
 *  The wait is on the volume rather than on the screen, and that is a
 *  choice rather than convenience: the Backups page lists an artifact as
 *  soon as it is discovered, so a page with three rows on it is not a
 *  finished cycle and gating on one would have this spec assert digests
 *  against files that are still arriving. What an operator sees is
 *  asserted too, immediately below the wait, as its own claim. */
async function waitForTheCycle(deployment: Deployment): Promise<void> {
  const wanted = deployment.source.files.flatMap((f) => landedNames(f.name));
  await expect
    .poll(async () => (await deployment.manager.backupsListing()).filter((p) => wanted.includes(p)).length, {
      message:
        "the engine never committed all three artifacts to its backup volume. What is on it, and the engine's own " +
        "log, are the two things worth reading: a cycle that ran and refused says so in the log, and a cycle that " +
        "never started says nothing at all.",
      timeout: CYCLE_BUDGET_MS,
      intervals: [1000]
    })
    .toBe(wanted.length);
}

test("a fresh deployment pulls the source machine's files, byte for byte", async ({ page, deployment }) => {
  test.setTimeout(CYCLE_BUDGET_MS + 120_000);

  await enrolAdministrator(page, deployment);
  await openApp(page, deployment);

  // The control. Nothing has been backed up, so whatever is on this volume
  // at the end got there during this test.
  //
  // It is also the check that the harness has not gone back to reading a
  // volume in a way that takes it away from the engine: this read used to
  // hand an empty backup volume to root, and every transfer afterwards
  // died on a permission error several minutes later. See READ_MOUNT in
  // harness/deployment.ts.
  expect(await deployment.manager.backupsListing(), "this deployment has backups on it before anything ran").toEqual(
    []
  );

  // The operator's own step, in the order scripts/e2e/two-machine-backup.sh
  // takes it: the manager's public key goes onto the machine being backed
  // up before the backup set is added, because a set pointed at a machine
  // that will not let it in is not a set anyone would call finished. The
  // key is minted here and its private half only ever goes into the
  // wizard's own import field.
  const key = newKeyPair();
  await deployment.source.authorizeKey(key.publicKeyLine);

  const answers = answersFor(deployment);
  await createBackupSet(page, deployment, answers, key.privateKeyPem);

  // Saving the first configuration is what starts the first cycle: the
  // host activates the new configuration in place and the scheduler's
  // first pass runs immediately rather than after the poll interval. So
  // there is nothing to press here, and the last test in this file is
  // about why there is nothing to press.
  await waitForTheCycle(deployment);

  // ------------------------------------------------------- what an operator sees
  await page.goto(`${deployment.uiUrl}/sets`);
  // The product's own verdict, which is the line an operator reads before
  // believing any of this: one set, healthy, none stale and none failing,
  // and the sentence the card gives for why.
  //
  // Read from the page header's own count rather than from the card's
  // badge: the badge's element carries a glyph beside the word, so
  // matching it means either an inexact match that also resolves to every
  // ancestor holding it, or a selector shaped around today's markup.
  await expect(page.getByText(/1 sets .* 1 healthy .* 0 stale .* 0 failing/)).toBeVisible();
  await expect(page.getByText(/a known-good backup exists/)).toBeVisible();

  await page.goto(`${deployment.uiUrl}/backups`);
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  for (const file of deployment.source.files) {
    await expect(table.getByRole("cell", { name: file.name, exact: true })).toBeVisible();
  }

  // ------------------------------------------------------- and what is on disk
  //
  // The assertion this suite exists for. Read from the manager's backup
  // volume by a container this run starts, read-only, and compared against
  // the digest the SOURCE machine reported for the same name, computed on
  // the source machine rather than by whatever wrote the file.
  for (const file of deployment.source.files) {
    const landed = await deployment.manager.backupDigest(`source/${file.name}`);
    expect(landed, `${file.name} landed on the manager with different bytes from the source's`).toBe(file.sha256);
  }

  // ------------------------------------------------------- and the source
  //
  // The machine being backed up came out of this untouched, which is the
  // posture a VPS actually wants ("pull from here, never delete here").
  //
  // Worth knowing WHY it is true here, because it is not the reason the
  // wizard offers. This set is not read-only in the configuration: that
  // declaration is dropped by the first-run save, which
  // specs/backup-set-wizard.spec.ts pins. What refused the deletion is
  // FR-16's identity recheck. The recommended account shape is a chrooted,
  // no-shell internal-sftp account, against which no hash and no stable
  // backend identifier can be computed, so the engine cannot prove the
  // remote object is still the one it copied and declines to delete it
  // rather than guessing. Its log says so per artifact.
  //
  // So this assertion holds today for a reason that would survive the
  // read-only bug being fixed, and it is the reason the two-machine
  // script's own "the source machine is untouched" check is worth having
  // on the browser path too.
  for (const file of deployment.source.files) {
    expect(
      await deployment.source.digest(file.name),
      `the source machine's own ${file.name} changed during the backup`
    ).toBe(file.sha256);
  }
});

// The run control on the backup sets page cannot start a cycle on this
// deployment, and this is here so that nobody reads the test above as
// evidence that it can.
//
// `POST /api/v1/operations` is behind `requireDestructiveGate`, and the
// generic web host sets no gate, so the route answers 403
// DESTRUCTIVE_OPERATIONS_DISABLED to every caller. rclone-manager#92 is
// the issue; suites/equivalence's DISC-007 write-up already separates this
// refusal from a missing route, and this is the same refusal reached the
// way an operator reaches it, which is by pressing the button.
//
// Pinned in both directions, like every other discrepancy in this
// repository: the day the gate is verified for this deployment shape, this
// test goes red and whoever fixed it gets to replace it with one that
// drives a cycle from the button.
test("the backup sets page offers a run control that this deployment refuses", async ({ page, deployment }) => {
  await enrolAdministrator(page, deployment);
  await openApp(page, deployment);

  const key = newKeyPair();
  await deployment.source.authorizeKey(key.publicKeyLine);
  await createBackupSet(page, deployment, answersFor(deployment), key.privateKeyPem);

  const run = page.getByRole("button", { name: "Run all due sets" });
  await expect(run).toBeEnabled();
  const [submitted] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/v1/operations") && r.request().method() === "POST"),
    run.click()
  ]);
  expect(submitted.status(), "the run control was accepted, so this deployment's destructive gate has moved").toBe(
    403
  );
  expect(await submitted.text()).toContain("DESTRUCTIVE_OPERATIONS_DISABLED");
});
