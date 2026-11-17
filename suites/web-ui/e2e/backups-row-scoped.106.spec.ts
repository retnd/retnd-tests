import { expect, test } from "@playwright/test";

import { artifactRow } from "./backup-rows";

/**
 * retnd-tests#106: opening a backup must not depend on its file name being
 * unique. Earlier specs leave a `marker.txt` in every workflow-* set, so
 * the name alone matched ten rows and strict mode refused the click.
 *
 * This builds that catalogue by hand, so it needs no deployment.
 */
const sets = ["workflow-happy", "workflow-remote", "workflow-none", "workflow-crash", "workflow-many"];

test.describe("retnd-tests#106 one backup among many with the same file name", () => {
  test.beforeEach(async ({ page }) => {
    const rows = sets
      .map((s) => `<tr><td>2026-11-16</td><td>${s}</td><td>marker.txt</td></tr>`)
      .join("");
    await page.setContent(`<table><tbody>${rows}</tbody></table>`);
  });

  test("resolves to exactly the row in the artifact's own set", async ({ page }) => {
    for (const set of sets) {
      const row = artifactRow(page, { name: "marker.txt", set_name: set });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(set);
    }
  });

  test("a click lands on that row and not on a neighbour", async ({ page }) => {
    await page.evaluate(() => {
      document.querySelectorAll("tr").forEach((tr) => {
        tr.addEventListener("click", () => ((window as unknown as { hit: string }).hit = tr.cells[1].textContent ?? ""));
      });
    });
    await artifactRow(page, { name: "marker.txt", set_name: "workflow-crash" }).click();
    expect(await page.evaluate(() => (window as unknown as { hit: string }).hit)).toBe("workflow-crash");
  });
});
