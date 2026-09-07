// Walking the add-backup-set wizard as an operator, one step at a time.
//
// The steps are exported individually rather than only as one call,
// because the wizard is the SUBJECT of specs/backup-set-wizard.spec.ts,
// which asserts its way between them, and it is SETUP for every spec that
// needs a backup set to exist before it can say anything. That is the same
// argument harness/fixtures.ts makes for exporting `enrolAdministrator`:
// one implementation serves both, so the path a spec tests and the path a
// spec relies on cannot drift into two different things.
//
// Every locator here is a role or a label, never a CSS selector, matching
// suites/web-ui/e2e's own convention and for the same reason: a step that
// needs a class name is a component missing an accessible name, and
// suites/web-ui is where that gets found.
//
// # The key this wizard imports is minted here, in memory
//
// The suite deliberately mounts no SSH key into the engine (see
// harness/deployment.ts, where compose's two key mounts are left out on
// purpose). "Generate dedicated SSH key" and "Use managed key" both refuse
// at save on this build, so "Import key" is the only key source that can
// finish the wizard, and importing needs a private key to paste. So one is
// generated per call, lives in a variable, and goes into the form and
// nowhere else. Its public half is what `deployment.source.authorizeKey`
// installs on the machine being backed up, which is the operator's own
// next step and the only reason the manager can log in at all.
import { generateKeyPairSync } from "node:crypto";
import { expect, type Page } from "@playwright/test";

import type { Deployment } from "./deployment";
import { redacting } from "./secrets";

/** One SSH keypair, in two shapes: what gets pasted into the wizard, and
 *  what gets authorised on the source machine. */
export interface KeyPair {
  /** PKCS#8 PEM, which is what node can emit and a shape the product
   *  genuinely accepts: rclone.ValidateImportedPrivateKey goes through
   *  ssh.ParseRawPrivateKey, which reads a "PRIVATE KEY" block.
   *  suites/equivalence/specs/backup-set-create.spec.ts mints its key the
   *  same way and for the same reason. */
  privateKeyPem: string;
  /** The `ssh-ed25519 AAAA…` line for authorized_keys. */
  publicKeyLine: string;
}

/** A fresh ed25519 keypair, generated per call and never written down.
 *
 *  The public line is assembled from the raw 32 bytes at the tail of the
 *  SPKI encoding, which is the whole of an ed25519 public key, wrapped in
 *  OpenSSH's own length-prefixed string framing. Node has no OpenSSH
 *  exporter, and shelling out to `ssh-keygen` would mean a private key on
 *  this machine's disk for the length of the call, which is the one thing
 *  this suite does not do with key material. */
export function newKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const raw = spki.subarray(spki.length - 32);
  const framed = (b: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(b.length);
    return Buffer.concat([length, b]);
  };
  const blob = Buffer.concat([framed(Buffer.from("ssh-ed25519")), framed(raw)]);
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyLine: `ssh-ed25519 ${blob.toString("base64")}`
  };
}

/** Everything the wizard asks for, in the operator's own vocabulary.
 *
 *  Deliberately one object rather than a pile of arguments: a spec that
 *  wants to prove "what came out is what went in" has to be able to hand
 *  the same values to the form and to the assertion, and two argument
 *  lists is how those quietly stop being the same values. */
export interface WizardAnswers {
  /** Step 1's "Backup set name". Also the set's id in config.yaml, and
   *  part of the filename its known_hosts line is written to, so it has
   *  to survive core/service's validPathSegment. */
  name: string;
  host: string;
  port: string;
  user: string;
  /** Step 4's "Remote folder". */
  remotePath: string;
  /** Step 4's "Include patterns", exactly as typed, commas and all. */
  include: string;
  /** Step 4's completion method, by the label on its radio. */
  completion: "Atomic rename" | "Completion marker / manifest" | "Stable file size / timestamp";
  /** Step 5's "NAS destination". */
  localPath: string;
  /** Step 6's "This source is read-only" checkbox. Checking it waives the
   *  deletion acknowledgement, because there is then nothing to
   *  acknowledge deleting. */
  readOnlySource: boolean;
}

/** The answers pointed at this run's own source machine, with every field
 *  deliberately different from the wizard's built-in example.
 *
 *  That difference is the point rather than tidiness. A wizard that
 *  ignored the form and saved its own placeholder text would still produce
 *  a valid-looking backup set, and the only thing that catches it is
 *  typing something the placeholders never say. The one exception is the
 *  port: the source machine serves SSH on 22 and so does the example, so
 *  that field alone is not evidence. */
