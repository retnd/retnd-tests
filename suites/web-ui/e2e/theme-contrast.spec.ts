import {
  UNREADABLE,
  contrastReadings,
  plantUnreadableControl,
  removeUnreadableControl,
  report,
  unreadable
} from "./contrast";
import { expect, test } from "./fixtures";

/**
 * rclone-manager#618: dark mode drew black text on native controls, worst
 * in the SSH auth wizard.
 *
 * # Why this needs a browser at all
 *
 * The cause was the user agent's own default stylesheet. Nothing in the
 * app declared `color-scheme`, so every browser assumed light for its own
 * controls whatever `data-theme` said, and an `input`, `select`,
 * `textarea` or `button` given no colour took the UA's black. jsdom does
 * not implement any of that, so the unit tests upstream read the source as
 * text on purpose and only a real browser can say what was painted.
 *
 * # Why a computed floor and not a list of selectors
 *
 * The defect had no selector. It belonged to whichever component last
 * styled a control without naming a colour, and a list of the ones that
 * had done it would have been out of date the next time somebody wrote an
 * inline style. So `contrast.ts` walks the rendered tree and computes the
 * ratio between what each element paints and what it paints it on, and
 * these cases assert a floor over the whole reading.
 *
 * # The shapes, and the case that keeps the others honest
 *
 * The sweep runs over every page in dark mode and over the SSH wizard's
 * own controls, which is where the black text was reported. The primary
 * button gets a case of its own, because its failure pointed the other
 * way: it was a hardcoded white on an accent that is LIGHT in dark mode,
 * and it measures 2.67:1, which is unreadable but sits ABOVE a floor
 * placed under everything the product legitimately ships. Then all of it
 * again in light mode, because a fix that trades one theme for the other
 * is not a fix.
 *
 * # What each case is and is not evidence of
 *
 * Against the build this replaced, the six-page sweep passes in BOTH
 * themes, and that is worth saying out loud rather than leaving as a
 * surprise: none of those six pages had a control nobody had coloured, so
 * the sweep guards against the next one rather than reproducing this one.
 * The located reds there are the wizard's own controls (its Close button
 * drew black on the dark surface, 1.24:1), the primary button in dark
 * mode, the `color-scheme` declaration and the floor rule under a bare
 * control.
 *
 * The light-mode copies of the last two are red there too, which is the
 * systemic half showing: the browser was never told which palette to use
 * in either theme, it just happened to guess right in one of them.
 *
 * And a sweep that has quietly stopped seeing anything reports exactly
 * what a healthy page reports, so the last case in this file plants a
 * control that is unreadable on purpose and requires the sweep to name it.
 * That is where the sweep's teeth come from, in both themes.
 */

const PAGES = ["/", "/sets", "/backups", "/activity", "/quarantine", "/settings"];

/** Opens the wizard the issue is named for, on the first backup set, and
 *  leaves a key selected so its primary button is live rather than
 *  disabled. */
