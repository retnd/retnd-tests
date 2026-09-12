import type { Page } from "@playwright/test";

import {
  CSRF_COOKIE,
  LEGACY_CSRF_COOKIE,
  LEGACY_SESSION_COOKIE,
  SESSION_COOKIE
} from "../harness/session";
import { expect, test } from "./fixtures";

/** §30 — the login must not resemble a NAS system login, and must say so.
 *
 *  Every other spec in this suite starts signed in. This file is the one
 *  place that deliberately does not, and against a real deployment that
 *  changed shape rather than just implementation.
 *
 *  It used to flip `bm.setAuthenticated(false)`, a boolean inside a
 *  `page.route` stub, and then navigate. Nothing was signed out: the app
 *  simply started being told it was not. Now there is a real session, a
 *  real `POST /api/v1/auth/logout` that revokes it in the service, and a
 *  real login page served by the same process.
 *
 *  Which is why the describe below says `test.use({ signedIn: false })`
 *  rather than signing out in each case. Two reasons, and both are about
 *  the real path rather than about tidiness:
 *
 *  1. a browser with no session IS what an operator arrives with, so it is
 *     the honest way to reach these screens;
 *  2. apps/common/auth/local allows ten logins a minute per client
 *     address. A file that signed out six times would spend six of them
 *     re-establishing the worker's session afterwards, and a run that
 *     tripped the limiter would report a product failure that is really a
 *     fixture failure.
 *
 *  The one case that is ABOUT signing out keeps its session and presses
 *  the button, because that is the thing under test. */

