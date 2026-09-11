import { resolvePlatform } from "../harness/deployment";
import { expect, needs, test } from "./fixtures";

/** §46 — provider treatment is 5-10%: accent token, window chrome, native
 *  capabilities. This spec proves the shared product is identical across
 *  providers and that no provider claims a capability it lacks (§45).
 *
 *  # It runs once now, not seven times
 *
 *  This used to read `VITE_PLATFORM` and be re-run per provider by
 *  restarting the Vite dev server with a different value each time
 *  (`scripts/e2e-all-providers.mjs`, gone with the dev server). Nothing
 *  here can do that any more, and the reason is the product's own: the
 *  provider bundle is chosen at BUILD time and `serve-ui` serves one
 *  embedded bundle per profile, so a deployment IS one provider. Driving
 *  the other six means building the other six images.
 *
 *  So `RM_PLATFORM` describes which bundle the image under test carries,
 *  and the run asserts that one provider's treatment properly rather than
 *  pretending at a sweep it cannot do. The expectations table below is
 *  kept whole, because the moment the topology builds a second image the
 *  only thing that changes is the variable.
 *
 *  The one thing that got stronger: the mount path. Every provider has a
 *  different storage mount, that path is where backups really land, and
 *  the mock reported it from a fixture. It now comes off a running
 *  container that is really writing there.
 */
const PLATFORM = resolvePlatform();

const EXPECTED: Record<
  string,
  { name: string; integration: string; nativeAuth: boolean; nativeNotify: boolean; picker: boolean; chrome: boolean; mount: string }
> = {
  generic: { name: "Generic Docker / Linux", integration: "Standalone web app", nativeAuth: false, nativeNotify: false, picker: false, chrome: false, mount: "/data/backups" },
  ugos: { name: "UGREEN UGOS Pro", integration: "Native app", nativeAuth: true, nativeNotify: true, picker: true, chrome: true, mount: "/volume1/backupd" },
  synology: { name: "Synology DSM", integration: "Embedded web app", nativeAuth: false, nativeNotify: false, picker: false, chrome: true, mount: "/volume1/backupd" },
  truenas: { name: "TrueNAS", integration: "Container app", nativeAuth: false, nativeNotify: false, picker: false, chrome: false, mount: "/mnt/tank/backupd/backups" },
  unraid: { name: "Unraid", integration: "Container app", nativeAuth: false, nativeNotify: false, picker: false, chrome: false, mount: "/mnt/user/backups/backupd" },
  openmediavault: { name: "OpenMediaVault", integration: "Compose plugin container", nativeAuth: false, nativeNotify: false, picker: false, chrome: false, mount: "/srv/dev-disk-by-uuid/backups/backupd" },
  proxmox: { name: "Proxmox VE", integration: "Standalone web app", nativeAuth: false, nativeNotify: false, picker: false, chrome: false, mount: "/mnt/backupd" }
};

const expected = EXPECTED[PLATFORM];

test.describe("provider: " + PLATFORM, () => {
  test.beforeEach(async ({ bm }) => {
    needs(bm.facts.configured, "a configured deployment: the settings page reads a running service");
  });

  test("identifies itself in the sidebar and settings", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByText(expected.name).first()).toBeVisible();
    await expect(page.getByText(expected.mount).first()).toBeVisible();
  });

  test("keeps the shared information architecture", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Sections" });
    for (const label of ["Dashboard", "Backup sets", "Backups", "Activity", "Quarantine", "Settings"]) {
      await expect(nav.getByRole("link", { name: new RegExp(label, "i") })).toBeVisible();
    }
  });

  test("retains Backupd product identity, not provider branding", async ({ page }) => {
    await page.goto("/");
    // .first(): the product name is legitimately on this page more than
    // once against a real deployment (the header lockup and the footer's
    // "Backupd running on ..."), and an unscoped strict-mode
    // locator resolves to both. The mock rendered fewer of them, which is
    // why this only showed up on the first real run.
    await expect(page.getByText("backupd").first()).toBeVisible();
    const title = await page.title();
    expect(title).toMatch(/Backupd/);
  });

  test("declares an accent token", async ({ page }) => {
    await page.goto("/");
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
    );
    expect(accent).not.toBe("");
  });

  test("draws window chrome only when the platform is embedded", async ({ page }) => {
    await page.goto("/");
    // Anchored on the em dash the titlebar actually uses ("Backupd
    // — <platform>", AppShell.tsx) — the looser ".*" also matched the
    // page footer's "Backupd running on <platform>", which exists
    // regardless of chrome and made this always find something.
    const titlebar = page.getByText(new RegExp("Backupd — " + expected.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (expected.chrome) {
      await expect(titlebar.first()).toBeVisible();
    } else {
      await expect(titlebar).toHaveCount(0);
    }
  });

  test("offers a native storage picker only when supported", async ({ page }) => {
    // /sets/new is reachable on any instance, configured or not: it is the
    // page a first-run deployment sends an operator to.
    await page.goto("/sets/new");
    await page.getByRole("button", { name: "Storage & validation" }).click();

    if (expected.picker) {
      await expect(page.getByRole("button", { name: /Browse volumes/ })).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: /Browse volumes/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Validate path" })).toBeVisible();
      await expect(page.getByText(/no native storage picker/)).toBeVisible();
    }
  });

  test("describes notifications honestly", async ({ page }) => {
    await page.goto("/settings");
    if (expected.nativeNotify) {
      await expect(page.getByText(/Native .* notifications are available and enabled/)).toBeVisible();
    } else {
      await expect(page.getByText(/Native NAS notifications are not available/)).toBeVisible();
    }
  });

  test("reports the correct authentication mode", async ({ page }) => {
    await page.goto("/settings");
    if (expected.nativeAuth) {
      // .first() — Settings renders both a compact and a full PlatformBadge,
      // so this text is legitimately repeated more than once on this page.
      await expect(page.getByText(new RegExp(expected.name + " session")).first()).toBeVisible();
    } else {
      await expect(page.getByText("Backupd local account").first()).toBeVisible();
    }
  });

  test("contains no provider-specific lifecycle UI", async ({ page }) => {
    // A sweep over real pages drawing real rows now, which is when a
    // provider name qualifying a lifecycle word would actually appear:
    // against the mock, the vocabulary on screen came from a fixture that
    // had never heard of a provider either.
    for (const path of ["/", "/sets", "/backups", "/quarantine"]) {
      await page.goto(path);
      const text = await page.locator("body").innerText();
      // Lifecycle vocabulary is shared; a provider name must never qualify it.
      expect(text).not.toMatch(new RegExp(expected.name + " (transfer|commit|retention)", "i"));
    }
  });
});
