import { CONTENT_COLUMN, expect, needs, test } from "./fixtures";
import { NEEDS_SOURCE, acknowledge, fillSource, proveConnection, rail, reachReview } from "./wizard-steps";

/**
 * The add-backup-set wizard, against a real deployment.
 *
 * Most of this file is about a FORM: how many steps it has, which one is
 * current, what each panel offers, which controls a missing precondition
 * disables, and what the Review step discloses. None of that reads the
 * catalogue, so it all came through the move as it was, and several cases
 * got sharper rather than weaker. "Importing a key never leaves the pasted
 * material on screen" is now a claim about a real key store rather than
 * about a fixture that never stored anything.
 *
 * Three groups needed more than a form:
 *
 *  - step 2's managed-key panel lists the keys THIS DEPLOYMENT holds
 *    (GET /ssh-keys, backupd#592). The mock served two, one of them
 *    needing a passphrase, each with a "Used by" line naming a set. A
 *    fresh deployment holds none, so those cases say what a full listing
 *    would need.
 *
 *  - step 3 probes a REAL host and step 6's Test connection makes a REAL
 *    connection (#596, #624). Against the mock both were fixtures that
 *    always succeeded, which is why the six named outcomes could be
 *    asserted in one go. Against a deployment they need a machine that
 *    actually answers, which is the source container the topology stands
 *    up, named through RETND_VPS_HOST.
 *
 *  - the case that SAVES creates a backup set on the deployment every
 *    later spec is reading, and there is no undo in this suite. It needs
 *    the same real source, and it is the reason the source variables
 *    exist at all.
 */

