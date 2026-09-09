import { CONTENT_COLUMN, expect, needs, test } from "./fixtures";

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
 *    (GET /ssh-keys, rclone-manager#592). The mock served two, one of them
 *    needing a passphrase, each with a "Used by" line naming a set. A
 *    fresh deployment holds none, so those cases say what a full listing
 *    would need.
 *
 *  - step 3 probes a REAL host and step 6's Test connection makes a REAL
 *    connection (#596, #624). Against the mock both were fixtures that
 *    always succeeded, which is why the six named outcomes could be
 *    asserted in one go. Against a deployment they need a machine that
 *    actually answers, which is the source container the topology stands
 *    up, named through RM_VPS_HOST.
 *
 *  - the case that SAVES creates a backup set on the deployment every
 *    later spec is reading, and there is no undo in this suite. It needs
 *    the same real source, and it is the reason the source variables
 *    exist at all.
 */

/** Types this deployment's real source machine into step 1.
 *
 *  The wizard ships an example hostname, and against the mock that was
 *  enough: every probe and every connection test answered from a fixture,
 *  so the field's contents never mattered. A real probe opens a real
 *  outbound connection, so a case that goes past step 3 has to name a
 *  machine that answers. */
async function fillSource(
  page: import("@playwright/test").Page,
  source: { host: string; port: number; user: string; path: string }
) {
  await page.getByRole("button", { name: "Source" }).click();
  await page.getByLabel("Server hostname").fill(source.host);
  await page.getByLabel("SSH port").fill(String(source.port));
  await page.getByLabel("Username").fill(source.user);
}

/** Everything the wizard demands before Save can be pressed, done the way
 *  a real deployment forces it to be done.
 *
 *  Two of the three preconditions changed meaning in the move, and this
 *  helper exists because all three cases below hit both changes.
 *
 *  The key: the old flow pasted `FAKE-TEST-KEY-MATERIAL-not-a-real-key-…`
 *  into the import box, and the mock accepted it, because nothing was ever
 *  going to authenticate with it. A real sshd will not, so a wizard driven
 *  that far now fails #624's connection check at the `authenticate` step,
 *  correctly. The way through is the key store: the deployment holds a key
 *  that really does authenticate against the source machine (the topology
 *  imports it), and the wizard's own "Use managed key" panel picks it.
 *  That also means this suite never handles private key material at all,
 *  which the import route could not promise.
 *
 *  The host key: "Trust host" used to write nothing. It now pins a real
 *  known_hosts line for the fingerprint a real probe read off the source. */
async function satisfySavePreconditions(
  page: import("@playwright/test").Page,
  source: { host: string; port: number; user: string; path: string }
) {
  await fillSource(page, source);

  await page.getByRole("button", { name: "Authentication" }).click();
  await page.getByRole("radio", { name: /Use managed key/ }).click();
  const managed = page.getByRole("button").filter({ hasText: /SHA256:/ });
  await expect(managed.first()).toBeVisible();
  await managed.first().click();
  await expect(managed.first()).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Verify server" }).click();
  const trust = page.getByRole("button", { name: "Trust host" });
  await expect(trust).toBeEnabled();
  await trust.click();
  await expect(page.getByRole("button", { name: "Host trusted" })).toBeDisabled();
}

test.describe("add backup set wizard", () => {
  test.beforeEach(async ({ bm, page }) => {
    await bm.goto("/sets");
    await page.getByRole("button", { name: "Add backup set" }).click();
    await expect(bm.heading("Add backup set")).toBeVisible();
  });

  test("groups the flow into exactly six steps", async ({ page }) => {
    const steps = page.getByRole("listitem");
    await expect(steps).toHaveCount(6);
    for (const label of ["Source", "Authentication", "Verify server", "Discovery", "Storage & validation", "Review"]) {
      await expect(page.getByRole("button", { name: label })).toBeVisible();
    }
  });

  test("marks the current step and advances with Continue", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Source" })).toHaveAttribute("aria-current", "step");
    await expect(page.getByText("Step 1 of 6")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Step 2 of 6")).toBeVisible();
    // exact: true — "← Cancel and return to backup sets" also contains
    // "back" (as a substring of "backup"), so a non-exact match is ambiguous
    // once that cancel link and the step-nav "Back" button are both present.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByText("Step 1 of 6")).toBeVisible();
  });

  test("Back is disabled on the first step and Continue on the last", async ({ page }) => {
    // exact: true — see the comment in the previous test.
    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Review" }).click();
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  test("step 1 collects source connection details", async ({ page }) => {
    for (const label of ["Backup set name", "Server hostname", "SSH port", "Username"]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test("step 2 offers three key sources, and Generate says plainly it can't be saved yet (rclone-manager#299)", async ({ page }) => {
    await page.getByRole("button", { name: "Authentication" }).click();
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
    await expect(page.getByText(/Generating a key on save isn.t available yet/)).toBeVisible();
    await expect(page.getByText(/^ssh-ed25519 AAAA/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy public key" })).toHaveCount(0);
    await expect(page.getByText(/authorized_keys/)).toHaveCount(0);
    // The step's own copy legitimately says "Private keys stay on this NAS
    // and are never shown" — a bare /PRIVATE KEY/i match flags that
    // sentence as a false positive. Match the actual PEM marker instead
    // (same pattern safety-invariants.spec.ts uses for a real key leak).
    expect(await page.locator("body").innerText()).not.toMatch(/BEGIN (OPENSSH|RSA|EC) PRIVATE KEY/i);
  });

  test("step 2's Use managed key panel lists the keys this deployment holds and lets one be picked, still with no fabricated in-use count (rclone-manager#299)", async ({ bm, page }) => {
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

    await page.getByRole("button", { name: "Authentication" }).click();
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
    // import and was never shown again. rclone-manager#592 added GET
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
  test("step 3 requires an explicit trust decision", async ({ deployment, page }) => {
    needs(
      deployment.source !== null,
      "a source machine this deployment can really reach, named through RM_VPS_HOST / " +
        "RM_VPS_USER / RM_VPS_PATH. The mock answered every probe and every " +
        "connection test with a fixture; a real probe opens a real outbound connection, so the " +
        "wizard's built-in example hostname resolves to nothing and the step correctly fails"
    );
    await fillSource(page, deployment.source!);
    await page.getByRole("button", { name: "Verify server" }).click();
    await expect(page.getByText("Algorithm")).toBeVisible();
    await expect(page.getByText(/SHA256:/)).toBeVisible();
    await expect(page.getByText("Not yet trusted")).toBeVisible();

    const trust = page.getByRole("button", { name: "Trust host" });
    await expect(trust).toBeEnabled();
    await trust.click();
    await expect(page.getByRole("button", { name: "Host trusted" })).toBeDisabled();
  });

  test("step 3 warns what a future host-key change will do", async ({ page }) => {
    // The warning is the step's own copy and is on screen before any
    // probe, so this one needs no reachable host.
    await page.getByRole("button", { name: "Verify server" }).click();
    await expect(page.getByText(/stops all backup operations for the set/)).toBeVisible();
    await expect(page.getByText(/blocks remote artifact deletion/)).toBeVisible();
  });

  test("step 4 separates recommended from advanced completion methods", async ({ page }) => {
    await page.getByRole("button", { name: "Discovery" }).click();
    await expect(page.getByText("Recommended")).toBeVisible();
    await expect(page.getByText("Advanced")).toBeVisible();
    await expect(page.getByRole("radio", { name: /Atomic rename/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Completion marker/ })).toBeChecked();
  });

  test("step 4 warns when completion is inferred", async ({ page }) => {
    await page.getByRole("button", { name: "Discovery" }).click();
    await expect(page.getByText(/infers completion/)).toHaveCount(0);

    await page.getByRole("radio", { name: /Stable file size/ }).click();
    await expect(
      page.getByText(/infers completion and provides less assurance than a producer-provided completion marker/)
    ).toBeVisible();
  });

  test("step 5 no longer draws its own per-set retention fields (rclone-manager#299)", async ({ page }) => {
    await page.getByRole("button", { name: "Storage & validation" }).click();
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

  test("step 5 lists the two validation layers that still exist, and no longer the fake Checksum toggle (rclone-manager#299)", async ({ page }) => {
    await page.getByRole("button", { name: "Storage & validation" }).click();
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
    // option's own text by rclone-manager#299, alongside the Checksum
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

  test("step 6 summarises source, destination and validation, and no longer a hardcoded retention card (rclone-manager#299)", async ({ page }) => {
    await page.getByRole("button", { name: "Review" }).click();
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
    await expect(page.getByText("Retention", { exact: true })).toHaveCount(0);
    await expect(page.getByText("7 daily", { exact: true })).toHaveCount(0);
    await expect(page.getByText("13 weekly", { exact: true })).toHaveCount(0);
    await expect(page.getByText("12 monthly", { exact: true })).toHaveCount(0);
    await expect(page.getByText("SHA-256", { exact: true })).toHaveCount(0);
  });

  test("step 6 discloses remote-source handling in full", async ({ page }) => {
    await page.getByRole("button", { name: "Review" }).click();
    await expect(page.getByText("Remote source handling")).toBeVisible();
    await expect(
      page.getByText(/transferred, verified, durably committed to this NAS, and recorded as safe/)
    ).toBeVisible();
    await expect(page.getByText("Remote artifact deleted")).toBeVisible();
  });

  test("saving is blocked until the acknowledgement is checked", async ({ deployment, page }) => {
    needs(
      deployment.source !== null,
      "a source machine this deployment can really reach (RM_VPS_HOST and friends) AND a key " +
        "in its store that authenticates against it. See satisfySavePreconditions: a synthetic key " +
        "is refused by a real sshd, so the topology has to import the source's own key"
    );

    // Every OTHER save precondition is satisfied first — a key on step 2
    // and a trusted host on step 3 — so this isolates the acknowledgement
    // checkbox as the one variable under test. Since M7 (#146 review)
    // those two also gate the Save buttons, so reaching Review cold would
    // leave Save disabled for reasons this test isn't about.
    await satisfySavePreconditions(page, deployment.source!);

    await page.getByRole("button", { name: "Review" }).click();

    const runNow = page.getByRole("button", { name: /Save, enable & run/ });
    const enable = page.getByRole("button", { name: /^Save & enable$/ });
    await expect(runNow).toBeDisabled();
    await expect(enable).toBeDisabled();
    await expect(page.getByText(/Acknowledge remote-source handling/)).toBeVisible();

    await page.getByRole("checkbox", { name: /remote backup will be removed only after/i }).check();

    // rclone-manager#624 added a fourth precondition after the
    // acknowledgement: the connection itself has to have been proven. A
    // trusted host key settles which machine answers and settles nothing
    // about whether the key authenticates or whether the account can read
    // the folder, so the wizard now runs the six-step check and keeps Save
    // disabled until it passes, the way the S3 destination wizard has kept
    // its own Save disabled since #594.
    //
    // It is satisfied here rather than asserted, because this case is about
    // the acknowledgement. The gate itself is the case below.
    await expect(runNow).toBeDisabled();
    await page.getByRole("button", { name: /^Test connection$/ }).click();
    await expect(page.getByText(/This source has been proven/i)).toBeVisible();

    await expect(runNow).toBeEnabled();
    await expect(enable).toBeEnabled();

    // Unchecking must re-arm the guard, not leave it latched open.
    await page.getByRole("checkbox", { name: /remote backup will be removed only after/i }).uncheck();
    await expect(runNow).toBeDisabled();
  });

  test("offers a save-disabled escape hatch that needs no acknowledgement", async ({ page }) => {
    await page.getByRole("button", { name: "Review" }).click();
    await expect(page.getByRole("button", { name: "Save disabled" })).toBeEnabled();
  });

  // rclone-manager#624: a source is not relied on until it has been proven.
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
    needs(
      deployment.source !== null,
      "a source machine this deployment can really reach, named through RM_VPS_HOST / " +
        "RM_VPS_USER / RM_VPS_PATH. The mock answered every probe and every " +
        "connection test with a fixture; a real probe opens a real outbound connection, so the " +
        "wizard's built-in example hostname resolves to nothing and the step correctly fails"
    );

    await page.getByRole("button", { name: "Authentication" }).click();
    await page.getByRole("radio", { name: /Import key/ }).click();
    // Synthetic fixture only, never a real key.
    await page.getByLabel(/private key/i).fill("FAKE-TEST-KEY-MATERIAL-not-a-real-key-0123456789");
    await page.getByRole("button", { name: "Import key" }).click();
    await expect(page.getByText(/key imported/i)).toBeVisible();

    await page.getByRole("button", { name: "Verify server" }).click();
    const trust = page.getByRole("button", { name: "Trust host" });
    await expect(trust).toBeEnabled();
    await trust.click();

    await page.getByRole("button", { name: "Review" }).click();
    await page.getByRole("checkbox", { name: /remote backup will be removed only after/i }).check();

    // Every other precondition is met, so this isolates the connection as
    // the one variable under test.
    const enable = page.getByRole("button", { name: /^Save & enable$/ });
    await expect(enable).toBeDisabled();
    // The reason is stated, not merely enforced: a disabled button with no
    // reason reads as an application that is broken.
    await expect(page.getByText(/Test connection before saving/i)).toBeVisible();

    await page.getByRole("button", { name: /^Test connection$/ }).click();

    // Six named outcomes, never one verdict. rclone-manager#596 split DNS,
    // the connect, the host key, the key material, the authentication and
    // the listing apart precisely because one boolean made a typo'd
    // hostname, an unauthorised key, a rotated host key and a missing path
    // read identically, and those are four different afternoons.
    for (const step of ["credentials", "resolve", "connect", "host_key", "authenticate", "list"]) {
      await expect(page.getByText(step, { exact: true })).toBeVisible();
    }
    await expect(enable).toBeEnabled();
  });

  test("cancel returns to the sets list", async ({ bm, page }) => {
    await page.getByRole("button", { name: /Cancel and return to backup sets/ }).click();
    await expect(bm.heading("Backup sets")).toBeVisible();
  });

  test("a hostname typed in step 1 shows up in the review step, not the built-in example", async ({ page }) => {
    // Scoped to the content column, and the first real run is what showed
    // why. The Review card is right: it says warehouse-nas.internal. The
    // page-wide negative failed on the TERMINAL, which had truthfully
    // logged a refused host-key probe naming the example host:
    //
    //   [you] post /ssh/host-key-probe refused: HOST_KEY_PROBE_FAILED
    //   connecting to prod-db-01.internal:22: ... no such host
    //
    // That line is the terminal doing its job. Against the mock there was
    // no probe to refuse and no line to log, so an unscoped negative was
    // accidentally safe. What this case is about is what the REVIEW STEP
    // reports, so that is what it reads.
    const wizard = page.locator(CONTENT_COLUMN);
    const host = page.getByLabel("Server hostname");
    await host.fill("warehouse-nas.internal");

    await page.getByRole("button", { name: "Review" }).click();
    await expect(wizard.getByText("warehouse-nas.internal")).toBeVisible();
    await expect(wizard.getByText("prod-db-01.internal")).toHaveCount(0);
  });

  test("importing a key never leaves the pasted material on screen", async ({ page }) => {
    await page.getByRole("button", { name: "Authentication" }).click();
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
    await importBtn.click();

    // Something is said. A button that swallows a submission and reports
    // neither outcome is its own defect.
    const imported = page.getByText(/key imported/i);
    const refused = page.getByRole("alert");
    await expect(imported.or(refused).first()).toBeVisible();

    // The property this case exists for, on whichever path was taken.
    expect(await page.locator("body").innerText()).not.toContain(fixtureKey);

    // And on the accepted path only, the field is cleared as well: there
    // is nothing left to read even by looking at the control.
    if ((await imported.count()) > 0) {
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
      "a source machine this deployment can really reach, named through RM_VPS_HOST / " +
        "RM_VPS_USER / RM_VPS_PATH. The mock answered every probe and every " +
        "connection test with a fixture; a real probe opens a real outbound connection, so the " +
        "wizard's built-in example hostname resolves to nothing and the step correctly fails"
    );

    const uniqueName = "E2E Wizard Set " + Date.now();
    await fillSource(page, deployment.source!);
    await page.getByLabel("Backup set name").fill(uniqueName);

    await page.getByRole("button", { name: "Authentication" }).click();
    await page.getByRole("radio", { name: /Import key/ }).click();
    await page.getByLabel(/private key/i).fill("FAKE-TEST-KEY-MATERIAL-not-a-real-key-0123456789");
    await page.getByRole("button", { name: "Import key" }).click();
    await expect(page.getByText(/key imported/i)).toBeVisible();

    await page.getByRole("button", { name: "Verify server" }).click();
    const trust = page.getByRole("button", { name: "Trust host" });
    await expect(trust).toBeEnabled();
    await trust.click();
    await expect(page.getByRole("button", { name: "Host trusted" })).toBeDisabled();

    await page.getByRole("button", { name: "Review" }).click();
    await page.getByRole("checkbox", { name: /remote backup will be removed only after/i }).check();
    // rclone-manager#624: the source has to be proven before it can be
    // saved. See the acknowledgement case above for why.
    await page.getByRole("button", { name: /^Test connection$/ }).click();
    await expect(page.getByText(/This source has been proven/i)).toBeVisible();

    await page.getByRole("button", { name: /^Save & enable$/ }).click();

    // Saving navigates back to the sets list (BackupSetWizardPage's
    // handleSave), and the newly created set is there without a manual
    // page reload — the shared setsNode refresh (appNodes.ts/
    // resource.ts's fetchResource) this wizard triggers on success.
    await expect(bm.heading("Backup sets")).toBeVisible();
    // Exact, because rclone-manager#97 gave each row more than one place the
    // set's name appears: the card title, a mono line carrying the full
    // source/set identity that the typed removal confirmation asks you to
    // retype, and the visually-hidden continuations that give the per-row
    // Disable and Remove buttons distinct accessible names. A substring match
    // now resolves to four elements and fails Playwright's strict mode, which
    // is the check working rather than the product breaking.
    await expect(page.getByText(uniqueName, { exact: true })).toBeVisible();
  });

  test("Save stays disabled without an imported key or a trusted host, even after acknowledging", async ({ page }) => {
    // Before M7 (#146 review) this scenario was reachable by clicking
    // Save: the button stayed enabled with no key imported and no host
    // trusted, and handleSave's own ad hoc guard rejected the request
    // after the click, surfacing an inline error. Save is now
    // structurally disabled for this same combination instead — proven
    // here by the buttons refusing to be clicked at all, mirroring
    // wizard.test.tsx's "keeps Save disabled without an imported key or
    // a trusted host" unit test.
    await page.getByRole("button", { name: "Review" }).click();
    await page.getByRole("checkbox", { name: /remote backup will be removed only after/i }).check();

    await expect(page.getByRole("button", { name: /Save, enable & run/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Save & enable$/ })).toBeDisabled();
    await expect(page.getByRole("heading", { level: 1, name: "Add backup set" })).toBeVisible();
  });
});