async function openSSHWizard(bm: import("./fixtures").BackupManager) {
  const page = bm.page;
  await page.getByRole("article").first().getByRole("button", { name: "Open" }).click();
  await page.getByRole("button", { name: "Change SSH authentication" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // A key from the store, so "Next" is enabled and the accent pairing
  // being read is the one an operator actually walks through.
  await dialog.getByRole("button", { name: /^ssh-/ }).first().click();
  await expect(dialog.getByRole("button", { name: /^Next:/ })).toBeEnabled();
  return dialog;
}

/** The reading for the wizard's primary button, with the wizard opened
 *  from scratch. Its own function because two cases need it and one of
 *  them needs it twice, once per theme. */
async function primaryButtonReading(bm: import("./fixtures").BackupManager) {
  await bm.goto("/sets");
  await openSSHWizard(bm);
  const readings = await contrastReadings(bm.page, "[role='dialog']");
  const primary = readings.filter((r) => r.what.startsWith("button") && r.what.includes("Next:"));
  // The premise. A selector that stopped matching hands back an empty
  // list, and every assertion below is vacuously true of one.
  expect(primary.length, "the wizard's primary button was read").toBe(1);
  return primary[0];
}

/** WCAG AA for body text. Used on one named control, not on the sweep;
 *  UNREADABLE's own comment says why the two numbers differ. */
const AA = 4.5;

for (const theme of ["dark", "light"] as const) {
  test.describe(theme + " mode is readable", () => {
    test.beforeEach(async ({ bm }) => {
      await bm.goto("/");
      if ((await bm.theme()) !== theme) await bm.toggleTheme();
      expect(await bm.theme()).toBe(theme);
    });

    test("no page paints text its own background has swallowed", async ({ bm, page }) => {
      const found: string[] = [];
      for (const path of PAGES) {
        await bm.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await bm.theme(), "the theme survived navigating to " + path).toBe(theme);

        const bad = unreadable(await contrastReadings(page));
        if (bad.length > 0) found.push(path + "\n" + report(bad));
      }
      expect(found.join("\n\n"), "unreadable text in " + theme + " mode").toBe("");
    });

    test("the SSH auth wizard's fields, textarea and buttons are readable", async ({ bm, page }) => {
      await bm.goto("/sets");
      const dialog = await openSSHWizard(bm);

      const readings = await contrastReadings(page, "[role='dialog']");
      // The premise. A wizard that failed to open, or a selector that
      // stopped matching, hands back an empty list, and an empty list
      // satisfies every floor there is.
      const controls = readings.filter((r) => /^(input|textarea|select|button)/.test(r.what));
      expect(controls.length, "native controls read inside the wizard").toBeGreaterThan(3);
      await expect(dialog.locator("textarea")).toHaveCount(1);
      await expect(dialog.locator("input")).toHaveCount(1);

      expect(report(unreadable(controls)), "unreadable controls in the SSH wizard").toBe("");
    });

    test("the wizard's primary button clears AA on the accent it sits on", async ({ bm }) => {
      const primary = await primaryButtonReading(bm);

      // AA, not the sweep's floor, and deliberately. The sweep's floor is
      // placed under the worst thing the whole product legitimately ships
      // today, which leaves it under this: a hardcoded white on the
      // dark-mode accent measures 2.67:1, above that line and nowhere near
      // readable. This is one named control, it is the action of the step,
      // and the build that fixed it clears AA in both themes with room
      // (5.48:1 and 6.35:1), so holding it to AA costs nothing and catches
      // the half of #618 the sweep cannot.
      expect(
        primary.ratio,
        "primary button " + primary.color + " on " + primary.background
      ).toBeGreaterThanOrEqual(AA);
    });

    test("the browser is told which palette to draw its own controls in", async ({ page }) => {
      // The systemic half. Without this every case above can be satisfied
      // one component at a time and the next component to style a control
      // inline walks into the same trap.
      const declared = await page.evaluate(
        () => getComputedStyle(document.documentElement).colorScheme
      );
      expect(declared).toBe(theme);
    });

    test("a native control that names no colour still gets the theme's text colour", async ({ page }) => {
      // The floor rule, read where it matters. A bare control is given the
      // theme's own text colour at single-element specificity, so every
      // class rule and every inline style still wins and only a control
      // nobody coloured is caught. That is the acceptance criterion this
      // issue closes with, and the reason the SSH wizard was not the whole
      // fix.
      const reading = await page.evaluate(() => {
        const el = document.createElement("input");
        el.id = "bare-native-control";
        document.body.appendChild(el);
        const resolved = getComputedStyle(el).color;
        const themed = getComputedStyle(document.documentElement).getPropertyValue("--text").trim();
        el.remove();
        const probe = document.createElement("span");
        probe.style.color = themed;
        document.body.appendChild(probe);
        const themedResolved = getComputedStyle(probe).color;
        probe.remove();
        return { resolved, themedResolved };
      });
      expect(reading.resolved).toBe(reading.themedResolved);
    });
  });
}

test.describe("what is written on the accent", () => {
  test("inverts with the theme, because the accent itself does", async ({ bm }) => {
    // The reason the fix is `var(--surface)` and not a literal white. The
    // accent is not one colour: it is oklch lightness 0.52 in light mode
    // and 0.70 in dark, so it crosses from a dark fill to a light one and
    // the label on it has to cross the other way. A build that writes one
    // fixed colour on it is right in exactly one theme, whichever one it
    // was picked in.
    await bm.goto("/");
    if ((await bm.theme()) !== "light") await bm.toggleTheme();
    const light = await primaryButtonReading(bm);

    await bm.goto("/");
    await bm.toggleTheme();
    expect(await bm.theme()).toBe("dark");
    const dark = await primaryButtonReading(bm);

    // The premise: the accent really does swap sides between the themes.
    expect(dark.luminance.background).toBeGreaterThan(light.luminance.background);

    // And the label swaps with it: lighter than its fill in one theme,
    // darker than its fill in the other.
    expect(light.luminance.text).toBeGreaterThan(light.luminance.background);
    expect(dark.luminance.text).toBeLessThan(dark.luminance.background);
    expect(light.color).not.toBe(dark.color);
  });
});

test.describe("the sweep itself", () => {
  // Every case above passes when the sweep has stopped working. A colour
  // notation it cannot parse, a backdrop walk that stops at the wrong
  // node, a root selector that matches nothing: all three report zero
  // violations, which is what a healthy page reports too. So this plants
  // one and requires it to be named.
  for (const theme of ["dark", "light"] as const) {
    test("sees a control painted on its own colour, in " + theme + " mode", async ({ bm, page }) => {
      await bm.goto("/");
      if ((await bm.theme()) !== theme) await bm.toggleTheme();

      expect(unreadable(await contrastReadings(page)), "the page starts clean").toEqual([]);

      await plantUnreadableControl(page);
      const bad = unreadable(await contrastReadings(page));
      expect(bad.map((r) => r.what)).toEqual([
        'button "planted by the contrast sweep"'
      ]);
      expect(bad[0].ratio).toBeCloseTo(1, 1);

      await removeUnreadableControl(page);
      expect(unreadable(await contrastReadings(page)), "and the page is clean again").toEqual([]);
    });
  }
});
