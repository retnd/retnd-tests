import {
  answersFor,
  fillDiscovery,
  fillSource,
  fillStorage,
  fingerprintOf,
  finishSetup,
  importPrivateKey,
  keyBlob,
  newKeyPair,
  openWizard,
  reviewAnswers,
  scalarFields,
  trustProbedHost
} from "../harness/wizard";
import { enrolAdministrator, expect, openApp, test } from "../harness/fixtures";

// The second thing an operator does on a new install: point Backup Manager
// at the machine it is supposed to back up.
//
// Two claims, and both are made against something other than the screen
// that reported them.
//
// The set that comes out is the set that was typed in. The wizard's Review
// step echoes what it is holding, and an echo is the wizard agreeing with
// itself: it would read exactly the same on a build whose save path sent
// its own placeholder text. So the answers are compared against config.yaml
// on the manager's config volume, read by a container this run starts.
//
// And the host-trust decision pinned this machine's real host key. "Trust
// host" is the one moment in the flow where a mistake is silent: a wizard
// that showed a fingerprint and pinned something else, or pinned nothing,
// would look identical here and fail much later as a connection that never
// works. So the fingerprint on screen is compared against the key the
// source machine is actually serving, read off that machine, and then the
// known_hosts line the engine wrote is compared against the same key.
//
// What this spec deliberately does not prove: that the set WORKS. Nothing
// here runs a cycle, transfers a byte or logs into the source machine, and
// a set can be perfectly recorded and still never pull anything. That is
// specs/backup-run.spec.ts's claim, and it is a different one.

