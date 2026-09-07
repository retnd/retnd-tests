import { generateKeyPairSync } from "node:crypto";

import type { Page } from "@playwright/test";

import { enrolAdministrator, expect, signIn, test } from "../harness/fixtures";
import type { Deployment } from "../harness/fixtures";

// Editing a backup set that really exists, on a deployment that is really
// running, and proving each change where it can be checked rather than
// where it was typed.
//
// # The distinction this whole spec is built on
//
// A form that accepts a value and drops it looks exactly like a form that
// accepts a value and saves it, from the browser. Suite B cannot tell them
// apart, because the thing on the other end of its requests is a mock that
// agrees with whatever it is told. So every assertion below about a change
// having happened reads config.yaml off the manager's own config volume,
// through a container this run starts, rather than reading the page back
// to itself.
//
// The file is only half of it though. A configuration that is on disk and
// not in the running process is a change an operator has to restart to
// get, and this product's own claim is the opposite: an edit goes through
// the engine that is serving, and is live when the save returns. So the
// engine is asked too, and once in a way it cannot fake: the set starts
// out pointed at a remote directory that does not exist, the connection
// test refuses, one edit fixes the path, and the same test succeeds with
// nothing restarted in between. That is the engine acting on the new
// value, not echoing it back.
//
// # What the edit surface offers today
//
// ui/shared/src/pages/backupSetEditFields.ts is the list, and this spec
// walks it: host, port, user, remote folder, local destination, include
// patterns, completion method, and the stable-size window that appears
// with it. Every one of them is changed here.
//
// Not on that list, deliberately (the page says so under the form): the
// set's name and source, which are its identity, and its SSH key and
// trusted host key, which are trust decisions the wizard's verify step
// owns. rclone-manager#572 is adding the second pair to the edit surface
// and is not merged at the pin this run resolves, so there is nothing to
// drive for it yet. When it lands the walk below extends by two rows and
// the control at the end loses two of its unchanged fields; nothing else
// about the shape of this test has to change.
//
// # Why the set is created over the API rather than through the wizard
//
// The wizard is issue #43's own separate spec and its own separate claim.
// What this one needs is a persisted backup set to edit, and reaching it
// through six wizard steps would make every failure here ambiguous
// between "editing is broken" and "creating is broken". So the set is
// created the way suites/equivalence creates one, through the same
// endpoints the wizard calls, with a real imported key and a real probed
// host key, because a set that could not connect could not be used for
// the liveness proof above.

/** The one backup set this spec creates, edits and checks. */
const SOURCE = "live";
const SET = "vault";
const SET_ID = `${SOURCE}/${SET}`;

/** What the set is created with.
 *
 *  Two objects rather than a pile of literals, so "what it was" and "what
 *  it became" are readable side by side and nothing below can compare a
 *  value against itself by accident.
 *
 *  The remote path is wrong ON PURPOSE:
 *  /nowhere does not exist on the source machine, so the connection test
 *  refuses before the edit and can succeed after it, which is what makes
 *  the "this is live" proof a proof rather than a re-read. */
const BEFORE = {
  host: "source",
  port: 22,
  user: "backupuser",
  remotePath: "/nowhere",
  localPath: "/data/backups/live-vault",
  include: ["*.txt"],
  completionStrategy: "rename",
  staleAfterSeconds: 172_800
};

/** What every field is changed to. Each value is visibly not the one it
 *  replaces, including the port and the window, so a config.yaml that
 *  kept the old one cannot read as a pass. */
const AFTER = {
  host: "relocated.source.internal",
  port: 2022,
  user: "archivist",
  /** The one change that has to be RIGHT rather than merely different:
   *  the source machine really is serving /upload, so the connection test
   *  can go from refusing to succeeding on the strength of this edit
   *  alone. */
  remotePath: "/upload",
  localPath: "/data/backups/live-vault-moved",
  include: ["*.bin", "*.sql.gz"],
  completionLabel: "Stable file size / timestamp",
  completionStrategy: "stable",
  stableForSeconds: 45
};

