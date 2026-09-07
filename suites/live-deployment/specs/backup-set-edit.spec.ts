import { generateKeyPairSync } from "node:crypto";

import type { Page, Request } from "@playwright/test";

import { enrolAdministrator, expect, signIn, test } from "../harness/fixtures";
import type { Deployment } from "../harness/fixtures";

// Editing a backup set that really exists, on a deployment that is really
// running, and proving each change where it can be checked rather than
// where it was typed.
//
// # This spec is written against rclone-manager#580, which is not merged
//
// So it is RED until build-under-test.json moves to the commit that
// carries it, and that is deliberate rather than an oversight. It is the
// half of this repository's lockstep that goes first (docs/pinning.md):
// the spec lands describing the behaviour the product PR produces, and
// the pin moves in the same merge that ships it. A reader who hits this
// red should move the pin, not weaken the spec.
//
// What #580 changed, and what this file therefore pins:
//
//   - The completion method and its window are now one setting the server
//     takes as two fields, and `withCompanions` makes every save carry the
//     pair. Before it, the method's own Save could only fail and the
//     window's own Save answered 200 for a value the file threw away. Both
//     of those were pinned here as findings, and both are now gone; what
//     replaces them is an assertion that the pair CANNOT BE SPLIT, which
//     is the property that would break again if anyone re-split them.
//   - The SSH key and the trusted host key are editable. They were the
//     two things the page used to say were not, so the walk below is ten
//     boxes rather than eight.
//
// # The distinction this whole spec is built on
//
// A form that accepts a value and drops it looks exactly like a form that
// accepts a value and saves it, from the browser. Suite B cannot tell them
// apart, because the thing on the other end of its requests is a mock that
// agrees with whatever it is told. So every assertion below about a change
// having happened reads the manager's own config volume, through a
// container this run starts, rather than reading the page back to itself.
//
// The file is only half of it though. A configuration that is on disk and
// not in the running process is a change an operator has to restart to
// get, and this product's own claim is the opposite: an edit goes through
// the engine that is serving, and is live when the save returns. So the
// engine is asked too, and twice in a way it cannot fake. The set starts
// out pointed at a remote directory that does not exist, so the connection
// test refuses, one edit fixes the path, and the same test succeeds with
// nothing restarted in between. Then the SSH key is rotated to one the
// engine has never used, and the connection still succeeds, which it can
// only do by authenticating with the key that was just pasted.
//
// # What the edit surface offers
//
// ui/shared/src/pages/backupSetEditFields.ts is the list, and this spec
// walks it: host, port, user, remote folder, local destination, include
// patterns, completion method, the stable-size window that appears with
// it, the SSH key and the trusted host key. Every one of them is changed
// here.
//
// Not on that list, deliberately, and the control at the end is about
// them: the set's name and source, which are its identity and key every
// artifact it has ever produced, and the freshness budget, which the API
// can write and this surface does not offer.
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
// the liveness proofs above.

/** The one backup set this spec creates, edits and checks. */
const SOURCE = "live";
const SET = "vault";
const SET_ID = `${SOURCE}/${SET}`;

/** The manager's configuration directory inside its container: the
 *  directory config.yaml sits in, which is also the root
 *  `Manager.configFile` reads relative to. compose mounts a directory
 *  rather than a file here for issue #196's reason, and the imported key
 *  store and the per-set trusted-host-key files are its siblings, which is
 *  what makes both of the new boxes checkable on disk at all. */
const CONFIG_DIR = "/etc/backup-manager/config";

/** What the set is created with.
 *
 *  Two objects rather than a pile of literals, so "what it was" and "what
 *  it became" are readable side by side and nothing below can compare a
 *  value against itself by accident.
 *
 *  The remote path is wrong ON PURPOSE: /nowhere does not exist on the
 *  source machine, so the connection test refuses before the edit and can
 *  succeed after it, which is what makes the "this is live" proof a proof
 *  rather than a re-read. */
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
  /** The window the completion method arrives with, and then what it is
   *  widened to. Two values because the second edit is made on a set that
   *  is ALREADY on stable-size, where the strategy does not change at all
   *  and the request still has to carry it. That is the sharpest place to
   *  hold the pair together: there is no functional need for the strategy
   *  to be in that body, so it is only there because the two boxes are one
   *  setting, which is exactly the property that would rot. */
  stableForSeconds: 30,
  widenedStableForSeconds: 45
};

