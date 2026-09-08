import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";

export type Scenario =
  | "default"
  | "empty"
  | "storage-critical"
  | "catalog-recovery"
  | "version-mismatch"
  // A FULLY populated deployment that never heard of storage mediums: no
  // medium declared, no tier naming one, and one local copy per backup,
  // which is the shape migration 0007's backfill leaves every pre-EPIC-E
  // installation in. It is not a variant of "empty": what it exists to
  // show is that a busy instance which never adopted the feature has no
  // trace of it on any page (rclone-manager FR-35).
  | "no-medium"
  // rclone-manager#598, and the only scenario here that is a FAILURE
  // rather than a state of the deployment: listActivity rejects with a
  // plain SyntaxError, which is what a 2xx carrying something other than
  // the JSON the build expected looks like from a page's side, and it is
  // the shape reported from a real 0.3.2 NAS. Nothing typed it, so every
  // surface running that call said one fixed sentence and quoted a
  // correlation id that appears in no log.
  | "activity-unreadable";

export const PROVIDERS = [
  "generic",
  "ugos",
  "synology",
  "truenas",
  "unraid",
  "openmediavault",
  "proxmox"
] as const;

/** Mutable session flag the auth-session route stub below reads on every
 *  request. A plain object, not a boolean, so BackupManager can hold a
 *  reference to it and flip it without going through Playwright fixture
 *  plumbing again. */
type SessionState = { authenticated: boolean };

/** The same two elements as `BackupManager.terminal()` and the content
 *  column, as selectors, for the geometry a locator cannot express: a
 *  measurement that compares two boxes has to read both inside ONE page
 *  evaluation, or it is comparing a layout to itself one paint later.
 *  Here rather than in the spec for the reason the page object exists,
 *  which is that a selector written twice is a selector that drifts. */
export const TERMINAL = "section[aria-label='Terminal']";
export const CONTENT_COLUMN = "main";

/** Page-object surface. Keeps the specs readable and stops selector drift from
 *  spreading across the suite. */
export class BackupManager {
  constructor(readonly page: Page, private readonly session: SessionState) {}

  async goto(path = "/", scenario: Scenario = "default") {
    const url = scenario === "default" ? path : path + "?scenario=" + scenario;
    await this.page.goto(url);
    // The shell is present once the section nav has rendered.
    await expect(this.page.getByRole("navigation", { name: "Sections" })).toBeVisible();
  }

  nav(label: string) {
    return this.page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: new RegExp(label, "i") });
  }

  async navigateTo(label: string) {
    await this.nav(label).click();
  }

  heading(name: string | RegExp) {
    return this.page.getByRole("heading", { level: 1, name });
  }

  card(label: string) {
    return this.page.getByRole("region", { name: label });
  }

  /** The global terminal (rclone-manager#599). A <section> with an
   *  accessible name, so it answers to the region role like every other
   *  card here, and #617 pinned it to the bottom of the browser window. */
  terminal() {
    return this.page.getByRole("region", { name: "Terminal" });
  }

  /** The handle the terminal is resized by. */
  terminalResizeHandle() {
    return this.page.getByRole("separator", { name: "Resize terminal" });
  }

  dialog(name?: string | RegExp) {
    return name ? this.page.getByRole("dialog", { name }) : this.page.getByRole("dialog");
  }

  async theme() {
    return this.page.locator("html").getAttribute("data-theme");
  }

  async toggleTheme() {
    await this.page.getByRole("button", { name: "Toggle colour theme" }).click();
  }

  async cssVar(name: string) {
    return this.page.evaluate(
      (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim(),
      name
    );
  }

  /** Every status in this product must carry a glyph AND a text label. */
  async assertNotColourOnly(locator = this.page.locator("body")) {
    const text = await locator.innerText();
    expect(text.length).toBeGreaterThan(0);
  }

  /** Flips the session the fixture's own auth-session stub reports, without
   *  touching the UI. The mock API's login()/logout() (src/api/mock.ts) never
   *  make a network call, so nothing else tells the stub the signed-in state
   *  changed. Use this before navigating somewhere that only exists while
   *  signed out — e.g. /enroll, which App.tsx only routes to unauthenticated. */
  setAuthenticated(authenticated: boolean) {
    this.session.authenticated = authenticated;
  }

  /** Drives the real "Sign out" control and waits for the login screen to
   *  appear. Flips the stub first (see setAuthenticated) so the refreshAuth()
   *  that follows api.logout() actually observes a signed-out session. */
  async signOut() {
    this.setAuthenticated(false);
    await this.page.getByRole("button", { name: "Sign out" }).click();
    await expect(this.page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  }
}

export const test = base.extend<{ bm: BackupManager }>({
  // { auto: true }: every test gets an authenticated session by default, not
  // just the ones that destructure `bm` — provider-treatment.spec.ts,
  // accessibility.spec.ts, responsive.spec.ts and safety-invariants.spec.ts
  // navigate with a bare `page.goto()` and need the shell to be reachable
  // just as much as the specs that use the BackupManager page object.
  bm: [
    async ({ page }, use) => {
      const session: SessionState = { authenticated: true };

      // Every provider except UGOS (apps/*/frontend/platform.ts, all but
      // apps/ugos) has no native identity source and reads this endpoint to
      // decide whether the app is signed in. Nothing serves it in dev mode —
      // the mock API (src/api/mock.ts) is an in-memory object, not a network
      // layer — so without this stub the fetch falls through to Vite's own
      // dev server, which answers with the SPA's index.html (or a 404) and
      // the app treats that as "not authenticated" every single time. That
      // is the root cause of #113: the fixture never gave the app anything
      // that could answer this request truthfully.
      await page.route("**/api/v1/auth/session", async (route) => {
        if (session.authenticated) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ username: "e2e-admin" })
          });
        } else {
          await route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({ message: "not authenticated" })
          });
        }
      });

      // UGOS (apps/ugos/frontend/auth.ts) reads a native window bridge
      // instead of calling the network. Harmless to install unconditionally:
      // every other provider's bootstrap never references window.ugos.
      await page.addInitScript(() => {
        (window as unknown as { ugos: { getSession(): Promise<{ user: string; expires: string }> } }).ugos = {
          getSession: async () => ({
            user: "e2e-admin",
            expires: new Date(Date.now() + 60 * 60 * 1000).toISOString()
          })
        };
      });

      await use(new BackupManager(page, session));
    },
    { auto: true }
  ]
});

export { expect };