test("an operator changes every editable field of a backup set, and every change lands on the deployment", async ({
  page,
  deployment
}) => {
  await enrolAdministrator(page, deployment);

  // ------------------------------------------------- a set worth editing
  const { privateKeyPem, publicKeyLine } = newKeyPair();
  await deployment.source.authorizeKey(publicKeyLine);
  const setUp = await createBackupSet(page, deployment, privateKeyPem);
  if (setUp.restartRequired) await deployment.manager.restartEngine();

  // The premise, read off the manager's own volume rather than believed
  // from the 201. Everything below is a claim that one of these values
  // changed, and a premise nobody checked is how a test ends up proving
  // that a value it never had is not there.
  const created = await configYaml(deployment);
  expect(yamlValue(created, "host"), "the set was not created with the host this test edits away from").toBe(
    BEFORE.host
  );
  expect(yamlValue(created, "remote_path")).toBe(BEFORE.remotePath);
  expect(yamlValue(created, "stale_after")).toBe("48h0m0s");
  // Captured now because it is one of the controls at the end: the trusted
  // host key is not on the edit surface, and a save that rewrote the whole
  // set from a stale form would move it.
  const knownHostsBefore = yamlValue(created, "known_hosts");
  expect(knownHostsBefore, "the created set has no trusted host key on file").not.toBe("");

  // --------------------------------------------- the connection, refused
  //
  // The negative half of the liveness proof, and it has to come first: an
  // "it works now" with nothing to contrast it against is a sentence about
  // a set that was always fine.
  const before = await testConnection(page, deployment);
  expect(
    before.ok,
    `the set was created pointing at ${BEFORE.remotePath}, which does not exist on the source machine, and the ` +
      "engine reported the connection fine anyway. Nothing below can then show an edit taking effect."
  ).toBe(false);

  // ---------------------------------------------------------- edit mode
  //
  // Edit is a mode the detail page enters rather than a dialog it opens
  // (#350), and entering it takes a hold on the set so a cycle cannot
  // start underneath. Pressing the button is how an operator gets there,
  // so that is how this gets there.
  await page.goto(`${deployment.uiUrl}/sets/${SOURCE}/${SET}`);
  await expect(page.getByRole("heading", { name: SET })).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit this backup set" })).toBeVisible();

  // ------------------------------------------------- the remote folder
  //
  // First, and on its own, because it is the field the liveness proof
  // rests on. Everything after it is a walk.
  await saveField(page, "Remote folder", AFTER.remotePath);
  expect(yamlValue(await configYaml(deployment), "remote_path")).toBe(AFTER.remotePath);

  // ------------------------------------------- and the connection, live
  //
  // Nothing has been restarted. The same request that refused a moment
  // ago now succeeds, and it succeeds by opening a real SSH connection to
  // the source machine and listing the directory this edit named, using
  // the configuration the engine is holding in memory
  // (service.TestBackupSetConnection reads b.state, not the file).
  //
  // So this is not "the engine can read back what it wrote". It is the
  // engine doing work against the new value.
  const after = await testConnection(page, deployment);
  expect(
    after.ok,
    "the edit reached config.yaml but the running engine is still using the old remote path, so an operator " +
      `would have to restart the deployment to get an edit it told them was saved. The engine said: ${after.message}`
  ).toBe(true);

  // ------------------------------------------------ the rest of the walk
  //
  // One per box, each with its own Save, which is what the edit surface
  // promises: a per-box Save writes that box and nothing else. Each one
  // is checked against the file before the next is typed, so a value that
  // did not land is attributed to the box that dropped it rather than to
  // whichever save happened last.
  await saveField(page, "Host", AFTER.host);
  expect(yamlValue(await configYaml(deployment), "host")).toBe(AFTER.host);

  await saveField(page, "Port", String(AFTER.port));
  expect(yamlValue(await configYaml(deployment), "port")).toBe(String(AFTER.port));

  await saveField(page, "User", AFTER.user);
  expect(yamlValue(await configYaml(deployment), "user")).toBe(AFTER.user);

  await saveField(page, "Local destination", AFTER.localPath);
  expect(yamlValue(await configYaml(deployment), "local_path")).toBe(AFTER.localPath);

  // The include list is typed as one comma-separated string and stored as
  // a list, so this is also the one field where "what was typed" and
  // "what was persisted" are different shapes and the file is the only
  // place to see which one won.
  await saveField(page, "Include patterns", AFTER.include.join(", "));
  expect(yamlList(await configYaml(deployment), "include")).toEqual(AFTER.include);

  // ------------------------------- the completion method and its window
  //
  // These two travel together, and the deployment is what says so: core
  // refuses a set whose strategy is "stable" and whose window is zero,
  // exactly as it refuses one at creation. So the completion box's own
  // Save cannot succeed on its own here, and asserting that is worth more
  // than avoiding it: a form that accepted this one and wrote a set the
  // engine would refuse to load is the failure this refusal prevents.
  //
  // By role rather than by label: a <select>'s accessible name picks up
  // the option currently showing, so "Completion method" is a prefix of
  // its name rather than the whole of it, and a bare label lookup also
  // matches the "Save completion method" button beside it.
  await page.getByRole("combobox", { name: "Completion method" }).selectOption({ label: AFTER.completionLabel });
  const saveCompletion = page.getByRole("button", { name: "Save completion method" });
  await expect(saveCompletion).toBeEnabled();
  await saveCompletion.click();
  await expect(page.getByRole("alert")).toContainText("stable_for");
  expect(
    yamlValue(await configYaml(deployment), "strategy"),
    "the refused save changed the completion strategy on disk anyway"
  ).toBe(BEFORE.completionStrategy);

  // Selecting the method revealed its window, which is the whole reason
  // the field is conditional.
  const stableWindow = page.getByLabel("Stable for (seconds)", { exact: true });
  await stableWindow.fill(String(AFTER.stableForSeconds));

  // And the same pairing from the other side, which is the one place in
  // this walk where a save is ACCEPTED and the value does not land. Saving
  // the window on its own sends only the window, so the strategy on disk
  // is still "rename", and core clears the window of any set that is not
  // on "stable" rather than leaving a number in an operator's file that
  // nothing reads. The request succeeds and the value is gone.
  //
  // It is not a silent drop, and that is the part worth pinning: the page
  // re-reads the server's answer for the box it just saved, so the window
  // comes back showing the zero that was actually written rather than the
  // 45 that was typed. An operator sees their value refuse to stick. That
  // is the difference between this and a form that lies, and it is only
  // checkable from the file plus the box together.
  const saveWindow = page.getByRole("button", { name: "Save stable for (seconds)" });
  const [alone] = await Promise.all([waitForPatch(page), saveWindow.click()]);
  expect(alone.status(), await alone.text()).toBe(200);
  const halfSaved = await configYaml(deployment);
  expect(yamlValue(halfSaved, "strategy"), "saving the window alone moved the strategy too").toBe(
    BEFORE.completionStrategy
  );
  expect(yamlValue(halfSaved, "stable_for"), "the window landed on a set that is not on the stable strategy").toBe(
    "0s"
  );
  await expect(stableWindow, "the form kept showing a window the deployment did not keep").toHaveValue("0");

  // So the pair goes together, which is what SAVE ALL is for: it sends
  // whatever is still dirty, which is both boxes.
  await stableWindow.fill(String(AFTER.stableForSeconds));
  const [saved] = await Promise.all([
    waitForPatch(page),
    page.getByRole("button", { name: "SAVE ALL & EXIT EDIT" }).click()
  ]);
  expect(saved.status(), await saved.text()).toBe(200);
  await expect(page.getByRole("heading", { name: "Edit this backup set" })).toBeHidden();

  const edited = await configYaml(deployment);
  expect(yamlValue(edited, "strategy")).toBe(AFTER.completionStrategy);
  expect(yamlValue(edited, "stable_for")).toBe("45s");

  // ---------------------------------------------------------- the control
  //
  // A save that rebuilt the whole set out of whatever the form last held
  // would pass every assertion above and still be wrong, because it would
  // also carry the fields the form never showed. These are those fields:
  // the freshness budget, which the API can write and this surface does
  // not offer; the trusted host key and the imported key reference, which
  // are trust decisions the wizard owns; and whether the set is collected
  // at all.
  expect(yamlValue(edited, "stale_after"), "a save moved the freshness budget, which no box on the form offers").toBe(
    "48h0m0s"
  );
  expect(yamlValue(edited, "known_hosts"), "a save moved the trusted host key, which no box on the form offers").toBe(
    knownHostsBefore
  );
  expect(yamlValue(edited, "disabled"), "a save re-enabled a set the form has no control for").toBe("true");
  // Identity is the other half of the same control: the name and source
  // key every artifact this set will ever produce, and the form shows the
  // name as a heading rather than an input for that reason.
  expect(edited).toContain(`id: ${SOURCE}`);
  expect(edited).toContain(`id: ${SET}`);

  // ------------------------------------------- and the engine agrees
  //
  // Still nothing restarted. This is the running process's own answer
  // about the set, which it serves out of the configuration it adopted
  // when each save returned, so a deployment that had written the file
  // and gone on using the old values would fail here while every
  // config.yaml assertion above passed.
  const live = await getBackupSet(page, deployment);
  expect(live).toMatchObject({
    host: AFTER.host,
    port: AFTER.port,
    user: AFTER.user,
    remote_path: AFTER.remotePath,
    local_path: AFTER.localPath,
    include: AFTER.include,
    completion_strategy: AFTER.completionStrategy,
    stable_for_seconds: AFTER.stableForSeconds,
    stale_after_seconds: BEFORE.staleAfterSeconds
  });

  // ------------------------------------------------- and it still loads
  //
  // The last thing a file assertion cannot see: whether what was written
  // is something this deployment can come back up on. A restart is not
  // needed for the edit to take effect, which is what everything above
  // established; it is done here to prove the edit did not leave a
  // configuration behind that only works in the process that wrote it.
  await deployment.manager.restartEngine();
  // Signing in again is not ceremony: the engine holds sessions in memory,
  // so restarting one ends the operator's, and a browser that had one is
  // looking at the login form. Worth knowing for any spec here that
  // restarts something, because the symptom is a control that never
  // appears rather than anything that says "signed out".
  await signIn(page, deployment);
  await page.goto(`${deployment.uiUrl}/sets/${SOURCE}/${SET}`);
  await expect(page.getByText(`${AFTER.host}:${AFTER.port} · ${AFTER.remotePath}`)).toBeVisible();
});