/** Sent as a raw PATCH, on its own, to reach the server's own half of the
 *  same rule. The value is never persisted, so it is deliberately neither
 *  of the two above: a config.yaml holding 20 seconds would mean the
 *  refusal did not happen. */
const NEVER_PERSISTED_WINDOW = 20;

test("an operator changes every editable field of a backup set, and every change lands on the deployment", async ({
  page,
  deployment
}) => {
  await enrolAdministrator(page, deployment);

  // ------------------------------------------------- a set worth editing
  const first = newKeyPair();
  await deployment.source.authorizeKey(first.publicKeyLine);
  const setUp = await createBackupSet(page, deployment, first.privateKeyPem);
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
  expect(created, "the set was not created with the key this test rotates away from").toContain(
    `ssh_keys/${setUp.keyId}`
  );
  // The per-set trusted-host-key file, which is where the last of the ten
  // boxes has to land. Its PATH does not move when the trusted key
  // changes, by design, so the file's contents are the only place that
  // edit is visible; captured here so the change is a change.
  const trustPath = underConfigDir(yamlValue(created, "known_hosts"));
  const trustedBefore = await deployment.manager.configFile(trustPath);
  expect(trustedBefore, `the created set has no trusted host key at ${trustPath}`).not.toBeNull();

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

  // ------------------------ the pair, from the side the browser cannot see
  //
  // The completion method and its window are one setting the server takes
  // as two fields, and the page is about to be held to that. This is the
  // other end of the same rule, reached the only way a browser cannot: a
  // request that names the window alone, against a set that stays on
  // "rename".
  //
  // It matters because the page's own coupling could be removed without
  // anything else noticing. If it were, and the service had gone back to
  // answering 200 here, every UI assertion below would still pass while
  // an operator's typed window was being discarded again, which is the
  // defect #580 exists to end. It is done BEFORE edit mode opens so that
  // nothing in this request can be confused with something the page sent.
  const refused = await patch(page, deployment, { stable_for_seconds: NEVER_PERSISTED_WINDOW });
  expect(refused.status, `a window sent alone against a "rename" set: ${refused.text}`).toBe(400);
  expect(refused.text).toContain("would not be kept");
  expect(refused.text).toContain(`completion_strategy as "${BEFORE.completionStrategy}"`);
  expect(
    await configYaml(deployment),
    "the refused request rewrote the configuration file, so a refusal is not free after all"
  ).toBe(created);

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

  // Every PATCH the PAGE sends from here on, in order, with its body.
  //
  // This is what makes the two negatives below rigorous. "No request was
  // issued" is a claim about a moment, and a moment is the one thing a
  // browser test cannot sample honestly: an assertion made too early
  // passes for a request that was about to happen. Recording the whole
  // session and checking the list once at the end has no such window, and
  // it proves more besides, because the list also says that every save
  // carried its own box and nothing else.
  //
  // Installed after the request above deliberately: that one is this
  // spec's, not the page's, and the list is a statement about the page.
  const sent: Record<string, unknown>[] = [];
  page.on("request", (r: Request) => {
    if (r.method() !== "PATCH" || !r.url().endsWith(`/api/v1/backup-sets/${SET_ID}`)) return;
    sent.push(JSON.parse(r.postData() ?? "{}") as Record<string, unknown>);
  });

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
  const reachable = await testConnection(page, deployment);
  expect(
    reachable.ok,
    "the edit reached config.yaml but the running engine is still using the old remote path, so an operator " +
      `would have to restart the deployment to get an edit it told them was saved. The engine said: ${reachable.message}`
  ).toBe(true);

  // ------------------------------------------------------- the SSH key
  //
  // One of #572's two write-only boxes. It shows nothing, because there is
  // nothing to show: the set holds a reference to a key, and a reference
  // is not a value an operator typed or can act on. So the box takes the
  // id of a key this deployment has already imported, and an empty box
  // means "leave the key alone" rather than "clear the key".
  //
  // A second real key, imported through the same endpoint the wizard uses
  // and authorised on the source machine, so this is a rotation an
  // operator could actually survive rather than a string swap.
  const second = newKeyPair();
  await deployment.source.authorizeKey(second.publicKeyLine);
  const rotated = await importKey(page, deployment, second.privateKeyPem);
  await saveField(page, "SSH key", rotated);

  const afterRotation = await configYaml(deployment);
  expect(afterRotation, "the set is not using the key that was just pasted").toContain(`ssh_keys/${rotated}`);
  expect(afterRotation, "the set is still carrying the key it was rotated away from").not.toContain(
    `ssh_keys/${setUp.keyId}`
  );
  // And live, which is the half a file cannot show: the engine logs in
  // again, and the only key it can be logging in with is the one this box
  // just named.
  const rotatedReachable = await testConnection(page, deployment);
  expect(
    rotatedReachable.ok,
    "the rotated key is in config.yaml but the running engine cannot authenticate with it. The engine said: " +
      rotatedReachable.message
  ).toBe(true);

  // ----------------------------------------------- the trusted host key
  //
  // The other write-only box, and the one edit on this form that is
  // refused for what it MEANS rather than for how it is spelled. The
  // source machine serves two host keys; the set was created trusting the
  // one the probe negotiated, and this pins the other. To the deployment
  // that is indistinguishable from a host whose key changed, which is what
  // a rebuild looks like and also what an impersonation looks like, so it
  // says so and asks.
  const otherHostKey = `${deployment.source.host} ${(await deployment.source.hostKey()).line.split(/\s+/).slice(0, 2).join(" ")}`;
  await page.getByLabel("Trusted host key", { exact: true }).fill(otherHostKey);
  const saveTrust = page.getByRole("button", { name: "Save trusted host key" });
  await expect(saveTrust, "typing a known_hosts line did not arm its Save").toBeEnabled();
  const [challenged] = await Promise.all([waitForPatch(page), saveTrust.click()]);
  expect(challenged.status(), await challenged.text()).toBe(409);
  await expect(page.getByText("This change trusts a different host key for the same host")).toBeVisible();
  expect(
    await deployment.manager.configFile(trustPath),
    "the refused save changed the trusted host key anyway, so the confirmation guards nothing"
  ).toBe(trustedBefore);

  // Confirming re-sends the same keys with the one acknowledgement that
  // refusal asked for, which is visible in the recorded body at the end:
  // it carries acknowledge_host_key_change and not the repoint's flag.
  const [acknowledged] = await Promise.all([
    waitForPatch(page),
    page.getByRole("button", { name: "Save anyway" }).click()
  ]);
  expect(acknowledged.status(), await acknowledged.text()).toBe(200);
  const trustedAfter = await deployment.manager.configFile(trustPath);
  expect(trustedAfter, "the acknowledged save did not change the trusted host key").not.toBe(trustedBefore);
  expect(trustedAfter?.trim()).toBe(otherHostKey);
  // The path did not move, which is why the file had to be read at all.
  expect(yamlValue(await configYaml(deployment), "known_hosts")).toBe(`${CONFIG_DIR}/${trustPath}`);

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
  // Two boxes, one setting. Core refuses a set whose strategy is "stable"
  // and whose window is zero, and it clears the window of any set that is
  // not on "stable", so either box sent alone is a save that cannot work.
  // #580 made every save carry the pair, and the three attempts below are
  // the three ways an operator can reach it.
  //
  // By role rather than by label: a <select>'s accessible name picks up
  // the option currently showing, so "Completion method" is a prefix of
  // its name rather than the whole of it, and a bare label lookup also
  // matches the "Save completion method" button beside it.
  const beforeCompletion = await configYaml(deployment);
  await page.getByRole("combobox", { name: "Completion method" }).selectOption({ label: AFTER.completionLabel });

  // The method's own Save, with the window still at the zero the set was
  // created with. Nothing goes to the deployment at all: the window rides
  // with the method, the window does not parse, and the refusal is the
  // form's own. That is the visible difference #580 made here, and it is
  // an improvement rather than a regression: the operator is told which
  // box needs an answer, under that box, instead of being handed a
  // sentence about stable_for under the method.
  await page.getByRole("button", { name: "Save completion method" }).click();
  // Filtered rather than a bare role lookup: WarningBanner takes role
  // "alert" too, so "the one alert on the page" is a locator that starts
  // matching something else the moment any banner is up.
  await expect(
    page.getByRole("alert").filter({ hasText: "Stable for must be a whole number of seconds greater than zero." })
  ).toBeVisible();
  expect(
    await configYaml(deployment),
    "a save the form refused locally still reached the configuration file"
  ).toBe(beforeCompletion);

  // And SAVE ALL in the same state, which is the route that used to be
  // the only way to save the pair at all. It has to refuse identically,
  // because the expansion happens inside the one function every save goes
  // through rather than on the button that asked. Edit mode stays open,
  // which is how an operator knows nothing was written.
  await page.getByRole("button", { name: "SAVE ALL & EXIT EDIT" }).click();
  await expect(page.getByRole("heading", { name: "Edit this backup set" })).toBeVisible();
  expect(
    await configYaml(deployment),
    "SAVE ALL wrote a pair the per-box Save had just refused, so the two paths do not agree"
  ).toBe(beforeCompletion);

  // Now the window has an answer, and the WINDOW's own Save is what
  // sends it. This is the direction that used to answer 200 and discard
  // the value; it now carries the method with it, so both land.
  const stableWindow = page.getByLabel("Stable for (seconds)", { exact: true });
  await saveField(page, "Stable for (seconds)", String(AFTER.stableForSeconds));

  const paired = await configYaml(deployment);
  expect(yamlValue(paired, "strategy")).toBe(AFTER.completionStrategy);
  expect(yamlValue(paired, "stable_for")).toBe(`${AFTER.stableForSeconds}s`);
  // The box keeps what was typed. The page re-reads the server's answer
  // for whatever it just saved, so a window that came back as 0 would show
  // as 0, which is precisely how the old defect announced itself.
  await expect(stableWindow, "the window did not survive its own save").toHaveValue(
    String(AFTER.stableForSeconds)
  );

  // And the sharpest form of the same claim: widening the window on a set
  // that is ALREADY on stable-size. The strategy does not change, so
  // nothing about this edit needs it in the body, and the recorded body at
  // the end says it is there anyway. That is what stops the pair being
  // quietly re-split later by someone who reasons that the companion is
  // only needed when the method moves.
  await saveField(page, "Stable for (seconds)", String(AFTER.widenedStableForSeconds));
  expect(yamlValue(await configYaml(deployment), "stable_for")).toBe(`${AFTER.widenedStableForSeconds}s`);

  // Nothing is dirty now, so this exits without writing anything, which
  // the recorded list at the end is what actually confirms.
  await page.getByRole("button", { name: "SAVE ALL & EXIT EDIT" }).click();
  await expect(page.getByRole("heading", { name: "Edit this backup set" })).toBeHidden();

  // ------------------------------------------- what the page actually sent
  //
  // The whole session, in order. Two things it settles that no assertion
  // above can: that the two refused attempts sent nothing at all, and that
  // every save carried exactly its own box, with the completion pair
  // travelling together every single time including when it did not have
  // to.
  expect(sent).toEqual([
    { remote_path: AFTER.remotePath },
    { ssh_key_id: rotated },
    { known_hosts_line: otherHostKey },
    { known_hosts_line: otherHostKey, acknowledge_host_key_change: true },
    { host: AFTER.host },
    { port: AFTER.port },
    { user: AFTER.user },
    { local_path: AFTER.localPath },
    { include: AFTER.include },
    { completion_strategy: AFTER.completionStrategy, stable_for_seconds: AFTER.stableForSeconds },
    { completion_strategy: AFTER.completionStrategy, stable_for_seconds: AFTER.widenedStableForSeconds }
  ]);

  // ---------------------------------------------------------- the control
  //
  // A save that rebuilt the whole set out of whatever the form last held
  // would pass every assertion above and still be wrong, because it would
  // also carry the fields the form never showed. These are those fields:
  // the freshness budget, which the API can write and this surface does
  // not offer, and whether the set is collected at all.
  const edited = await configYaml(deployment);
  expect(yamlValue(edited, "stale_after"), "a save moved the freshness budget, which no box on the form offers").toBe(
    "48h0m0s"
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
    stable_for_seconds: AFTER.widenedStableForSeconds,
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

/** Turns an absolute path the engine wrote into config.yaml into one
 *  `Manager.configFile` can read, and refuses anything that is not under
 *  the configuration directory rather than guessing at a relative path. */
function underConfigDir(absolute: string): string {
  if (!absolute.startsWith(`${CONFIG_DIR}/`)) {
    throw new Error(
      `config.yaml points at ${absolute}, which is not under ${CONFIG_DIR}, so this suite cannot read it off the ` +
        "config volume. The engine's own layout for per-set files has moved."
    );
  }
  return absolute.slice(CONFIG_DIR.length + 1);
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

/** Imports one private key and hands back the id the deployment filed it
 *  under. The id is a reference and the only thing that comes back: the
 *  server-side path it resolves to never reaches a client, which is why
 *  the box on the form takes an id rather than a path. */
async function importKey(page: Page, deployment: Deployment, privateKeyPem: string): Promise<string> {
  const key = await post(page, deployment, "/api/v1/ssh-keys", { private_key_pem: privateKeyPem });
  expect(key.status, `importing an SSH key: ${key.text}`).toBe(201);
  const id = String(key.body.id ?? "");
  expect(id, "the import answered without an id, so there is nothing to name the key by").not.toBe("");
  return id;
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
): Promise<{ restartRequired: boolean; keyId: string }> {
  const keyId = await importKey(page, deployment, privateKeyPem);

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
  // the connection succeeding later.
  //
  // It is also what makes the trusted-host-key box testable at all. The
  // machine serves two keys, so there is always a second, genuinely
  // different one to re-trust it with, and that is a real host-key change
  // rather than a re-paste of the same line.
  const trusted = String(probe.body.known_hosts_line).trim().split(/\s+/);
  expect(trusted[0], "the probe trusted a line about some other host").toBe(deployment.source.host);
  expect(trusted, `the probe answered with something that is not a known_hosts line: ${probe.text}`).toHaveLength(3);

  const created = await post(page, deployment, "/api/v1/system/first-run", {
    source_name: SOURCE,
    name: SET,
    host: BEFORE.host,
    port: BEFORE.port,
    user: BEFORE.user,
    ssh_key_id: keyId,
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
  return { restartRequired: created.body.restart_required === true, keyId };
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
  return send(page, deployment, "post", path, data);
}

/** The same, as a PATCH of the backup set. One caller: reaching the
 *  server's own half of a rule the page is separately held to. */
async function patch(
  page: Page,
  deployment: Deployment,
  data: Record<string, unknown>
): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  return send(page, deployment, "patch", `/api/v1/backup-sets/${SET_ID}`, data);
}

async function send(
  page: Page,
  deployment: Deployment,
  method: "post" | "patch",
  path: string,
  data: Record<string, unknown>
): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const csrf = (await page.context().cookies()).find((c) => c.name === "bm_csrf");
  if (!csrf) {
    throw new Error("there is no bm_csrf cookie on this context, so a CSRF-gated request cannot be made at all");
  }
  const res = await page.request[method](`${deployment.uiUrl}${path}`, {
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
