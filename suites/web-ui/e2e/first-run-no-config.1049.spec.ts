import {
  NEEDS_BREAKABLE_ENGINE,
  canBreakEngine,
  resolveEngineControl,
  startEngine,
  withEngineStopped
} from "../harness/engine";
import { expect, needs, test } from "./fixtures";

/**
 * retnd#1049: a fresh install, on the Settings page and on the one
 * button a failure offers.
 *
 * The deployment this came from is a generic Docker host, installed with
 * install_docker_host.py, opened in a browser at http://<lan-ip>:8080
 * before any backup set existed. Two things were wrong on that screen and
 * both are asserted here against the real deployment rather than against
 * a mock:
 *
 *  1. With no config.yaml yet, the Settings page is a wall of "part of a
 *     configuration this instance has not been given yet", one card (the
 *     account recovery card) is a red ErrorState quoting an API path, and
 *     nothing on the page says what to do next. The engine answers every
 *     read 503 NOT_CONFIGURED, and logs the absent file at ERROR on every
 *     start. The product's own position is that a first install is a
 *     normal state and never an error, so these cases ask for the
 *     opposite of what is there: the engine's own defaults, editable, and
 *     a next step.
 *
 *  2. When a read really did fail (serve-ui could not reach the engine),
 *     the ErrorState's "Copy details" button on a plain-http origin
 *     answers "Could not copy. Select the text above and copy it by hand."
 *     Every NAS is a plain-http origin on a LAN IP, so the button never
 *     works where it is needed. The case below reproduces the real gateway
 *     failure by taking the engine away mid-session (the same control
 *     channel engine-unreachable.spec.ts uses) and then requires the copy
 *     to land on the clipboard.
 *
 * # What "fresh" means to these cases
 *
 * A deployment with no backup set and no backup, read off the API through
 * `facts`. It is deliberately NOT `facts.configured === false`: once the
 * engine writes its own default configuration on first start, a fresh
 * install IS configured and these cases must keep running against it.
 *
 * # Why every case here also records video
 *
 * The issue carries an animated capture of the broken behaviour, cut from
 * this file's own run, so the picture and the assertion come from the
 * same browser session rather than from a hand-driven one.
 */

test.use({ video: "on" });

const NEEDS_FRESH =
  "a fresh install: no backup set and no backup yet (the state an app-store install starts in)";

/** The sentence serve-ui's gateway refusal is rendered as (api/failure.ts,
 *  describeGatewayRefusal). True of a proxy that could not reach the
 *  engine; never true of an engine that answered. */
const COULD_NOT_REACH = /could not reach the retnd service/i;

/** The engine's own 503 sentence on an unconfigured instance
 *  (apps/common/webhost/firstrun.go, writeNotConfigured). An operator who
 *  has not finished setup is told to complete it at an API path. */
const QUOTES_AN_API_PATH = /\/api\/v1\//;

function isFresh(facts: { sets: unknown[]; backups: unknown[] }): boolean {
  return facts.sets.length === 0 && facts.backups.length === 0;
}

test.describe("a fresh install, Settings page", () => {
  test("shows the engine's defaults as editable settings and the next step, not an error", async ({
    bm,
    page
  }) => {
    needs(isFresh(bm.facts), NEEDS_FRESH);
    await bm.goto("/settings");
    // Let every card finish its read: an ErrorState appears only once a
    // fetch has come back, and the page's own loading copy is the gate.
    await expect(page.getByText(/^(Loading|Reading)/)).toHaveCount(0);

    // Nothing on a fresh install is an error. role=alert is what both the
    // ErrorState (tone danger) and WarningBanner (tone warn) render as.
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("Advanced details")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(QUOTES_AN_API_PATH);
    await expect(page.locator("body")).not.toContainText(COULD_NOT_REACH);

    // The page leads: one callout naming the next step, and the step is
    // the first backup set.
    const next = page.getByTestId("first-run-next-step");
    await expect(next).toBeVisible();
    await expect(next).toContainText(/backup set/i);
    await expect(next.getByRole("link").or(next.getByRole("button"))).toBeVisible();

    // And the settings are the defaults the engine wrote, editable now
    // rather than "once the first backup set has been added": polling every
    // 60 minutes is the documented first-run default
    // (core/service.DefaultFirstRunPollInterval).
    const service = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Service behaviour", exact: true }) });
    await expect(service).not.toContainText(/has not been given yet/i);
    await expect(service.getByLabel(/polling interval/i)).toHaveValue("60");
  });

  test("the settings read answers a fresh install with its defaults, not Service Unavailable", async ({
    bm
  }) => {
    needs(isFresh(bm.facts), NEEDS_FRESH);
    const res = await bm.api.get("/api/v1/settings");
    expect(res.status(), "GET /api/v1/settings on a fresh install").toBe(200);
    const body = (await res.json()) as {
      first_run?: unknown;
      service?: { poll_interval_seconds?: unknown };
    };
    // Marked as the engine's own defaults, so a client can say "nobody
    // has changed these yet" rather than guess it from the values.
    expect(body.first_run, "first_run marker on the defaults").toBe(true);
    expect(body.service?.poll_interval_seconds).toBe(3600);
  });
});

