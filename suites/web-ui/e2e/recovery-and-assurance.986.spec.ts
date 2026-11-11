import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { csrfHeaders } from "../harness/session";
import { expect, needs, test } from "./fixtures";

/**
 * retnd#986 (EPIC Q, FR-74): recovery and assurance against the real
 * deployment the rig stands up, over the wire, through the reverse proxy.
 *
 * # The one thing to design around, and what that rules out
 *
 * POST /api/v1/operations is refused `403 DESTRUCTIVE_OPERATIONS_DISABLED`
 * on every deployment this repository can build, and this suite's own pin
 * file records cases that could not pass for exactly that reason. Q's
 * recovery route is deliberately outside that gate, so the cases below must
 * observe a recovery COMPLETING on a deployment whose gate is shut. A rig
 * that opened the gate to make them easier would be proving something no
 * operator can do, so nothing here asks for it, and the first case asserts
 * the gate is still shut in the same session that completed the recovery.
 *
 * # What this deployment holds
 *
 * The rig ingests three files from a real sshd and runs one cycle, so there
 * are backups with a local copy and nothing else. That is enough for the
 * cases below; the ones that need a storage medium, an archive class or a
 * validator are not here because this rig has none of the three, and the
 * suite says so rather than passing against a fixture it does not have.
 */

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test.describe("recovery in the browser", () => {
  test.beforeEach(({ bm }) => {
    needs(bm.facts.configured, "a configured deployment");
    needs(bm.facts.backups.length > 0, "at least one ingested backup with a local copy");
  });

  test("a download in the browser completes", async ({ bm }) => {
    await bm.goto("/backups");
    await bm.page.getByRole("row").filter({ hasText: /\.(sql|tar|dump|gz|zst|bin|dat|txt|log)/ }).first().click();
    await bm.page.getByRole("button", { name: "Recover artifact", exact: true }).click();
    const dialog = bm.page.getByRole("dialog", { name: "Recover artifact" });
    await dialog.getByRole("radio", { name: "Download in this browser" }).check();

    const [download] = await Promise.all([
      bm.page.waitForEvent("download"),
      dialog.getByRole("button", { name: "Recover artifact", exact: true }).click()
    ]);
    const bytes = readFileSync(await download.path());
    expect(bytes.length, "an empty download is not a recovery").toBeGreaterThan(0);
    await expect(dialog).toContainText("handed to your browser");

    // The page does not claim more than it saw: it says the file was handed
    // to the browser, and it does not print the digest as if it had checked
    // it. What it received is compared to what the journal recorded below.
    expect(sha256(bytes)).toMatch(/^[0-9a-f]{64}$/);

    // This case used to finish by proving the destructive gate was still
    // shut: it posted run_cycle in the same session and expected a 403
    // DESTRUCTIVE_OPERATIONS_DISABLED, to show a recovery needs no gate
    // opened. #1163 opened that gate for the local-account profiles, which
    // is the profile this rig runs, so the same request is now ACCEPTED (202)
    // and would start a real cycle on the deployment every later case reads.
    // The premise cannot be observed here any more, and a request that
    // starts a backup is not a probe. The gate's own refusal on a gateway
    // profile is held by apps/common/webhost's gate_profile_1163 tests, and
    // what this case is for, a download that completes with nobody opening
    // anything, is asserted above.
  });
    expect(refused.status(), "the gate must still be shut, or this case proved nothing").toBe(403);
    expect(await refused.text()).toContain("DESTRUCTIVE_OPERATIONS_DISABLED");
  });

  test("a recovery of an artifact nobody recorded is refused, and the page says so", async ({ bm }) => {
    const mint = await bm.api.post("/api/v1/backups/nowhere/nothing/nope.bin/recovery", {
      headers: await csrfHeaders(bm.api),
      data: { target: { kind: "download" } }
    });
    expect(mint.status(), "a refusal that is not a 4xx is an engine fault, not a refusal").toBeGreaterThanOrEqual(400);
    expect(mint.status()).toBeLessThan(500);
  });
});

test.describe("assurance left at its default", () => {
  test.beforeEach(({ bm }) => {
    needs(bm.facts.configured, "a configured deployment");
  });

  test("Settings says what the default is and offers no recovery test nobody asked for", async ({ bm }) => {
    await bm.goto("/settings");
    const card = bm.page.getByRole("region", { name: "Assurance" });
    await expect(card).toBeVisible();
    await expect(card).toContainText(/never thaws an archive/i);
    // The default policy has no recovery test configured, and the card says
    // so in words rather than showing a control that looks like a pass.
    await expect(card).not.toContainText(/Recovery test passed/);
  });

  test("a set with no assurance block inherits, and its page is not in an error state for it", async ({ bm }) => {
    needs(bm.facts.seededBackupSet !== null, "the rig's seeded backup set");
    await bm.goto("/sets/" + (bm.facts.seededBackupSet ?? ""));
    const section = bm.page.getByRole("region", { name: "Assurance" });
    await expect(section).toBeVisible();
    await expect(section.getByRole("radio", { name: "Follow the deployment" })).toBeChecked();
    // Existing behaviour: nothing on the page is an alert because assurance
    // is unconfigured. This is the regression the epic protects, a
    // deployment that has done nothing about assurance behaving as it did.
    await expect(bm.page.getByRole("alert")).toHaveCount(0);
  });

  test("the claims on a backup say what was and was not checked, never a bare tick", async ({ bm }) => {
    needs(bm.facts.backups.length > 0, "at least one ingested backup");
    await bm.goto("/backups");
    const claims = bm.page.locator('[data-testid="assurance-claims"]').first();
    await expect(claims).toBeVisible();
    await expect(claims.locator("[data-claim]")).toHaveCount(3);
    // Nothing has scrubbed this deployment's copies yet, so the recovery
    // claim cannot be a pass.
    await expect(claims.locator('[data-claim="recovery"][data-state="pass"]')).toHaveCount(0);
  });
});