/** Types a value into one edit box and presses that box's own Save.
 *
 *  The wait is on the request and then on the button going quiet. The
 *  second one is the operator-visible half and it is not decoration: the
 *  page re-reads the SERVER's answer for the field it just saved and
 *  re-baselines the box against it, so a Save that stays armed means the
 *  value that came back is not the value that went out. */
async function saveField(page: Page, label: string, value: string): Promise<void> {
  await page.getByLabel(label, { exact: true }).fill(value);
  const save = page.getByRole("button", { name: `Save ${label.toLowerCase()}` });
  await expect(save, `typing into ${label} did not arm its Save`).toBeEnabled();
  const [response] = await Promise.all([waitForPatch(page), save.click()]);
  expect(response.status(), `saving ${label}: ${await response.text()}`).toBe(200);
  await expect(save, `${label} saved and its Save stayed armed, so the value that came back is not the one sent`)
    .toBeDisabled();
}

function waitForPatch(page: Page) {
  return page.waitForResponse(
    (r) => r.url().endsWith(`/api/v1/backup-sets/${SET_ID}`) && r.request().method() === "PATCH"
  );
}

/** The whole of config.yaml, off the manager's config volume, read by a
 *  container this run starts rather than by the engine that wrote it. */
async function configYaml(deployment: Deployment): Promise<string> {
  const text = await deployment.manager.configFile("config.yaml");
  if (text === null) {
    throw new Error(
      "there is no config.yaml on the manager's config volume, so this deployment has no configuration to have " +
        "edited. Either first-run never wrote one or it wrote it somewhere else."
    );
  }
  return text;
}