test.describe("Copy details, on a plain-http origin", () => {
  test.afterAll(async () => {
    const control = resolveEngineControl();
    if (control !== null) await startEngine(control);
  });

  /** A paste target the harness owns, so what landed on the clipboard can
   *  be read back without the async clipboard API this origin does not
   *  have. */
  async function installPasteTarget(page: import("@playwright/test").Page) {
    await page.evaluate(() => {
      // Fixed at the top of the window and above everything: the global
      // terminal is docked to the bottom and intercepts pointer events
      // for anything appended to the end of the document.
      const target = document.createElement("textarea");
      target.id = "e2e-paste-target";
      target.setAttribute("aria-label", "e2e paste target");
      target.style.cssText =
        "position:fixed;top:8px;left:8px;width:320px;height:64px;z-index:2147483647;";
      document.body.appendChild(target);
    });
  }

  test("control: the harness can observe this origin's clipboard", async ({ bm, page }) => {
    // The case after this one asserts that text REACHED the clipboard. A
    // sweep that cannot see the clipboard reports exactly what a broken
    // copy button reports, so this control proves the observation works
    // on this browser and this origin before the product is held to it.
    await bm.goto("/");
    const origin = await page.evaluate(() => ({
      isSecureContext: window.isSecureContext,
      hasAsyncClipboard: typeof navigator.clipboard?.writeText === "function",
      origin: location.origin
    }));
    expect(
      origin.isSecureContext,
      origin.origin + " is a secure context; this file is about the plain-http LAN origin every NAS has"
    ).toBe(false);
    expect(origin.hasAsyncClipboard, "navigator.clipboard is absent on a plain-http origin").toBe(false);

    await installPasteTarget(page);
    await page.evaluate(() => {
      const source = document.createElement("textarea");
      source.id = "e2e-copy-source";
      source.value = "harness-control-text";
      source.style.cssText =
        "position:fixed;top:80px;left:8px;width:320px;height:40px;z-index:2147483647;";
      document.body.appendChild(source);
      const button = document.createElement("button");
      button.id = "e2e-copy-button";
      button.textContent = "copy control";
      button.style.cssText = "position:fixed;top:128px;left:8px;z-index:2147483647;";
      button.addEventListener("click", () => {
        source.select();
        (window as unknown as { __execCopy?: boolean }).__execCopy = document.execCommand("copy");
      });
      document.body.appendChild(button);
    });
    // A real click, because execCommand("copy") only works inside a user
    // gesture, which is also the gesture the product's button has.
    await page.locator("#e2e-copy-button").click();
    expect(await page.evaluate(() => (window as unknown as { __execCopy?: boolean }).__execCopy)).toBe(true);
    await page.locator("#e2e-paste-target").focus();
    await page.keyboard.press("Control+V");
    await expect(page.locator("#e2e-paste-target")).toHaveValue("harness-control-text");
  });

  test("puts the message, remedy and correlation id on the clipboard, and says Copied", async ({
    bm,
    page
  }) => {
    needs(canBreakEngine(), NEEDS_BREAKABLE_ENGINE);
    test.setTimeout(300_000);
    const control = resolveEngineControl()!;

    // Loaded and signed in while the engine is there, as the operator's
    // tab was; then the engine goes away and the router carries the tab
    // to Settings, where every card's read fails at the proxy.
    await bm.goto("/");
    await installPasteTarget(page);

    await withEngineStopped(control, async () => {
      await bm.navigateTo("Settings");
      const banner = page.getByRole("alert").filter({ hasText: COULD_NOT_REACH }).first();
      await expect(banner).toBeVisible();

      await banner.getByText("Advanced details").click();
      const advanced = await banner.locator("details").innerText();
      const cid = advanced.match(/cid_[A-Za-z0-9]+/)?.[0];
      expect(cid, "the banner carries the correlation id serve-ui logged the proxy_error under").toBeTruthy();

      await banner.getByRole("button", { name: "Copy details" }).click();
      const status = banner.getByRole("status").filter({ hasText: /cop/i });
      await expect(status).toBeVisible();
      await expect(status).not.toHaveText(/could not copy/i);
      await expect(status).toHaveText(/copied/i);

      await page.locator("#e2e-paste-target").focus();
      await page.keyboard.press("Control+V");
      const target = page.locator("#e2e-paste-target");
      await expect(target).toHaveValue(new RegExp(cid!));
      await expect(target).toHaveValue(COULD_NOT_REACH);
    });
  });
});