export function answersFor(deployment: Deployment, overrides: Partial<WizardAnswers> = {}): WizardAnswers {
  return {
    name: "live-source",
    host: deployment.source.host,
    port: String(deployment.source.port),
    user: deployment.source.user,
    remotePath: deployment.source.remotePath,
    // Everything the machine is serving. The wizard's example is
    // "*.dump.zst", which matches none of the three files this source
    // holds, so leaving it alone would produce a set that discovers
    // nothing and a run that proves nothing.
    include: "*",
    // The only one of the three that asks the producer for a positive
    // assertion rather than inferring one, and the strategy
    // scripts/e2e/two-machine-backup.sh uses for the same files.
    completion: "Atomic rename",
    localPath: "/data/backups/source",
    readOnlySource: false,
    ...overrides
  };
}

/** Opens the wizard the way an operator reaches it: through the section
 *  nav to the backup sets list, then its own "Add backup set". Not a
 *  `page.goto("/sets/new")`, because a route typed into the address bar is
 *  not a path anybody takes and would skip the one thing a fresh install
 *  has to get right, which is offering the action at all. */
export async function openWizard(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: /Backup sets/i }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Backup sets" })).toBeVisible();
  await page.getByRole("button", { name: "Add backup set" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Add backup set" })).toBeVisible();
}

/** Step 1. `fill` rather than `type`: every field here is controlled and
 *  starts holding the example text, so what is wanted is replacement. */
export async function fillSource(page: Page, answers: WizardAnswers): Promise<void> {
  await page.getByRole("button", { name: "Source" }).click();
  await page.getByLabel("Backup set name").fill(answers.name);
  await page.getByLabel("Server hostname").fill(answers.host);
  await page.getByLabel("SSH port").fill(answers.port);
  await page.getByLabel("Username").fill(answers.user);
}

/** Step 2, the only key source that can finish this wizard.
 *
 *  The paste runs inside `redacting`, on the same terms the enrolment
 *  token does: this is a private key, and an action that fails inside this
 *  block must not be able to carry it into the run's output. */
export async function importPrivateKey(page: Page, pem: string): Promise<void> {
  await page.getByRole("button", { name: "Authentication" }).click();
  await page.getByRole("radio", { name: /Import key/ }).click();
  await redacting([pem], async () => {
    await page.getByLabel(/private key/i).fill(pem);
    const importKey = page.getByRole("button", { name: "Import key" });
    await expect(importKey).toBeEnabled();
    await importKey.click();
    await expect(page.getByText(/Key imported/i)).toBeVisible();
  });
}

/** Step 3, once the probe this step fires on arrival has answered.
 *
 *  The wait is on "Trust host" becoming enabled, which is the wizard's own
 *  signal that a real fingerprint came back: the button's disabled
 *  condition includes `!probedFingerprint`, and the placeholder shown
 *  while the probe is in flight is never what trust anchors to. Waiting on
 *  the fingerprint text instead would be waiting on something that renders
 *  before the answer arrives. */
export async function trustProbedHost(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Verify server" }).click();
  const trust = page.getByRole("button", { name: "Trust host" });
  await expect(trust).toBeEnabled();
  await trust.click();
  await expect(page.getByRole("button", { name: "Host trusted" })).toBeDisabled();
}

/** Step 4. */
export async function fillDiscovery(page: Page, answers: WizardAnswers): Promise<void> {
  await page.getByRole("button", { name: "Discovery" }).click();
  await page.getByLabel("Remote folder").fill(answers.remotePath);
  await page.getByLabel("Include patterns").fill(answers.include);
  await page.getByRole("radio", { name: new RegExp(answers.completion.split(" /")[0]) }).click();
}

/** Step 5. The application validator is left at "None": this suite's
 *  claim is about bytes arriving intact, and a validator would be a second
 *  subject with its own failure modes in front of that one. */
export async function fillStorage(page: Page, answers: WizardAnswers): Promise<void> {
  await page.getByRole("button", { name: "Storage & validation" }).click();
  await page.getByLabel("NAS destination").fill(answers.localPath);
}

/** Step 6's two checkboxes, without pressing Save.
 *
 *  Which one gets checked is the same either-or the page itself draws:
 *  declaring the source read-only removes the deletion the acknowledgement
 *  is about, so the acknowledgement is not rendered at all in that case. */
export async function reviewAnswers(page: Page, answers: WizardAnswers): Promise<void> {
  await page.getByRole("button", { name: "Review" }).click();
  if (answers.readOnlySource) {
    await page.getByRole("checkbox", { name: /This source is read-only/ }).check();
  } else {
    await page.getByRole("checkbox", { name: /remote backup will be removed only after/i }).check();
  }
}

/** Presses the save this deployment actually offers, and waits for the
 *  engine to have taken it.
 *
 *  A fresh install has no configuration to fold a set into, so the wizard
 *  is in its first-run mode: the save goes to POST /system/first-run, and
 *  the button says "Finish setup" rather than "Save & enable". Waiting on
 *  the response rather than on the page moving means a refusal is reported
 *  as a refusal, with its status, instead of as a control that never
 *  appeared.
 *
 *  A first-run save can end in "restart required", which is the honest
 *  answer when the configuration is on disk and this process could not
 *  start serving it. That is a real state with its own screen, so it is
 *  handled rather than treated as a failure: the engine is restarted, the
 *  same way an operator would restart the container, and the browser is
 *  sent back in. */
export async function finishSetup(page: Page, deployment: Deployment): Promise<void> {
  const finish = page.getByRole("button", { name: "Finish setup" });
  await expect(finish).toBeEnabled();
  const [saved] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/v1/system/first-run") && r.request().method() === "POST"),
    finish.click()
  ]);
  if (saved.status() !== 201) {
    throw new Error(`the first-run save returned ${saved.status()} rather than 201: ${await saved.text()}`);
  }

  const savedPage = page.getByRole("heading", { level: 1, name: "Configuration saved" });
  const setsList = page.getByRole("heading", { level: 1, name: "Backup sets" });
  await expect(savedPage.or(setsList)).toBeVisible();
  if (await savedPage.isVisible()) {
    await deployment.manager.restartEngine();
    await page.goto(`${deployment.uiUrl}/sets`);
    await expect(setsList).toBeVisible();
  }
}