/** The one value config.yaml writes for `key`.
 *
 *  It refuses rather than picking when the file writes the key more than
 *  once, which is what keeps this honest on a file with one source and
 *  one backup set in it: the day a second set is added, every assertion
 *  built on this says so instead of quietly reading whichever came
 *  first. */
function yamlValue(configYaml: string, key: string): string {
  const found = configYaml.split("\n").filter((line) => new RegExp(`^\\s*${key}:(\\s|$)`).test(line));
  if (found.length !== 1) {
    throw new Error(
      `config.yaml writes ${key} ${found.length} times, so there is no single value to check. This helper reads a ` +
        "configuration with one source and one backup set in it, which is what this spec creates."
    );
  }
  return found[0].slice(found[0].indexOf(":") + 1).trim();
}

/** The block sequence config.yaml writes under `key`, unquoted. Include
 *  patterns start with `*`, which YAML quotes, so the quotes have to come
 *  off before anything is compared to what was typed. */
function yamlList(configYaml: string, key: string): string[] {
  const lines = configYaml.split("\n");
  const at = lines.findIndex((line) => new RegExp(`^\\s*${key}:\\s*$`).test(line));
  if (at < 0) throw new Error(`config.yaml has no ${key} list`);
  const indent = lines[at].length - lines[at].trimStart().length;
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const depth = line.length - line.trimStart().length;
    if (line.trim() === "" || depth <= indent || !line.trimStart().startsWith("- ")) break;
    out.push(line.trim().slice(2).replace(/^['"]|['"]$/g, ""));
  }
  return out;
}

/** A fresh ed25519 keypair, generated per run, held in memory and never
 *  written to this machine's disk. The private half goes to the engine
 *  through the same import endpoint the wizard uses; the public half goes
 *  to the source machine's authorized_keys, which is the operator step
 *  that makes the manager able to log in at all. */
function newKeyPair(): { privateKeyPem: string; publicKeyLine: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  // OpenSSH's own wire encoding, which is what authorized_keys holds and
  // node cannot emit directly: the algorithm name and the 32 raw key
  // bytes, each length-prefixed. An ed25519 SPKI ends with exactly those
  // 32 bytes.
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 32);
  const name = Buffer.from("ssh-ed25519");
  const blob = Buffer.concat([lengthPrefix(name), name, lengthPrefix(raw), raw]);
  return { privateKeyPem, publicKeyLine: `ssh-ed25519 ${blob.toString("base64")}` };
}

function lengthPrefix(part: Buffer): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(part.length);
  return out;
}