test("an operator creates a backup set through the wizard, pointed at the source machine", async ({
  page,
  deployment
}) => {
  await enrolAdministrator(page, deployment);
  // A full page load before anything else, because the app the browser is
  // holding right now fetched its resources before there was an
  // administrator and is still showing those 401s. See `openApp`.
  await openApp(page, deployment);

  // The premise: nothing configured. A wizard that saved onto an existing
  // configuration would be a different operation with different failure
  // modes, and the read below would have something to find either way.
  expect(
    await deployment.manager.configFile("config.yaml"),
    "this deployment already has a configuration, so this is not the fresh install the wizard's first-run mode is about"
  ).toBeNull();
  await expect(page.getByText("Backup Manager has no configuration yet")).toBeVisible();

  const answers = answersFor(deployment);
  const key = newKeyPair();

  await openWizard(page);
  await fillSource(page, answers);
  await importPrivateKey(page, key.privateKeyPem);

  // The pasted key is gone from the page, and this is the real backend
  // path rather than the mock: the import went to the engine, which
  // answered with a reference, and the wizard discarded its own copy.
  // suites/web-ui asserts the same thing against a stub; the interesting
  // version is this one, because here there was a real key to lose.
  //
  // Asserted as a boolean rather than with `not.toContain`, and that is
  // not style: a failing `toContain` prints the value it was looking for,
  // so the one run where this goes red would be the run that put a private
  // key into the output. The enrolment spec checks the administrator's
  // password the same way and for the same reason.
  const keyBody = key.privateKeyPem.trim().split("\n")[1];
  expect(
    (await page.locator("body").innerText()).includes(keyBody),
    "the pasted private key is still on the page after import"
  ).toBe(false);
  await expect(page.getByLabel(/private key/i)).toHaveCount(0);

  // ------------------------------------------------------- host trust
  await page.getByRole("button", { name: "Verify server" }).click();
  const trust = page.getByRole("button", { name: "Trust host" });
  // Enabled is the wizard's own signal that a real probe answered: the
  // button stays disabled while `probedFingerprint` is null, which is what
  // the "…probing…" placeholder is showing during.
  await expect(trust).toBeEnabled();
  await expect(page.getByText("Not yet trusted")).toBeVisible();

  // What the page says it saw. FingerprintDisplay is a description list,
  // so the values are its definitions; read by shape rather than by
  // position, because "the second one is the algorithm" is a fact about
  // today's layout and these are facts about the values.
  const shown = (await page.getByRole("definition").allInnerTexts()).map((t) => t.trim());
  const shownAlgorithm = shown.find((t) => /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+)$/.test(t));
  const shownFingerprint = shown.find((t) => /^SHA256:/.test(t));
  expect(shownAlgorithm, `no host-key algorithm on the verify step, only: ${shown.join(" | ")}`).toBeTruthy();
  expect(shownFingerprint, `no fingerprint on the verify step, only: ${shown.join(" | ")}`).toBeTruthy();

  // ...and the key the source machine actually serves under that
  // algorithm, read off the machine. Which algorithm is not assumed: the
  // machine offers ed25519 and RSA, and the engine's probe negotiates
  // whichever x/crypto/ssh prefers, so the page is asked and the machine
  // is then asked for the same one. Hard-coding either would be a spec
  // that goes red on a library's preference order rather than on this
  // product.
  const hostKey = await deployment.source.hostKey(shownAlgorithm === "ssh-ed25519" ? "ed25519" : "rsa");
  // The number an operator is asked to check through a second channel has
  // to be the one that second channel would show them.
  expect(shownFingerprint, "the fingerprint on the verify step is not the source machine's own host key").toBe(
    fingerprintOf(hostKey.fingerprint)
  );

  await trustProbedHost(page);

  await fillDiscovery(page, answers);
  await fillStorage(page, answers);

  // -------------------------------------------- the acknowledgement gate
  //
  // Reached with every other precondition already satisfied (a key is
  // imported, the host is trusted), so the acknowledgement is the only
  // variable left and a refusal here can only be about it.
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("button", { name: "Finish setup" })).toBeDisabled();
  await expect(page.getByText(/Acknowledge remote-source handling/)).toBeVisible();
  // The wizard's own echo, which is worth asserting for what it is: the
  // page saying what it is holding. It is NOT the evidence that the save
  // carried these values, which is why the config.yaml read below exists.
  await expect(page.getByText(answers.host, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(answers.remotePath, { exact: true })).toBeVisible();
  await expect(page.getByText(answers.localPath, { exact: true })).toBeVisible();

  await reviewAnswers(page, answers);
  await finishSetup(page, deployment);

  // Back on the sets list, with the set on it. The exact match is
  // rclone-manager#97's: a row names its set in more than one place, so a
  // substring resolves to several elements and fails strict mode.
  await expect(page.getByText(answers.name, { exact: true }).first()).toBeVisible();

  // ----------------------------------- and what actually went to disk
  //
  // The manager's config volume, read read-only by a container this run
  // started rather than believed from the page that submitted it.
  const config = await deployment.manager.configFile("config.yaml");
  expect(config, "the wizard reported a saved backup set and the config volume has no config.yaml").not.toBeNull();
  const fields = scalarFields(config ?? "");

  expect(fields, `config.yaml does not hold the answers that were typed:\n${config}`).toMatchObject({
    host: answers.host,
    port: answers.port,
    user: answers.user,
    remote_path: answers.remotePath,
    local_path: answers.localPath,
    strategy: "rename",
    // Not typed as such: this is the review step's "Save disabled" tier
    // not having been taken, and it is where a save that lost a boolean on
    // the way to the wire would show it.
    disabled: "false"
  });
  // The set's own id, which `scalarFields` cannot answer on its own: a
  // configuration spells a source's name `id` too, so there are two of
  // them in this file and the flattened view says so rather than picking
  // one. Both are asserted, since which set sits under which source is
  // part of what was created.
  expect(config).toMatch(/^ +- id: api$/m);
  expect(config).toMatch(new RegExp(`^ +- id: ${answers.name}$`, "m"));
  // The include list is a YAML sequence rather than a scalar, and it is
  // the field most likely to be silently dropped, because the wizard is
  // the only thing that turns one typed string into a list.
  expect(config).toMatch(/^ +- '\*'$/m);

  // None of the wizard's built-in example text reached the file. Without
  // this, every assertion above would still pass on a build that ignored
  // the form for one field and saved its own placeholder for another. The
  // port is not in this list and cannot be: the source machine serves SSH
  // on 22 and so does the example, so that one field agrees with the
  // placeholder by coincidence and proves nothing on its own.
  for (const example of [
    "Production PostgreSQL",
    "prod-db-01.internal",
    "backup-agent",
    "/backups/postgresql/",
    "*.dump.zst"
  ]) {
    expect(config, `the wizard's own example value ${example} reached config.yaml`).not.toContain(example);
  }

  // ------------------------------------------- and what trust anchored to
  //
  // The known_hosts file core/service wrote for this set, named after the
  // source group every API-created set lands in and the set's own name.
  // Its content has to be the key the source machine is serving; anything
  // else means the fingerprint an operator was asked to check and the line
  // a future connection is checked against are two different things.
  const knownHosts = await deployment.manager.configFile(`known_hosts.d/api_${answers.name}_known_hosts`);
  expect(
    knownHosts,
    "the wizard reported a trusted host and the engine pinned no known_hosts line for this set"
  ).not.toBeNull();
  expect(knownHosts).toContain(keyBlob(hostKey.line));
  // And config.yaml points the set at that file, rather than at a
  // known_hosts this deployment does not have.
  expect(fields.known_hosts).toBe(`/etc/backup-manager/config/known_hosts.d/api_${answers.name}_known_hosts`);
  // The key the wizard imported landed in the engine's own store beside
  // the configuration, which is the whole reason this suite mounts no key:
  // the set points at something the wizard minted a reference for.
  //
  // Matched against the file rather than through `scalarFields`, because a
  // remote spells `file` twice, once under `key` and once under the
  // passphrase resolver beside it, so the flattened view can only say the
  // name is ambiguous.
  expect(config).toMatch(/^ +file: \/etc\/backup-manager\/config\/ssh_keys\/\S+$/m);
});

