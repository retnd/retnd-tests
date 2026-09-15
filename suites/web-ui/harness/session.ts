// Signing in for real.
//
// What this replaced was a `page.route` stub on `**/api/v1/auth/session`
// that answered `{"username":"e2e-admin"}` to every request. Nothing
// authenticated, nothing was ever refused, and no test in this suite could
// fail on anything the login path does. The whole point of pointing the
// suite at a real deployment is that this is now the real double-submit
// CSRF handshake against the real service, and a run whose credentials are
// wrong stops before it asserts anything.
//
// # The handshake, in the order it has to happen
//
//  1. GET any page. `apps/common/csrf`'s EnsureCookie runs in front of
//     EVERY response this service sends, precisely so a fresh client has a
//     token to echo before it needs one, and sets `retnd_csrf` (or, on an
//     older build, `backupd_csrf` or `bm_csrf` - see LEGACY_CSRF_COOKIE).
//  2. POST /api/v1/auth/login carrying that cookie AND its value again in
//     the `X-CSRF-Token` header. The cookie is what a cross-site attacker
//     can make a browser send; the header is what it cannot read to
//     construct, and the service compares the two in constant time.
//  3. A 204 with a `retnd_session` cookie. That cookie is what the
//     browser then carries, and everything else in this suite runs on it.
//
// A fresh install has no administrator to log in as, and enrolment is the
// step in front of the whole thing: POST /api/v1/auth/enroll, same CSRF
// pair, plus the single-use `X-Bootstrap-Token` the engine printed to its
// own log. This module will do that when it is handed a token, and will
// refuse loudly rather than quietly when it is not.
//
// # Nothing here writes a credential down
//
// Not to a file, not to an argv, not into a message. In particular there
// is no `storageState` FILE: the cookies come back as an in-memory object
// and are handed to a browser context directly. And no failure path in
// this module quotes a response body, because a refusal from these two
// routes can echo what was submitted, and what was submitted is a
// password.

import { request } from "@playwright/test";
import type { APIRequestContext, BrowserContext, Cookie } from "@playwright/test";

import type { Deployment } from "./deployment";
import { BOOTSTRAP_TOKEN_VAR, PASSWORD_VAR, USERNAME_VAR } from "./deployment";

/** apps/common/csrf's double-submit pair. Written down rather than
 *  imported, because nothing here depends on the product's source tree,
 *  and repeated in the comment above with the reason it is two things. */
export const CSRF_COOKIE = "retnd_csrf";
export const CSRF_HEADER = "X-CSRF-Token";
/** apps/common/auth/local's session cookie, and its single-use enrolment
 *  header (BootstrapTokenHeader). */
export const SESSION_COOKIE = "retnd_session";
export const BOOTSTRAP_HEADER = "X-Bootstrap-Token";

/** What those two cookies were called before this product's last two
 *  renames, and why all three names are still here.
 *
 *  The product reads any of the three and writes only the current one:
 *  `apps/common/csrf` holds them in exactly this order in `cookieNames`
 *  (`CookieName`, `LegacyCookieName`, `EarlierCookieName`), with
 *  `apps/common/auth/local`'s `sessionCookieNames` beside it, so a bundle
 *  cached from before either rename keeps working while a fresh client is
 *  issued the new name. This suite mirrors that list rather than
 *  inventing its own order, for a different reason than the product has:
 *  it is pinned at a build under test that may be on either side of
 *  either rename, and a run against an older image should assert on the
 *  product rather than die in a fixture.
 *
 *  `backupd_*` is what EPIC R (backupd#885) renamed; `bm_*` is what
 *  backupd#794 renamed before it, and that window closes with the
 *  product's, in the same release and by the same issue — this list
 *  shortens when `apps/common/csrf`'s does, not before and not after.
 *
 *  The old names ALONE are exactly how this suite spent a release
 *  reporting nothing: every case failed in the worker fixture with "GET /
 *  set no bm_csrf cookie" before it could assert anything at all. Which
 *  is the argument for reading every name and preferring the newest,
 *  rather than for tracking one. */
export const LEGACY_CSRF_COOKIE = "backupd_csrf";
export const LEGACY_SESSION_COOKIE = "backupd_session";
export const EARLIER_CSRF_COOKIE = "bm_csrf";
export const EARLIER_SESSION_COOKIE = "bm_session";