test.describe("signing out", () => {
  test("sign-out lands on the Backupd login", async ({ page, bm }) => {
    await bm.goto("/");
    // The real control, reaching the real endpoint. On the mock,
    // api.logout() never made a network call at all and the stub had to be
    // told separately that anything had happened.
    await bm.signOut();

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText(/not.*your NAS operating-system login/i)).toBeVisible();
    await expect(page.getByRole("img", { name: "Backupd" })).toBeVisible();
  });

  test("the session it dropped is really gone from the service", async ({ page, bm, context }) => {
    // The half no mock could ever have proven, and the reason logging out
    // is worth a case of its own: handleLogout calls sessions.revoke, so
    // the token this browser was carrying stops authenticating for
    // everyone, not just for this tab. Asked through the API rather than
    // through a page, so the answer is the service's and not a router's.
    await bm.goto("/");
    expect((await context.request.get("/api/v1/auth/session")).status()).toBe(200);

    await bm.signOut();

    expect((await context.request.get("/api/v1/auth/session")).status()).toBe(401);
    // And the page agrees with the service, which is the thing that was
    // stubbed before: the session endpoint used to answer whatever the
    // fixture's boolean said, so the two could not disagree even in
    // principle.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});

test.describe("the login form", () => {
  test.use({ signedIn: false });

  test("greets a browser with no session at all", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText(/not.*your NAS operating-system login/i)).toBeVisible();
  });

  test("login requires both fields", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    const username = page.getByLabel("Username");
    await expect(username).toHaveAttribute("required", "");
    // exact, matching the enrolment test below: the sign-in form's own
    // password label is exactly "Password" (LoginPage's HelpField puts
    // nothing else inside that <label>), and spelling it as a substring is
    // what lets a "Confirm password" landing here later resolve two
    // elements and fail on strict mode rather than on the product.
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");
  });

  test("uses correct autocomplete hints for password managers", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel("Username")).toHaveAttribute("autocomplete", "username");
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
      "autocomplete",
      "current-password"
    );
  });

  test("refuses a wrong password, and says so without echoing it", async ({ page }) => {
    // New here, and only possible now. Against the mock, login() resolved
    // without a network call, so a wrong password had no meaning and this
    // whole refusal path was unreachable from a browser. It is one of the
    // ten attempts a minute the service allows, spent deliberately.
    await page.goto("/");
    await page.getByLabel("Username").fill("definitely-not-an-administrator");
    // A value chosen to be wrong, and long enough to clear the form's own
    // length rule so the refusal comes from the service rather than the
    // browser.
    const wrong = "this-password-belongs-to-nobody";
    await page.getByLabel("Password", { exact: true }).fill(wrong);

    const [refused] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/v1/auth/login") && r.request().method() === "POST"),
      page.getByRole("button", { name: "Sign in" }).click()
    ]);
    expect(refused.status()).toBe(401);

    // Still on the login screen, told something happened, and the thing
    // typed is nowhere on the page.
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain(wrong);
  });

  test("first-run enrolment explains account scope", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /Create the administrator account/ }).click();

    await expect(page.getByRole("heading", { name: /Create Backupd administrator/ })).toBeVisible();
    await expect(
      page.getByText(/manages Backupd only.*separate from your NAS operating-system account/s)
    ).toBeVisible();
  });

  test("enrolment enforces length and confirmation before enabling submit", async ({ page }) => {
    // /enroll is only served while signed out (App.tsx routes it away once
    // authenticated), and there is no shell to wait for here, so this goes
    // straight through page.goto rather than bm.goto.
    //
    // Nothing here submits: every assertion is about the form refusing
    // BEFORE anything reaches the service, which is the same claim it
    // always made and the only half of enrolment a run against an
    // already-enrolled deployment can make. The submitting half is
    // harness/session.ts's, on a deployment that still has no
    // administrator.
    await page.goto("/enroll");

    const submit = page.getByRole("button", { name: "Create administrator" });
    await expect(submit).toBeDisabled();

    // Prefix regex, not exact: true — the "Minimum 12 characters." warning
    // renders inside this field's own <label>, so its accessible name grows
    // from "Password" to "PasswordMinimum 12 characters." (Playwright's own
    // label-text accumulation, unlike a screen reader's accessibility tree,
    // does not insert a separator between sibling text nodes) the moment a
    // too-short value is typed. A leading-anchored prefix still can't
    // collide with "Confirm password", which starts with "Confirm".
    const password = page.getByLabel(/^Password/);
    // Same treatment, and for a sharper version of the same reason. The
    // "Passwords do not match." warning renders inside THIS field's own
    // <label> too, so the moment a mismatching value is typed the accessible
    // name grows from "Confirm password" to
    // "Confirm passwordPasswords do not match.". An { exact: true } locator
    // would resolve to zero elements from that point on, which is the second
    // fill below: it would fail, not silently pass, but it would fail for a
    // reason that has nothing to do with what the test is checking. A
    // leading-anchored prefix survives the name growing and still cannot
    // collide with a "Show confirm password" toggle button, which starts
    // with "Show" (backupd#344).
    const confirm = page.getByLabel(/^Confirm password/);
    await page.getByLabel("Username").fill("bm-admin");
    await password.fill("short");
    await expect(page.getByText(/Minimum 12 characters/).first()).toBeVisible();
    await expect(submit).toBeDisabled();

    await password.fill("a-long-enough-passphrase");
    await confirm.fill("different-passphrase");
    await expect(page.getByText("Passwords do not match")).toBeVisible();
    await expect(submit).toBeDisabled();

    await confirm.fill("a-long-enough-passphrase");
    await expect(page.getByText("Passwords do not match")).toHaveCount(0);
    await expect(submit).toBeEnabled();
  });

  test("never echoes a password in the DOM as plain text", async ({ page }) => {
    await page.goto("/enroll");
    await page.getByLabel("Password", { exact: true }).fill("super-secret-passphrase");
    expect(await page.locator("body").innerText()).not.toContain("super-secret-passphrase");
  });
});

test.describe("what the service says about this session", () => {
  test("the shell is reached on a session the service itself issued", async ({
    bm,
    context,
    deployment
  }) => {
    // The positive control for this whole file, and for the fixture. Every
    // other spec in the suite starts from an authenticated shell, and
    // until this move that shell was reached by intercepting
    // `**\/api/v1/auth/session` and answering `{"username":"e2e-admin"}`.
    // "The app is signed in" was true by construction and proved nothing:
    // there was no session, no cookie and no service.
    //
    // Now it is a claim about the deployment, and it is asserted three
    // ways so none of them can be satisfied by an accident: the browser is
    // carrying both halves of the real cookie pair, the service recognises
    // the session, and the account it names is the one this run's
    // credentials belong to rather than any string a stub could return.
    await bm.goto("/");

    // Either name, because the build under test can be either side of
    // backupd#794's rename and this case is about a session existing, not
    // about which release named it (harness/session.ts).
    const cookies = (await context.cookies()).map((c) => c.name);
    expect(cookies.filter((name) => name === SESSION_COOKIE || name === LEGACY_SESSION_COOKIE))
      .not.toHaveLength(0);
    // The CSRF half of the pair, which every mutating request in every
    // other spec depends on and which no page can function without.
    expect(cookies.filter((name) => name === CSRF_COOKIE || name === LEGACY_CSRF_COOKIE))
      .not.toHaveLength(0);

    const session = await context.request.get("/api/v1/auth/session");
    expect(session.status()).toBe(200);
    expect(((await session.json()) as { username?: string }).username).toBe(
      deployment.credentials.username
    );
  });
});