/** Imports the key, trusts the source machine's host key by probing it,
 *  and writes this deployment's first configuration: the three endpoints
 *  the wizard's own steps call, in the order it calls them.
 *
 *  It is the FIRST configuration, so it goes through
 *  /api/v1/system/first-run rather than /api/v1/backup-sets: a fresh
 *  install serves a deliberately tiny route table and the ordinary create
 *  route is not on it (webhost/firstrun.go). `restart_required` is that
 *  endpoint's honest half, and it is returned rather than swallowed
 *  because the configuration is durably written either way. */
async function createBackupSet(
  page: Page,
  deployment: Deployment,
  privateKeyPem: string
): Promise<{ restartRequired: boolean }> {
  const key = await post(page, deployment, "/api/v1/ssh-keys", { private_key_pem: privateKeyPem });
  expect(key.status, `importing an SSH key: ${key.text}`).toBe(201);

  const probe = await post(page, deployment, "/api/v1/ssh/host-key-probe", {
    host: deployment.source.host,
    port: deployment.source.port
  });
  expect(probe.status, `probing the source machine's host key: ${probe.text}`).toBe(200);
  // A trust anchor about THIS host, rather than a line this suite made up.
  // Deliberately not compared against the machine's ed25519 key: the probe
  // takes whatever algorithm the server offers first, and the source
  // machine's entrypoint generates an RSA host key beside the ed25519 one,
  // so a run picks up either. What proves the anchor is the RIGHT one is
  // the connection succeeding later, which it cannot with a wrong one.
  const trusted = String(probe.body.known_hosts_line).trim().split(/\s+/);
  expect(trusted[0], "the probe trusted a line about some other host").toBe(deployment.source.host);
  expect(trusted, `the probe answered with something that is not a known_hosts line: ${probe.text}`).toHaveLength(3);

  const created = await post(page, deployment, "/api/v1/system/first-run", {
    source_name: SOURCE,
    name: SET,
    host: BEFORE.host,
    port: BEFORE.port,
    user: BEFORE.user,
    ssh_key_id: key.body.id,
    known_hosts_line: probe.body.known_hosts_line,
    remote_path: BEFORE.remotePath,
    local_path: BEFORE.localPath,
    include: BEFORE.include,
    completion_strategy: BEFORE.completionStrategy,
    stale_after_seconds: BEFORE.staleAfterSeconds,
    // Disabled, so the scheduler cannot start a cycle against this set
    // while the test is inside edit mode. That is not tidying: entering
    // edit mode stops a running cycle and puts a confirmation in front of
    // the operator, and a spec about editing that sometimes has to answer
    // that dialog is a spec that sometimes measures the scheduler. Running
    // a cycle is issue #43's own separate claim and its own separate spec.
    // It also gives the control at the end one more field to be sure
    // about.
    disabled: true
  });
  expect(created.status, `writing this deployment's first configuration: ${created.text}`).toBe(201);
  return { restartRequired: created.body.restart_required === true };
}

