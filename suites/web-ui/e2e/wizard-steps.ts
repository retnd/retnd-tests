import { expect } from "./fixtures";

/**
 * Walking the add-backup-set wizard's rail against a real deployment.
 *
 * Shared by the wizard spec and by any spec that needs a later step: since
 * #864 a step is reachable only when every step before it is complete, so
 * getting to the Retention step means proving a real connection first.
 */

export type Source = { host: string; port: number; user: string; path: string };
type Page = import("@playwright/test").Page;

/** Why the cases that walk the rail past step 1 are guarded. */
export const NEEDS_SOURCE =
  "a source machine this deployment can really reach, named through RETND_VPS_HOST / " +
  "RETND_VPS_USER / RETND_VPS_PATH, and a key in its store that authenticates against it. " +
  "The rail gates every step after Connection test on a connection that was really proven (#864)";

/** The rail button for a step. Found by the data-complete attribute only
 *  the rail's buttons carry, and by its exact name: the terminal dock's
 *  filter chips are buttons too, and one of them is called "Engine". */
export const rail = (page: Page, name: string) =>
  page.locator("button[data-complete]").and(page.getByRole("button", { name, exact: true }));

/** Types this deployment's real source machine into step 1.
 *
 *  The wizard ships an example hostname, and against the mock that was
 *  enough: every probe and every connection test answered from a fixture,
 *  so the field's contents never mattered. A real probe opens a real
 *  outbound connection, so a case that goes past step 2 has to name a
 *  machine that answers, and the folder to read on it. */
export async function fillSource(page: Page, source: Source) {
  await rail(page, "Source").click();
  await page.getByLabel("Server hostname").fill(source.host);
  await page.getByLabel("SSH port").fill(String(source.port));
  await page.getByLabel("Username", { exact: true }).fill(source.user);
  await page.getByLabel("Directory to back up").fill(source.path);
}

/** Step 2, done the way a real deployment forces it to be done: pick the
 *  key the store holds, trust the host key a real probe read off the
 *  source, and run the connection test until it passes.
 *
 *  #864 made this the gate for the rest of the rail. The rail used to jump
 *  anywhere; now a step is reachable only when every step before it is
 *  complete, and step 2 is complete only when the key is settled, the host
 *  is trusted FOR the host on the form, and the connection was proven for
 *  exactly these values. The key is never pasted: the deployment holds one
 *  that authenticates against the source, and the "Use managed key" panel
 *  picks it, so this suite never handles private key material. */
export async function proveConnection(page: Page, source: Source) {
  await fillSource(page, source);
  await rail(page, "Connection test").click();

  await page.getByRole("radio", { name: /Use managed key/ }).click();
  const managed = page.getByRole("button").filter({ hasText: /SHA256:/ });
  await expect(managed.first()).toBeVisible();
  await managed.first().click();
  await expect(managed.first()).toHaveAttribute("aria-pressed", "true");

  const trust = page.getByRole("button", { name: "Trust host" });
  await expect(trust).toBeEnabled();
  await trust.click();
  await expect(page.getByRole("button", { name: "Host trusted" })).toBeDisabled();

  await page.getByRole("button", { name: /^Test connection$/ }).click();
  await expect(page.getByText(/This source has been proven/i)).toBeVisible();
}

/** The acknowledgement that deleting from the source is only ever done
 *  after the NAS copy is safe. It lives on step 7 now, and step 8 cannot
 *  be reached without it unless the source is read-only. */
export async function acknowledge(page: Page) {
  await rail(page, "Retention").click();
  const ack = page.getByRole("checkbox", { name: /remote backup will be removed only after/i });
  if ((await ack.count()) > 0) await ack.check();
}

/** Everything the wizard demands before Review, so Save can be reached. */
export async function reachReview(page: Page, source: Source) {
  await proveConnection(page, source);
  await acknowledge(page);
  await rail(page, "Review").click();
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
}