/** backupd#795, the half of it that is about 403 rather than about 502.
 *
 *  `/api/v1/auth/session`'s contract has exactly one answer that means
 *  "this browser is not signed in", and it is 401. A 403 is the service
 *  having looked and refused on POLICY - an authorization layer, a proxy
 *  rule, an account disabled between one request and the next - and the
 *  one action it is guaranteed not to be fixed by is the one a login form
 *  offers. Reading it as signed-out is #795's own mistake made on a
 *  smaller scale: a refusal the frontend did not understand, rendered as a
 *  verdict about the operator.
 *
 *  Nor is it the outage page. Something DID answer, in one round trip,
 *  with a status and often with a sentence explaining the policy; telling
 *  the operator that Backupd is not answering sends them to restart a
 *  service that is running.
 *
 *  `page.route` for the same reason `activity-failure.spec.ts` uses it: a
 *  real deployment answering this route 403 is a deployment misconfigured
 *  in a way no run can arrange, and only the bytes on the wire are
 *  substituted - the bundle, the auth gate, the router and the surface
 *  that renders are all the real ones. */
async function refuseSession(page: Page, body: string | null) {
  await page.route("**/api/v1/auth/session", async (route) => {
    if (body === null) {
      // What a proxy's own denial looks like: a status and nothing to
      // read. The frontend has no sentence to quote and still may not
      // invent one about the session.
      await route.fulfill({ status: 403, contentType: "text/plain", body: "" });
      return;
    }
    await route.fulfill({ status: 403, contentType: "application/json", body });
  });
}

/** The service's own words for this refusal, chosen to be unmistakably
 *  not a string this frontend could have produced. */
const POLICY_MESSAGE = "This account may not sign in from this network.";

test.describe("a session the service refuses to discuss", () => {
  test("does not ask for a password it has been told will not help", async ({ page }) => {
    await refuseSession(
      page,
      JSON.stringify({ error: { code: "forbidden", message: POLICY_MESSAGE } })
    );
    await page.goto("/");

    // The load-bearing absence. A 403 rendered as the login screen is an
    // operator typing a correct password into a form that will answer 403
    // again, with no way to learn why from either screen.
    await expect(page.getByRole("heading", { name: /^sign in$/i })).toHaveCount(0);
    await expect(page.locator("input[type='password']")).toHaveCount(0);
  });

  test("says the service refused rather than that it did not answer", async ({ page }) => {
    await refuseSession(
      page,
      JSON.stringify({ error: { code: "forbidden", message: POLICY_MESSAGE } })
    );
    await page.goto("/");

    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Backupd could not check your session",
        exact: true
      })
    ).toBeVisible();
    // Verbatim. The service explained its own policy, and a frontend that
    // paraphrases it is a frontend that has decided it understands a rule
    // it has never seen; #598 is what that costs.
    await expect(page.getByRole("alert")).toContainText(POLICY_MESSAGE);
    // And not the outage wording, which belongs to a request that got no
    // answer at all - this one got one, immediately.
    await expect(page.locator("body")).not.toContainText(/is not answering|did not answer/i);
  });

  test("says something an operator can act on even when the refusal carries no words", async ({
    page
  }) => {
    await refuseSession(page, null);
    await page.goto("/");

    // Nothing to quote, so the frontend must say what it actually knows -
    // that it could not find out - and must still not offer the login
    // form as the answer.
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Backupd could not check your session",
        exact: true
      })
    ).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(
      "Backupd could not answer whether this browser is signed in."
    );
    await expect(page.getByRole("heading", { name: /^sign in$/i })).toHaveCount(0);
  });

  test("never renders the placeholder correlation id on this surface", async ({ page }) => {
    await refuseSession(
      page,
      JSON.stringify({ error: { code: "forbidden", message: POLICY_MESSAGE } })
    );
    await page.goto("/");

    // #598's string, asserted here because this surface is new and the
    // ban is on the product rather than on any one page. The alert is
    // asserted first so a build that drew nothing at all cannot satisfy
    // the absence.
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("correlation id unavailable");
  });
});
