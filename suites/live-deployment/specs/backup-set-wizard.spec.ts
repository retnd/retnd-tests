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

// A discrepancy, pinned the way findings/README.md pins one: the case
// asserts the behaviour that is actually there, so the suite stays green
// while it stands, and goes red the moment it is fixed, so a note about a
// bug that has been closed cannot sit here looking true.
//
// The wizard's Review step offers "This source is read-only: pull backups
// from here, but never delete the remote original", changes its own copy
// to promise every backup is kept "for good", and sends read_only true in
// the body. The FIRST-RUN save path then drops the field:
// apps/common/webhost/firstrun.go's completeFirstRun builds a
// service.CreateBackupSetRequest field by field and does not carry
// ReadOnly across, where handlers_backupsets.go's ordinary create does
// (`ReadOnly: body.ReadOnly`). So the first backup set on a fresh install
// deletes the remote originals after a successful cycle, which is the
// opposite of what the operator was shown and agreed to, and it is the one
// setting where being wrong destroys the thing being protected.
//
// When it is fixed: change `read_only: "false"` below to `"true"`, rename
// this test after what it then proves, and drop this comment.
test("the wizard's read-only declaration is dropped by the first-run save (unfixed)", async ({ page, deployment }) => {
  await enrolAdministrator(page, deployment);
  await openApp(page, deployment);

  const answers = answersFor(deployment, { readOnlySource: true });
  const key = newKeyPair();

  await openWizard(page);
  await fillSource(page, answers);
  await importPrivateKey(page, key.privateKeyPem);
  await trustProbedHost(page);
  await fillDiscovery(page, answers);
  await fillStorage(page, answers);
  await reviewAnswers(page, answers);

  // What the operator is shown, and agrees to, before the save. Asserted
  // here rather than after, because it is gone from the page once the
  // wizard closes for the uninteresting reason.
  await expect(page.getByText(/keep every backup from this source's remote copy for good/)).toBeVisible();
  // The deletion acknowledgement is not even offered, because on this path
  // the page believes there is nothing left to delete.
  await expect(page.getByRole("checkbox", { name: /remote backup will be removed only after/i })).toHaveCount(0);

  await finishSetup(page, deployment);

  const config = await deployment.manager.configFile("config.yaml");
  expect(config, "no config.yaml after a save the wizard reported as done").not.toBeNull();
  // Every other answer survived, so this is one field being dropped rather
  // than a save that went somewhere else entirely.
  expect(scalarFields(config ?? "")).toMatchObject({
    host: answers.host,
    remote_path: answers.remotePath,
    read_only: "false"
  });
});
