import { NEEDS_COPY_CONTROL, resolveCopyControl, withCopyCorrupted } from "../harness/assurance";
import { backupPath, claim, scrubNow } from "./assurance-page";
import { expect, needs, test } from "./fixtures";

/**
 * retnd#985 / retnd#986: a real failing scrub replaces a "Content verified"
 * chip, and a pass replaces it back.
 *
 * # Why the file is really changed
 *
 * The chip is a claim about bytes. A fixture that sets a flag, or a page
 * driven over a mock, would prove the chip can RENDER a failure, which it
 * always could. What matters is the other direction: a chip that said
 * "Content verified" because a scrub once passed must not keep saying it
 * after the bytes changed and a scrub read them. So this case earns the pass
 * first (a real scrub over the real copy), changes the copy in place at the
 * same size (a size check passes it, a content check does not), runs the
 * scrub again, and reads the chip.
 *
 * # What it asserts, and what it does not
 *
 * After the failing scrub the Content chip is `failed` and reads "Content
 * check failed"; the words "Content verified" are nowhere on that backup's
 * claims; and the copy is named as the one whose scrub did not pass. After
 * the copy is put back and scrubbed again the chip is a pass again, which is
 * the control that the chip CAN be a pass in this deployment: without it, "it
 * is not a pass after the corruption" would be true of a chip that is never
 * one.
 *
 * It does not assert a colour, a class or a timestamp format.
 *
 * # What it needs
 *
 * The scrub-start route (retnd#1059) so the page offers "Scrub now", and a
 * rig that can change a copy's bytes (harness/assurance.ts). Against a build
 * without the route the case FAILS on the missing button, which is the red it
 * is meant to have there; without the rig half it states the skip.
 */

test.describe("a real failing scrub replaces a Content verified chip", () => {
  test.describe.configure({ timeout: 600_000 });

  test.beforeEach(({ bm }) => {
    needs(bm.facts.configured, "a configured deployment");
    needs(bm.facts.backups.length > 0, "at least one ingested backup");
    needs(resolveCopyControl() !== null, NEEDS_COPY_CONTROL);
  });

  test("the chip goes from a pass to a failure with the bytes, and back with a pass", async ({ bm }) => {
    const control = resolveCopyControl();
    expect(control).not.toBeNull();
    const artifact = bm.facts.backups.find(
      (a) => !a.quarantined && (a.placements ?? []).some((p) => p.medium_type === "local" && p.access === "immediate")
    );
    needs(artifact !== undefined, "a backup with a readable local copy");
    const id = artifact?.id ?? "";
    const setId = `${artifact?.source_name}/${artifact?.set_name}`;

    // 1. Earn the pass.
    await scrubNow(bm.page, setId);
    await bm.goto(backupPath(id));
    await expect(claim(bm.page, "content")).toHaveAttribute("data-state", "pass");
    await expect(claim(bm.page, "content")).toContainText("Content verified");

    // 2. Change the bytes under the engine, scrub, read the chip.
    await withCopyCorrupted(control!, id, async () => {
      await scrubNow(bm.page, setId);
      await bm.goto(backupPath(id));
      const content = claim(bm.page, "content");
      await expect(content).toHaveAttribute("data-state", "failed");
      await expect(content).toContainText("Content check failed");
      await expect(
        bm.page.locator('[data-testid="assurance-claims"]').first(),
        "a chip that failed must not say 'Content verified' anywhere on the backup"
      ).not.toContainText("Content verified");
      const failures = bm.page.locator('[data-testid="copy-failures"] [data-failure-kind="scrub"]');
      await expect(failures).toHaveCount(1);
      await expect(failures.first()).toHaveAttribute("data-failure-state", "failed");
      await expect(failures.first()).toHaveAttribute("data-medium", "local");
    });

    // 3. The copy is back; a scrub makes the chip a pass again.
    await scrubNow(bm.page, setId);
    await bm.goto(backupPath(id));
    await expect(claim(bm.page, "content")).toHaveAttribute("data-state", "pass");
    await expect(bm.page.locator('[data-testid="copy-failures"]')).toHaveCount(0);
  });
});