// The other half of the same claim, and the cheaper one to lose: a set
// pointed at a host that was never trusted must not be savable at all.
//
// Without this the test above proves that trusting a host records a line,
// and says nothing about whether NOT trusting one is refused. That is the
// direction the whole step exists for: the fingerprint check is worth
// nothing if the wizard would have saved regardless of the answer.
test("the wizard refuses to save a set whose host was never trusted", async ({ page, deployment }) => {
  await enrolAdministrator(page, deployment);
  await openApp(page, deployment);

  const answers = answersFor(deployment);
  const key = newKeyPair();

  await openWizard(page);
  await fillSource(page, answers);
  await importPrivateKey(page, key.privateKeyPem);
  // Verify server is skipped on purpose. Everything else is answered, so
  // the untrusted host is the only thing left for a refusal to be about.
  await fillDiscovery(page, answers);
  await fillStorage(page, answers);
  await reviewAnswers(page, answers);

  await expect(page.getByRole("button", { name: "Finish setup" })).toBeDisabled();
  await expect(page.getByText(/Trust the host's fingerprint on the Verify server step before saving/)).toBeVisible();
  // Nothing was written, which is the part the button's disabled state
  // cannot tell you on its own.
  expect(
    await deployment.manager.configFile("config.yaml"),
    "a wizard that refused to save still wrote a configuration"
  ).toBeNull();

  // And trusting the host is what unblocks it, so the refusal above is
  // about the missing trust rather than about something else on this form.
  await trustProbedHost(page);
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("button", { name: "Finish setup" })).toBeEnabled();
});

// The Review step's read-only declaration, and the control that makes it
// mean something.
//
// # This is RED until rclone-manager#581 is merged and the pin moves
//
// It was a discrepancy here until the lane that fixed it reported back:
// `completeFirstRun` built its CreateBackupSetRequest field by field beside
// a decoder that fills in the whole spec, and `read_only` never made the
// crossing, so a source an operator declared read-only on a fresh install
// was saved deletable. The browser half was already right, and #581 also
// adds a guard that walks the spec reflectively and fails on any field with
// no carriage row, so the next field added to the contract has to be
// carried or argued about rather than quietly dropped.
//
// So this asserts the fixed behaviour, and against the build
// `build-under-test.json` currently pins it fails. Red rather than skipped,
// and rather than a strict-expected-failure marker, for the reason this
// repository gives everywhere else: a skip is invisible in a pass count,
// and a marker that made the suite green would be saying the deployment
// under test has a fix it does not have. It turns green when the pin moves
// past #581, and nothing else needs to change with it.
//
// # Why there are two of these
//
// One test on its own could not tell "read-only reached the deployment"
// apart from "this deployment says read-only about everything", and a fix
// to a dropped boolean is exactly the change that invites that mistake. So
// the pair IS the assertion: one walk, one variable, and the two runs have
// to disagree. They are separate tests because first-run happens once per
// deployment and this suite gives each test its own.
for (const declaredReadOnly of [true, false] as const) {
  test(`a source the wizard declares ${declaredReadOnly ? "read-only" : "deletable"} reaches the deployment that way`, async ({
    page,
    deployment
  }) => {
    await enrolAdministrator(page, deployment);
    await openApp(page, deployment);

    const answers = answersFor(deployment, { readOnlySource: declaredReadOnly });
    const key = newKeyPair();

    await openWizard(page);
    await fillSource(page, answers);
    await importPrivateKey(page, key.privateKeyPem);
    await trustProbedHost(page);
    await fillDiscovery(page, answers);
    await fillStorage(page, answers);
    await reviewAnswers(page, answers);

    // The two runs really are different on screen before they are
    // different anywhere else. Checking the box replaces the deletion
    // sequence and its acknowledgement with a promise to keep everything,
    // because there is then nothing left to acknowledge deleting.
    if (declaredReadOnly) {
      await expect(page.getByText(/keep every backup from this source's remote copy for good/)).toBeVisible();
      await expect(page.getByRole("checkbox", { name: /remote backup will be removed only after/i })).toHaveCount(0);
    } else {
      await expect(page.getByText(/delete the original backup artifact from the remote server/)).toBeVisible();
      await expect(page.getByRole("checkbox", { name: /remote backup will be removed only after/i })).toBeChecked();
    }

    await finishSetup(page, deployment);

    // ------------------------------------------- what the operator sees
    //
    // The set's own page, reached from the list the way an operator
    // reaches it, with no page load and no container restart in between.
    // The page fetches the set from the engine rather than reading back
    // the form that was just submitted, which is the distinction this
    // whole assertion is about.
    await page.getByRole("button", { name: "Open" }).click();
    await expect(page.getByRole("heading", { level: 1, name: answers.name })).toBeVisible();
    // The value beside the label, which is what a description list means by
    // "beside": find the label and take the element after it.
    //
    // By text rather than by role, and that is not a slip. A <dt> is role
    // `term`, and `term` takes its name from the author rather than from
    // its content, so getByRole("term", { name }) matches nothing here even
    // though the label is right there on screen. The row has no other
    // handle, which is a missing label rather than a missing selector:
    // suites/web-ui is where that gets raised.
    const readOnlyCell = page
      .getByText("Read-only source", { exact: true })
      .locator("xpath=following-sibling::*[1]");
    await expect(readOnlyCell, "the set's own page disagrees with what the wizard was told").toHaveText(
      declaredReadOnly ? /^Yes/ : "No"
    );
    // And the control offered next to it, which is the other half of the
    // same statement: a set that is already read-only is offered the way
    // back, not the way in.
    await expect(
      page.getByRole("button", { name: declaredReadOnly ? "Allow remote deletion again" : "Declare source read-only" })
    ).toBeVisible();

    // ------------------------------------------- what the engine holds
    //
    // The same request the page just made, asked directly, so the claim is
    // about what this running instance is serving rather than about what a
    // component chose to render. Nothing has been reloaded or restarted: a
    // configuration that only becomes true after a restart is a different,
    // weaker thing than one the instance adopted when it was written.
    const listed = await page.request.get(`${deployment.uiUrl}/api/v1/backup-sets`);
    expect(listed.status(), await listed.text()).toBe(200);
    const sets = ((await listed.json()) as { backup_sets: { name: string; read_only: boolean }[] }).backup_sets;
    const created = sets.find((set) => set.name === answers.name);
    expect(created, `the engine lists no backup set called ${answers.name}: ${JSON.stringify(sets)}`).toBeTruthy();
    expect(
      created?.read_only,
      "the engine's own listing disagrees with the read-only answer the wizard was given. " +
        "Against a build older than rclone-manager#581 this is expected and is what that PR fixes: " +
        "completeFirstRun dropped read_only on its way into the service request."
    ).toBe(declaredReadOnly);

    // ------------------------------------------- and what survives a restart
    //
    // The file, which is the half the instance comes back up on. An
    // in-memory answer that is not on disk would be the same bug one
    // restart later.
    const config = await deployment.manager.configFile("config.yaml");
    expect(config, "no config.yaml after a save the wizard reported as done").not.toBeNull();
    expect(scalarFields(config ?? ""), `config.yaml after declaring read-only ${declaredReadOnly}:\n${config}`)
      .toMatchObject({
        host: answers.host,
        remote_path: answers.remotePath,
        read_only: String(declaredReadOnly)
      });
  });
}