test.describe("add backup set wizard", () => {
  test.beforeEach(async ({ bm, page }) => {
    await bm.goto("/sets");
    await page.getByRole("button", { name: "Add backup set" }).click();
    await expect(bm.heading("Add backup set")).toBeVisible();
  });

  // Six until #788, eight since: Authentication and Verify server became
  // one Connection test step, and Engine, Repository, Consistency,
  // Verification and Retention took the place of Discovery and "Storage &
  // validation". The rail is the contract an operator navigates by, so the
  // names are pinned, not just the count.
  test("groups the flow into exactly eight steps", async ({ page }) => {
    const steps = page.getByRole("listitem");
    await expect(steps).toHaveCount(8);
    const labels = ["Source", "Connection test", "Engine", "Repository", "Consistency", "Verification", "Retention", "Review"];
    for (const label of labels) {
      await expect(rail(page, label)).toBeVisible();
    }
    // And in this order: a rail that lists the right names shuffled would
    // teach the wrong dependency between them.
    await expect(steps).toHaveText(labels.map((label) => new RegExp(label)));
  });

  test("marks the current step and advances with Continue", async ({ page }) => {
    await expect(rail(page, "Source")).toHaveAttribute("aria-current", "step");
    await expect(page.getByText("Step 1 of 8")).toBeVisible();
    // #864 gates Continue on the step's own answers. Step 1 ships with
    // every answer it needs (a name, a host, a user, a port and a folder),
    // so it is enabled here; the next case is about it being refused.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Step 2 of 8")).toBeVisible();
    // exact: true: "← Cancel and return to backup sets" also contains
    // "back" (as a substring of "backup"), so a non-exact match is ambiguous
    // once that cancel link and the step-nav "Back" button are both present.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByText("Step 1 of 8")).toBeVisible();
  });

  test("Continue waits for the step's answers, and the rail will not skip past them", async ({ page }) => {
    await page.getByLabel("Server hostname").fill("");
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
    await expect(rail(page, "Connection test")).toBeDisabled();
    await page.getByLabel("Server hostname").fill("somewhere.internal");
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  test("Back is disabled on the first step and Continue on the last", async ({ deployment, page }) => {
    needs(deployment.source !== null, NEEDS_SOURCE);
    // exact: true: see the comment in the previous test.
    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
    await reachReview(page, deployment.source!);
    await expect(page.getByText("Step 8 of 8")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  test("step 1 collects source connection details", async ({ page }) => {
    for (const label of ["Backup set name", "Server hostname", "SSH port", "Username"]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test("step 2 offers three key sources, and Generate says plainly it can't be saved yet (backupd#299)", async ({ page }) => {
    await rail(page, "Connection test").click();
    await expect(page.getByRole("radio")).toHaveCount(3);
    await expect(page.getByText("Generate dedicated SSH key")).toBeVisible();
    await expect(page.getByText(/never displayed/)).toBeVisible();
    // Generate used to show a fixed sample public key (never actually
    // generated per set) with a "Copy public key" button, and an
    // authorized_keys instruction that always named "backup-agent"
    // regardless of the username entered on step 1. Neither key source
    // other than Import can be saved (handleSave/saveHint refuse both),
    // so the panel now says that plainly instead of inventing detail for
    // a path that can never be saved.
    //
    // Scoped to the page body: the terminal dock beside it keeps every
    // connection test this deployment has run, and a passing test's own
    // advice ("the string that has to appear in authorized_keys") is
    // legitimately in it. The claim is about what THIS panel invents.
    const body = page.locator(CONTENT_COLUMN);
    await expect(body.getByText(/Generating a key on save isn.t available yet/)).toBeVisible();
    await expect(body.getByText(/^ssh-ed25519 AAAA/)).toHaveCount(0);
    await expect(body.getByRole("button", { name: "Copy public key" })).toHaveCount(0);
    await expect(body.getByText(/authorized_keys/)).toHaveCount(0);
    // The step's own copy legitimately says "Private keys stay on this NAS
    // and are never shown" — a bare /PRIVATE KEY/i match flags that
    // sentence as a false positive. Match the actual PEM marker instead
    // (same pattern safety-invariants.spec.ts uses for a real key leak).
    expect(await page.locator("body").innerText()).not.toMatch(/BEGIN (OPENSSH|RSA|EC) PRIVATE KEY/i);
  });

  test("step 2's Use managed key panel lists the keys this deployment holds and lets one be picked, still with no fabricated in-use count (backupd#299)", async ({ bm, page }) => {
    // "The keys this deployment holds" is finally literal. The mock served
    // two, permanently, one of them needing a passphrase and each carrying
    // a "Used by" line; a real deployment holds whatever has been imported
    // into it, and a fresh one holds nothing. So the premise is read off
    // GET /ssh-keys rather than assumed, and the case says what a full
    // listing needs: at least two keys, one of them locked, and more than
    // one of them in use by a named set.
    const keys = ((await (await bm.api.get("/api/v1/ssh-keys")).json()) as {
      keys?: Array<{ needs_passphrase?: boolean; used_by?: unknown[] }>;
    }).keys ?? [];
    needs(
      keys.length > 1,
      "more than one SSH key in this deployment's key store. Everything below is about telling two " +
        "keys apart by fingerprint, so one key cannot show it and none cannot show anything"
    );

    await rail(page, "Connection test").click();
    await page.getByRole("radio", { name: /Use managed key/ }).click();

    // This test used to assert a refusal, "Reusing a managed key on save
    // isn't available yet", and that was the right thing to assert for
    // one reason that has stopped being true.
    //
    // #299 found a picklist here of two hardcoded key names and an
    // "Already installed on 2 other backup sets" count with no store
    // behind either, and stripped the panel down to that one sentence.
    // What made a real picklist impossible then was that nothing could
    // list the keys this deployment holds: an id came back once from the
    // import and was never shown again. backupd#592 added GET
    // /ssh-keys, so the radio has a real listing behind it and can be
    // saved, and the honest assertion is the listing rather than the
    // refusal it replaced.
    //
    // What does NOT come back with the panel is the fabrication, and that
    // half of #299 is at the bottom of this test. Also gone from here is
    // a zero on getByLabel("Managed key"), which pinned the absence of
    // the removed <select>. That was about the shape of a control with
    // nothing behind it; the picker is asserted positively below, and
    // which element it is built from was never what #299 was about.

    // A key row is a button carrying a fingerprint, which is also what
    // makes it worth showing: the fingerprint is the operator's only way
    // to tell two of these apart. Located that way rather than by
    // aria-pressed, which the activity toolbar's own filter buttons carry
    // too and which would fold them into this count.
    const rows = page.getByRole("button").filter({ hasText: /SHA256:/ });
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBeGreaterThan(1);

    // Each row answers the three things a listing is asked for: which
    // algorithm, when the key arrived, and which key it actually is.
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText(/ssh-\S+, imported \d{4}-\d{2}-\d{2}/);
      await expect(rows.nth(i)).toContainText(/SHA256:[A-Za-z0-9+/=]{20,}/);
    }

    // One can be picked, and none is picked for the operator before they
    // pick it. The zero comes first deliberately: a build that
    // pre-selected a key would satisfy "exactly one is pressed" on its
    // own, and picking a credential for somebody is not a default this
    // wizard gets to have.
    const picked = page.locator('button[aria-pressed="true"]').filter({ hasText: /SHA256:/ });
    await expect(picked).toHaveCount(0);
    await rows.first().click();
    await expect(rows.first()).toHaveAttribute("aria-pressed", "true");
    await expect(picked).toHaveCount(1);

    // A key the deployment holds and cannot offer is listed and refused,
    // not hidden. An operator hunting for a key they know they imported
    // has to find it and then be told why it is not on offer, which is
    // the same rule the import path already applies to a passphrase it
    // cannot resolve.
    const locked = rows.filter({ hasText: /Needs its passphrase/ });
    if ((await locked.count()) > 0) {
      await expect(locked.first()).toBeDisabled();
    }

    // The half of #299 that still matters. The count it was filed about
    // was fabricated: nothing read the store, so "Already installed on 2
    // other backup sets" said two on a deployment with none. What is
    // there now names the sets, which is a claim a reader can go and
    // check on the sets page, and an anonymous count must not come back.
    await expect(page.getByText(/other backup sets/i)).toHaveCount(0);
    await expect(page.getByText(/Already installed on/i)).toHaveCount(0);

    // Control for those two zeros, and the sharper half of them. Usage IS
    // stated, it is just stated by naming sets, and no two rows state the
    // same thing. That last part is not decoration: a set points at one
    // key, so two keys can never share a user, and one sentence repeated
    // down the list is exactly what the fabricated count looked like.
    const usedBy = (await rows.filter({ hasText: /Used by / }).allInnerTexts())
      .map((row) => (row.split("\n").find((line) => line.startsWith("Used by ")) ?? "").trim());
    needs(
      usedBy.length > 1,
      "more than one key already in use by a backup set. That is what makes the repeated-sentence " +
        "check possible: a set points at one key, so two keys can never share a user, and one " +
        "sentence repeated down the list is exactly what the fabricated count looked like"
    );
    for (const line of usedBy) expect(line).toMatch(/^Used by \S+\/\S+/);
    expect(new Set(usedBy).size).toBe(usedBy.length);

    // This panel renders material out of the key store now, so the PEM
    // marker check the Generate test above carries belongs here too.
    // Matched on the marker and not /private key/i, because the step's own
    // copy legitimately says private keys are never shown.
    expect(await page.locator("body").innerText()).not.toMatch(/BEGIN (OPENSSH|RSA|EC) PRIVATE KEY/i);
  });

  /** Step 3 opens a real outbound connection now (POST
   *  /ssh/host-key-probe, which "trusts nothing" in the contract's own
   *  words), so the fingerprint on screen is the source machine's real
   *  one and trusting it really pins a known_hosts line. Against the mock
   *  it was a fixture string and "Trust host" wrote nothing anywhere. */
  test("step 2 requires an explicit trust decision", async ({ deployment, page }) => {
    needs(
      deployment.source !== null,
      "a source machine this deployment can really reach, named through RETND_VPS_HOST / " +
        "RETND_VPS_USER / RETND_VPS_PATH. The mock answered every probe and every " +
        "connection test with a fixture; a real probe opens a real outbound connection, so the " +
        "wizard's built-in example hostname resolves to nothing and the step correctly fails"
    );
    await fillSource(page, deployment.source!);
    await rail(page, "Connection test").click();
    // Scoped to the page body for the reason the Generate case gives: the
    // terminal dock logs earlier connection tests, fingerprints included.
    const body = page.locator(CONTENT_COLUMN);
    await expect(body.getByText("Algorithm")).toBeVisible();
    await expect(body.getByText(/SHA256:/).first()).toBeVisible();
    await expect(body.getByText("Not yet trusted")).toBeVisible();

    const trust = page.getByRole("button", { name: "Trust host" });
    await expect(trust).toBeEnabled();
    await trust.click();
    await expect(page.getByRole("button", { name: "Host trusted" })).toBeDisabled();
  });

  test("step 2 warns what a future host-key change will do", async ({ page }) => {
    // The warning is the step's own copy and is on screen before any
    // probe, so this one needs no reachable host.
    await rail(page, "Connection test").click();
    await expect(page.getByText(/stops all backup operations for the set/)).toBeVisible();
    await expect(page.getByText(/blocks remote artifact deletion/)).toBeVisible();
  });

  // Completion methods are the artifact engine's branch of step 6 now,
  // Verification: Discovery was deleted by #788 and its radios moved here.
  test("step 6 separates recommended from advanced completion methods", async ({ deployment, page }) => {
    needs(deployment.source !== null, NEEDS_SOURCE);
    await proveConnection(page, deployment.source!);
    await rail(page, "Verification").click();
    await expect(page.getByText("Recommended")).toBeVisible();
    await expect(page.getByText("Advanced")).toBeVisible();
    await expect(page.getByRole("radio", { name: /Atomic rename/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Completion marker/ })).toBeChecked();
  });

  test("step 6 warns when completion is inferred", async ({ deployment, page }) => {
    needs(deployment.source !== null, NEEDS_SOURCE);
    await proveConnection(page, deployment.source!);
    await rail(page, "Verification").click();
    await expect(page.getByText(/infers completion/)).toHaveCount(0);

    await page.getByRole("radio", { name: /Stable file size/ }).click();
    await expect(
      page.getByText(/infers completion and provides less assurance than a producer-provided completion marker/)
    ).toBeVisible();
  });

  test("step 7 no longer draws its own per-set retention fields (backupd#299)", async ({ deployment, page }) => {
    needs(deployment.source !== null, NEEDS_SOURCE);
    await proveConnection(page, deployment.source!);
    await rail(page, "Retention").click();
    // Daily/Weekly/Monthly/Week-starts and their own always-checked
    // "protect newest known-good" toggle used to sit here, drawing a
    // per-set retention shape #111 already decided against: retention is
    // one global policy, configured once on Settings
    // (RetentionPolicyCard, #140), and #111 specifically warned this
    // per-set shape must not be mistaken for a capability.
    // exact, for the same reason the managed-key assertion above is: these
    // are absence claims spelled with the shortest words this product's own
    // vocabulary reuses everywhere. "Week starts" is already a live
    // substring of RetentionPolicyCard's "Week starts on", so the moment
    // anything renders that field into the same DOM these go red without a
    // regression. Exact still catches what they exist to catch: the removed
    // fields' labels were these strings whole, which is why the upstream
    // unit test asserts their absence with getByLabelText, exact by default.
    await expect(page.getByLabel("Daily", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Weekly", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Monthly", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Week starts", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: /Protect newest known-good/ })).toHaveCount(0);
  });

  test("step 6 lists the two validation layers that still exist, and no longer the fake Checksum toggle (backupd#299)", async ({ deployment, page }) => {
    needs(deployment.source !== null, NEEDS_SOURCE);
    await proveConnection(page, deployment.source!);
    await rail(page, "Verification").click();
    const transferVerification = page.getByRole("checkbox", { name: /Transfer verification/ });
    await expect(transferVerification).toBeChecked();
    // Unconditional server-side (no field anywhere can turn it off), so
    // it stays, but disabled now: an honest status, not a control.
    await expect(transferVerification).toBeDisabled();
    // newBackupSetFor (core/service/backupsets.go) sets Hash: ""
    // unconditionally on every set this wizard creates — there was never
    // a field for this toggle to write to, and wiring it would offer a
    // choice that fails every artifact on the recommended, chrooted
    // no-shell SFTP account shape (proven by TestSFTPHashCapability).
    await expect(page.getByRole("checkbox", { name: /Checksum verification/ })).toHaveCount(0);
    // exact: the string lived in Toggle's own note <span>, whose whole text
    // was "SHA-256", so equality still catches it coming back. Substring
    // would additionally match any longer hash copy this page grows later.
    await expect(page.getByText("SHA-256", { exact: true })).toHaveCount(0);

    // The third layer stopped being a checkbox in #164, which replaced the
    // decorative "Application validation" toggle with a real picklist over
    // the backend's registered catalog (GET /api/v1/validators). It is a
    // combobox now, so the old getByRole("checkbox") matched nothing and
    // this assertion could only ever time out.
    const validator = page.getByRole("combobox", { name: /Application validation/ });
    // Enabled is the real signal that the catalog fetch settled:
    // BackupSetWizardPage disables the picklist while validatorCatalog is
    // null and leaves it disabled if the fetch failed. Waiting on that
    // instead of a sleep also means a catalog that never loads fails here
    // rather than passing on an empty list.
    await expect(validator).toBeEnabled();
    // Off by default: transfer verification is on unconditionally,
    // application validation is opt-in. "and checksum" dropped from this
    // option's own text by backupd#299, alongside the Checksum
    // verification toggle above: Hash: "" means checksum verification
    // never actually runs, so the old wording claimed a step that
    // doesn't happen.
    await expect(validator).toHaveValue("");
    const options = validator.getByRole("option");
    await expect(options.first()).toHaveText("None (transfer verification only)");
    // ...and the choices below it are the backend's catalog rather than a
    // hardcoded list. A count alone cannot show that: two literal <option>
    // elements satisfy `> 1` identically, which is exactly the shape #164
    // removed, and with one entry in the mock catalog it also sat on its
    // own boundary. So the count stays only as a lower bound, and an id the
    // fixture actually serves has to be among the choices. Containment
    // rather than equality, so adding a validator to the mock does not turn
    // this red; renaming trailer-marker does, which is the point.
    expect(await options.count()).toBeGreaterThan(1);
    // The option labels are the ids themselves (BackupSetWizardPage renders
    // v.id, since the id is what gets saved). Safe to read without a manual
    // wait: toBeEnabled() above already proved the fetch settled, and this
    // is a retrying assertion regardless.
    await expect(validator.getByRole("option", { name: "trailer-marker", exact: true })).toHaveCount(1);
  });

  test("step 8 summarises source, destination and validation, and no longer a hardcoded retention card (backupd#299)", async ({ deployment, page }) => {
    needs(deployment.source !== null, NEEDS_SOURCE);
    await reachReview(page, deployment.source!);
    for (const label of ["Source", "Destination", "Validation"]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
    // This card used to show a hardcoded "7 daily / 13 weekly / 12
    // monthly" summarizing fields step 5 no longer draws — retention is
    // one global policy now (Settings), not something this wizard's
    // Review step reports per set. "SHA-256" is gone from the Validation
    // card for the same reason as the Checksum verification toggle.
    // All exact, matching "Retention" which already was: Summary renders
    // each line in its own <div> whose whole text is the line, so equality
    // catches every one of these coming back while substring would also
    // match longer copy that merely mentions them.
    // One match is the rail's own "Retention" step, and it is the control
    // for this zero: the same query finds the label that really is there,
    // so a Review card that grew a Retention summary would make it two.
    await expect(page.getByText("Retention", { exact: true })).toHaveCount(1);
    await expect(page.getByText("7 daily", { exact: true })).toHaveCount(0);
    await expect(page.getByText("13 weekly", { exact: true })).toHaveCount(0);
    await expect(page.getByText("12 monthly", { exact: true })).toHaveCount(0);
    await expect(page.getByText("SHA-256", { exact: true })).toHaveCount(0);
  });

  // Not on Review any more: step 7 owns the acknowledgement and the
  // sentence that explains what it is acknowledging.
  test("step 7 discloses remote-source handling in full", async ({ deployment, page }) => {
    needs(deployment.source !== null, NEEDS_SOURCE);
    await proveConnection(page, deployment.source!);
    await rail(page, "Retention").click();
    await expect(page.getByText("Remote source handling").first()).toBeVisible();
    await expect(
      page.getByText(/transferred, verified, durably committed to this NAS, and recorded as safe/)
    ).toBeVisible();
    await expect(page.getByText("Remote artifact deleted")).toBeVisible();
  });

  // The acknowledgement is step 7's, and the rail enforces it: Review is
  // not reachable until it is checked (or the source is read-only, which
  // leaves nothing to acknowledge deleting). So "saving is blocked until"
  // is a claim about the rail's Review button first and the Save buttons
  // second.
  test("saving is blocked until the acknowledgement is checked", async ({ deployment, page }) => {
    needs(deployment.source !== null, NEEDS_SOURCE);

    // Every OTHER save precondition is satisfied first (key, trusted host,
    // a proven connection), so this isolates the acknowledgement checkbox
    // as the one variable under test.
    await proveConnection(page, deployment.source!);
    await rail(page, "Retention").click();

    const ack = page.getByRole("checkbox", { name: /remote backup will be removed only after/i });
    needs(
      (await ack.count()) > 0,
      "a source this deployment may delete from. The connection test's write probe decides it, and a " +
        "read-only source waives the acknowledgement because there is nothing to acknowledge deleting"
    );
    await expect(rail(page, "Review")).toBeDisabled();

    await ack.check();
    await expect(rail(page, "Review")).toBeEnabled();
    await rail(page, "Review").click();

    const runNow = page.getByRole("button", { name: /Save, enable & run/ });
    const enable = page.getByRole("button", { name: /^Save & enable$/ });
    await expect(runNow).toBeEnabled();
    await expect(enable).toBeEnabled();

    // Unchecking must re-arm the guard, not leave it latched open.
    await rail(page, "Retention").click();
    await ack.uncheck();
    await expect(rail(page, "Review")).toBeDisabled();
  });

  test("offers a save-disabled escape hatch that needs no acknowledgement", async ({ deployment, page }) => {
    needs(deployment.source !== null, NEEDS_SOURCE);
    await reachReview(page, deployment.source!);
    await expect(page.getByRole("button", { name: "Save disabled" })).toBeEnabled();
  });

  // backupd#624: a source is not relied on until it has been proven.
  //
  // The wizard's Save was gated on a pinned known_hosts line and an
  // imported key, which is host IDENTITY: it settles that the machine
  // answering is the one whose fingerprint somebody compared, and settles
  // nothing about whether that key authenticates or whether the account can
  // read the folder the backups are in. A set could be saved, relied on,
  // and only THEN tested, which is the order that issue turns around.
  //
  // Its own case rather than an extra assertion on the acknowledgement one,
  // because the two answer different questions and a case that flips both
  // at once can only ever say "something is still missing".
  test("saving is blocked until the connection has been proven", async ({ deployment, page }) => {
    needs(deployment.source !== null, NEEDS_SOURCE);
    const source = deployment.source!;

    await fillSource(page, source);
    await rail(page, "Connection test").click();
    await page.getByRole("radio", { name: /Use managed key/ }).click();
    const managed = page.getByRole("button").filter({ hasText: /SHA256:/ });
    await expect(managed.first()).toBeVisible();
    await managed.first().click();
    const trust = page.getByRole("button", { name: "Trust host" });
    await expect(trust).toBeEnabled();
    await trust.click();

    // Every other precondition on this step is met, so this isolates the
    // connection as the one variable under test: the rail will not leave
    // step 2, and Continue is refused too.
    await expect(rail(page, "Engine")).toBeDisabled();
    await expect(rail(page, "Review")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();

    await page.getByRole("button", { name: /^Test connection$/ }).click();

    // Named outcomes, never one verdict. backupd#596 split DNS, the
    // connect, the host key, the key material, the authentication and the
    // listing apart precisely because one boolean made a typo'd hostname,
    // an unauthorised key, a rotated host key and a missing path read
    // identically, and those are four different afternoons.
    for (const step of ["credentials", "resolve", "connect", "host_key", "authenticate", "list"]) {
      await expect(page.getByText(step, { exact: true })).toBeVisible();
    }
    await expect(page.getByText(/This source has been proven/i)).toBeVisible();
    await expect(rail(page, "Engine")).toBeEnabled();
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  test("cancel returns to the sets list", async ({ bm, page }) => {
    await page.getByRole("button", { name: /Cancel and return to backup sets/ }).click();
    await expect(bm.heading("Backup sets")).toBeVisible();
  });

  test("a hostname typed in step 1 shows up in the review step, not the built-in example", async ({ deployment, page }) => {
    needs(deployment.source !== null, NEEDS_SOURCE);
    // Scoped to the content column, and the first real run is what showed
    // why. The page-wide negative failed on the TERMINAL, which had
    // truthfully logged a refused host-key probe naming the example host.
    // That line is the terminal doing its job. What this case is about is
    // what the REVIEW STEP reports, so that is what it reads.
    //
    // The host is the source machine's own, not a made-up name: since #864
    // Review is unreachable until the host on the form has answered a
    // probe and a connection test, so a hostname that resolves to nothing
    // can no longer be typed all the way to the end.
    const wizard = page.locator(CONTENT_COLUMN);
    await reachReview(page, deployment.source!);
    await expect(wizard.getByText(deployment.source!.host, { exact: true }).first()).toBeVisible();
    await expect(wizard.getByText("prod-db-01.internal")).toHaveCount(0);
  });

  test("importing a key never leaves the pasted material on screen", async ({ page }) => {
    await rail(page, "Connection test").click();
    await page.getByRole("radio", { name: /Import key/ }).click();

    // Synthetic fixture only, never a real key. Against the mock this was
    // accepted and the case went on to assert the textarea had cleared;
    // against a real key store it is REFUSED, correctly, because it is
    // not a key. The first real run failed waiting for "key imported".
    //
    // The refusal makes the case stronger rather than weaker, because the
    // security property is about both outcomes and the dangerous one is
    // the refusal: an import that fails and echoes what it was given back
    // in an error message is exactly how key material ends up on a
    // screen. So the outcome is whichever the service gives, and the
    // claim is asserted against it either way.
    const fixtureKey = "FAKE-TEST-KEY-MATERIAL-not-a-real-key-0123456789";
    const textarea = page.getByLabel(/private key/i);
    await textarea.fill(fixtureKey);

    const importBtn = page.getByRole("button", { name: "Import key" });
    await expect(importBtn).toBeEnabled();

    // Waited on the RESPONSE rather than on a control, and that is a
    // finding in itself. The real service refuses this material with
    // INVALID_REQUEST ("resolved key material does not parse as a valid
    // SSH private key"), and the only place that refusal appears is the
    // terminal dock: the panel the operator submitted from renders no
    // alert of its own. So an outcome-shaped wait has nothing to wait for
    // on the refusal path, while the request itself is unambiguous.
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/v1/ssh-keys") && r.request().method() === "POST"),
      importBtn.click()
    ]);

    // The property this case exists for, on whichever path was taken, and
    // the refusal path is the dangerous one: an import that fails and
    // echoes what it was given back in an error message is exactly how key
    // material ends up on a screen.
    expect(await page.locator("body").innerText()).not.toContain(fixtureKey);

    // And on the accepted path only, the field is cleared as well: there
    // is nothing left to read even by looking at the control.
    if (response.status() === 200 || response.status() === 201) {
      await expect(page.getByText(/key imported/i)).toBeVisible();
      await expect(page.getByLabel(/private key/i)).toHaveCount(0);
    }
  });

  // Issue #146 (B2.7): the wizard's Save buttons previously had no
  // onClick at all. This drives the full wizard-to-save flow through the
  // real running app (against the mock API this whole suite runs
  // against — see playwright.config.ts's own comment on why) and
  // confirms a backup set actually exists afterward, visible on the
  // sets list, not just a success toast.
  test("completing the wizard and clicking Save & enable persists a new backup set, visible on the sets list", async ({ deployment, page, bm }) => {
    needs(
      deployment.source !== null,
      "a source machine this deployment can really reach, named through RETND_VPS_HOST / " +
        "RETND_VPS_USER / RETND_VPS_PATH. The mock answered every probe and every " +
        "connection test with a fixture; a real probe opens a real outbound connection, so the " +
        "wizard's built-in example hostname resolves to nothing and the step correctly fails"
    );

    const uniqueName = "E2E Wizard Set " + Date.now();
    await fillSource(page, deployment.source!);
    await page.getByLabel("Backup set name").fill(uniqueName);

    // proveConnection fills step 1 again, which is harmless: it types the
    // same values, and the name above is not one of them.
    await proveConnection(page, deployment.source!);
    await acknowledge(page);
    await rail(page, "Review").click();

    await page.getByRole("button", { name: /^Save & enable$/ }).click();

    // Saving navigates back to the sets list (BackupSetWizardPage's
    // handleSave), and the newly created set is there without a manual
    // page reload — the shared setsNode refresh (appNodes.ts/
    // resource.ts's fetchResource) this wizard triggers on success.
    await expect(bm.heading("Backup sets")).toBeVisible();
    // Exact, because backupd#97 gave each row more than one place the
    // set's name appears: the card title, a mono line carrying the full
    // source/set identity that the typed removal confirmation asks you to
    // retype, and the visually-hidden continuations that give the per-row
    // Disable and Remove buttons distinct accessible names. A substring match
    // now resolves to four elements and fails Playwright's strict mode, which
    // is the check working rather than the product breaking.
    await expect(page.getByText(uniqueName, { exact: true })).toBeVisible();
  });

  test("Review, and so Save, stays out of reach without an imported key or a trusted host", async ({ page }) => {
    // Before M7 (#146 review) this scenario was reachable by clicking
    // Save: the button stayed enabled with no key imported and no host
    // trusted, and handleSave's own ad hoc guard rejected the request
    // after the click. M7 made Save structurally disabled, and #864 went
    // further: a flow with no key and no trusted host cannot reach Review
    // at all, because the rail refuses every step past the connection
    // test. So the Save buttons are not merely disabled here, they are
    // not on screen, and the wizard has not moved off step 1.
    await expect(rail(page, "Review")).toBeDisabled();
    await expect(rail(page, "Retention")).toBeDisabled();
    await expect(page.getByRole("button", { name: /Save, enable & run/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Save & enable$/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "Add backup set" })).toBeVisible();
    await expect(page.getByText("Step 1 of 8")).toBeVisible();
  });
});