/** Asks the running engine to open a real connection for the PERSISTED
 *  set, which it does out of the configuration it is holding rather than
 *  out of the file. */
async function testConnection(page: Page, deployment: Deployment): Promise<{ ok: boolean; message: string }> {
  const res = await post(page, deployment, "/api/v1/backup-sets/test-connection", { backup_set_id: SET_ID });
  expect(res.status, `testing the connection: ${res.text}`).toBe(200);
  return { ok: res.body.ok === true, message: String(res.body.message ?? "") };
}

async function getBackupSet(page: Page, deployment: Deployment): Promise<Record<string, unknown>> {
  const res = await page.request.get(`${deployment.uiUrl}/api/v1/backup-sets/${SET_ID}`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** A write through the same origin, session and CSRF token the app's own
 *  requests use: `page.request` shares the browser context's cookie jar,
 *  so this is the signed-in administrator making the call, not a second
 *  unauthenticated client. */
async function post(
  page: Page,
  deployment: Deployment,
  path: string,
  data: Record<string, unknown>
): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const csrf = (await page.context().cookies()).find((c) => c.name === "bm_csrf");
  if (!csrf) {
    throw new Error("there is no bm_csrf cookie on this context, so a CSRF-gated request cannot be made at all");
  }
  const res = await page.request.post(`${deployment.uiUrl}${path}`, {
    headers: { "X-CSRF-Token": csrf.value },
    data
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Left empty on purpose: a 204 has no body and a failure's body is
    // reported through `text` by every caller above.
  }
  return { status: res.status(), text, body };
}