/** The whole wizard, for a spec whose subject is what happens after it.
 *
 *  Returns the answers it used, so the caller can assert against the same
 *  values rather than a second copy of them. */
export async function createBackupSet(
  page: Page,
  deployment: Deployment,
  answers: WizardAnswers,
  privateKeyPem: string
): Promise<WizardAnswers> {
  await openWizard(page);
  await fillSource(page, answers);
  await importPrivateKey(page, privateKeyPem);
  await trustProbedHost(page);
  await fillDiscovery(page, answers);
  await fillStorage(page, answers);
  await reviewAnswers(page, answers);
  await finishSetup(page, deployment);
  return answers;
}

/** The scalar `key: value` lines of a YAML document, flattened.
 *
 *  A parser would be better and is not worth a dependency here: what this
 *  is used for is one configuration holding exactly one backup set, where
 *  every key that matters appears once. A key that appears more than once
 *  with different values is recorded as ambiguous rather than resolved to
 *  whichever line came last, so an assertion can never quietly pass
 *  against the wrong occurrence of a repeated name. */
export const AMBIGUOUS = "<appears more than once>";

export function scalarFields(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const match = /^\s*-?\s*([a-z_]+):[ \t]+(\S.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    const trimmed = value.trim();
    if (out[key] !== undefined && out[key] !== trimmed) out[key] = AMBIGUOUS;
    else out[key] = trimmed;
  }
  return out;
}

/** The `type base64` half of an OpenSSH public-key line, which is the part
 *  two different renderings of the same key always agree on.
 *
 *  A host key read off the source machine carries a comment
 *  (`root@source`), and the line the engine pins carries a host pattern in
 *  front of it instead. Comparing whole lines would be comparing the
 *  packaging; this compares the key. */
export function keyBlob(line: string): string {
  const match = /(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+)\s+(\S+)/.exec(line.trim());
  if (!match) throw new Error(`no OpenSSH key found in ${JSON.stringify(line)}`);
  return `${match[1]} ${match[2]}`;
}

/** The `SHA256:…` token out of whatever is quoting a fingerprint.
 *
 *  `ssh-keygen -lf` prints a bit length, the fingerprint, a comment and an
 *  algorithm on one line; the wizard renders the fingerprint alone. This
 *  is what makes those two comparable. */
export function fingerprintOf(text: string): string {
  const match = /SHA256:[A-Za-z0-9+/=]+/.exec(text);
  if (!match) throw new Error(`no SHA256 fingerprint found in ${JSON.stringify(text)}`);
  return match[0];
}