/** Every accepted CSRF cookie name, newest first, and the session's the
 *  same. Mirrors `apps/common/csrf`'s `cookieNames` exactly. */
export const CSRF_COOKIE_NAMES = [CSRF_COOKIE, LEGACY_CSRF_COOKIE, EARLIER_CSRF_COOKIE] as const;
export const SESSION_COOKIE_NAMES = [
  SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
  EARLIER_SESSION_COOKIE
] as const;

/** Reads one cookie's value out of what a request context is holding. */
export function cookieValue(cookies: readonly Cookie[], name: string): string {
  const found = cookies.find((c) => c.name === name);
  return found ? found.value : "";
}

/** The CSRF token this jar carries, under whichever name issued it.
 *
 *  Newest name first, exactly like `apps/common/csrf`'s own read and
 *  `ui/shared/src/api/client.ts`: a jar holding more than one is a jar
 *  mid-rename, and the newest is the one the service just set. */
export function csrfCookieValue(cookies: readonly Cookie[]): string {
  return firstNamed(cookies, CSRF_COOKIE_NAMES);
}

/** The headers a mutating request has to carry, read out of the cookie
 *  the same request context is already holding.
 *
 *  Here rather than beside the arrange steps that use it, because there
 *  are now two modules that arrange the deployment through its API -
 *  `harness/api.ts` and `harness/workflow.ts` - and a second copy of this
 *  would be a second place to get the legacy cookie name wrong. */
export async function csrfHeaders(api: APIRequestContext): Promise<Record<string, string>> {
  const token = csrfCookieValue((await api.storageState()).cookies);
  if (token === "") {
    throw new Error(
      "this request context carries no CSRF cookie under any accepted name (" +
        CSRF_COOKIE_NAMES.join(", ") +
        "), so a mutating call would be refused with CSRF_TOKEN_MISSING. A context that has " +
        "never loaded a page from this origin is the usual cause."
    );
  }

  return { [CSRF_HEADER]: token, "content-type": "application/json" };
}

/** The session this jar carries, under whichever name issued it. */
export function sessionCookieValue(cookies: readonly Cookie[]): string {
  return firstNamed(cookies, SESSION_COOKIE_NAMES);
}

/** The value under the first of `names` that this jar actually carries.
 *
 *  Empty string rather than undefined when none of them is there: every
 *  caller compares against "" to decide whether the handshake got
 *  anywhere, and a caller that had to check for undefined too is a caller
 *  that will forget. */
function firstNamed(cookies: readonly Cookie[], names: readonly string[]): string {
  for (const name of names) {
    const value = cookieValue(cookies, name);
    if (value !== "") return value;
  }
  return "";
}

/** The cookies a signed-in browser needs, in Playwright's own shape so
 *  they can be handed straight to `BrowserContext.addCookies`. Held in
 *  memory only. */
export type SessionCookies = readonly Cookie[];

async function csrfToken(api: APIRequestContext): Promise<string> {
  // Any page will do: the CSRF middleware sits in front of every response,
  // including the very first page load, which is the one that has to set
  // this cookie.
  const first = await api.get("/");
  if (first.status() >= 500) {
    throw new Error(
      "the deployment answered " + first.status() + " to a plain GET /, so it is not serving the Web UI yet. " +
        "Nothing was submitted to it."
    );
  }
  const token = csrfCookieValue((await api.storageState()).cookies);
  if (token === "") {
    throw new Error(
      "GET / set no CSRF cookie under any accepted name (" + CSRF_COOKIE_NAMES.join(", ") +
        "), so there is " +
        "no token to echo back and every state-changing request would be refused with " +
        "CSRF_TOKEN_MISSING. Either the URL is not this product, or it is being served without " +
        "apps/common/csrf's middleware."
    );
  }
  return token;
}

/** Signs in, enrolling first if the deployment has no administrator yet
 *  and this run was handed the token that lets it create one.
 *
 *  Returns the cookies a browser context needs. The request context it
 *  used is disposed before this returns, so the only surviving copy of the
 *  session is the value handed back.
 *
 *  Never quotes a response body. A refusal is reported as its status and,
 *  where the service gives one, its stable error code. */
export async function signIn(deployment: Deployment): Promise<SessionCookies> {
  const api = await request.newContext({ baseURL: deployment.baseURL });
  try {
    const token = await csrfToken(api);
    const headers = { [CSRF_HEADER]: token, "content-type": "application/json" };
    const { username, password } = deployment.credentials;

    const login = await api.post("/api/v1/auth/login", { headers, data: { username, password } });
    if (login.status() === 204) return sessionFrom(await api.storageState(), "login");

    // 401 on a deployment with no administrator and 401 on a wrong
    // password are the same answer, deliberately (the handler pays
    // Argon2id's cost either way so the two cannot be told apart by
    // timing). So enrolment is attempted when there is a token to attempt
    // it with, and its own refusal is what says which of the two it was.
    if (login.status() === 401 && deployment.bootstrapToken !== null) {
      const enrol = await api.post("/api/v1/auth/enroll", {
        headers: { ...headers, [BOOTSTRAP_HEADER]: deployment.bootstrapToken },
        data: { username, password }
      });
      if (enrol.status() === 204) return sessionFrom(await api.storageState(), "enrolment");
      throw new Error(
        "sign-in was refused (401) and so was enrolment (" + enrol.status() + " " +
          (await errorCode(enrol)) + "). " +
          "ENROLLMENT_CLOSED there means an administrator already exists, so the 401 above is a wrong " +
          "password in " + PASSWORD_VAR + " rather than a deployment that needed enrolling. " +
          "BOOTSTRAP_TOKEN_INVALID means the token in " + BOOTSTRAP_TOKEN_VAR + " was missing, expired, or " +
          "already spent, and it is single-use."
      );
    }

    if (login.status() === 401) {
      throw new Error(
        "sign-in was refused (401 " + (await errorCode(login)) + "). Either " + USERNAME_VAR + "/" +
          PASSWORD_VAR + " do not name an administrator on this deployment, or it has none yet, and " +
          "those two cases answer identically on purpose. Set " + BOOTSTRAP_TOKEN_VAR + " to the " +
          "single-use token the engine printed if this deployment still needs enrolling."
      );
    }
    if (login.status() === 429) {
      throw new Error(
        "sign-in was rate-limited (429). apps/common/auth/local allows ten attempts a minute per client " +
          "address, and this suite is built to spend one per worker: a run hitting this is re-signing-in " +
          "far more often than it should be, which is a defect in the fixture rather than in the product."
      );
    }
    throw new Error(
      "sign-in returned " + login.status() + " " + (await errorCode(login)) + " rather than 204."
    );
  } finally {
    await api.dispose();
  }
}

function sessionFrom(state: { cookies: Cookie[] }, how: string): SessionCookies {
  const cookies = state.cookies;
  if (sessionCookieValue(cookies) === "") {
    throw new Error(
      how + " reported success but set no session cookie under any accepted name (" +
        SESSION_COOKIE_NAMES.join(", ") + "), so nothing is signed in. " +
        "A proxy in front of the service that drops Set-Cookie looks exactly like this."
    );
  }
  return cookies;
}

/** The stable error code beside a refusal, or a placeholder.
 *
 *  Reads ONLY the `code` field, and never the message or the rest of the
 *  body. The codes are a closed registry (apps/common/webhost/apicontract)
 *  and cannot carry a submitted credential; the message beside them may
 *  change without notice and a refusal can quote what it refused. */
async function errorCode(response: { json(): Promise<unknown> }): Promise<string> {
  try {
    const body = (await response.json()) as { code?: unknown; error?: { code?: unknown } };
    const code = typeof body.code === "string" ? body.code : body.error?.code;
    return typeof code === "string" && code !== "" ? code : "(no code)";
  } catch {
    return "(no JSON body)";
  }
}

/** Whether the session a browser context is holding still authenticates.
 *
 *  GET /api/v1/auth/session is the right question to ask: it mutates
 *  nothing, and apps/common/auth/local deliberately gives it neither a
 *  CSRF check nor a rate limit, so asking it before every test costs the
 *  run nothing it has to budget for. Logging in again does cost something
 *  (ten a minute, per client address), which is exactly why this exists:
 *  it is how the fixture tells "still signed in" from "the last test
 *  pressed Sign out" without paying for a login to find out. */
export async function sessionIsLive(context: BrowserContext): Promise<boolean> {
  const response = await context.request.get("/api/v1/auth/session");
  return response.status() === 200;
}
