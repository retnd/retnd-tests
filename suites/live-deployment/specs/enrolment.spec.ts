import { enrolAdministrator, expect, openEnrolmentPage, test } from "../harness/fixtures";

// The first thing an operator does on a new install, and the first thing
// this suite has to be able to do: open the Web UI of a deployment that has
// just come up, and create the administrator account.
//
// It is one test rather than several because enrolment is single-shot and
// irreversible by design (§49.1), so the interesting states are three
// moments in ONE deployment's life rather than three deployments: before
// anyone has enrolled, the moment of enrolling, and after. Splitting them
// would mean booting three deployments to assert three halves of one
// sequence, and the third could not be reached without performing the
// second anyway.
//
// It is also this suite's own proof that it works. Every later spec here
// starts from a deployment plus an enrolled administrator, and if the
// harness cannot produce those, nothing downstream of it means anything.
/** Submitted by the two attempts that are supposed to be refused. Long
 *  enough to satisfy the form's own twelve-character rule, so the button is
 *  live and the refusal comes from the engine rather than from the browser,
 *  and obviously not a credential of anything. */
const WRONG_ON_PURPOSE = "wrong-on-purpose-0000";

test("an operator enrols the administrator through the browser on a fresh deployment", async ({
  page,
  deployment
}) => {
  // ---------------------------------------------------------- the given
  //
  // A deployment that has just come up, with nothing configured and nobody
  // enrolled. Asserted rather than assumed: "fresh install" is the premise
  // of everything below, and a volume this run created cannot have an
  // administrator on it unless something is badly wrong with the harness.
  expect(
    await deployment.manager.stateFile("local-auth.json"),
    "a deployment this run just created already has an administrator record, so it is not the fresh install this test is about"
  ).toBeNull();

  // The source machine is up and serving the content later specs back up.
  // It is asserted here because this is the spec that proves the harness:
  // a run that enrolled an administrator against a manager with no machine
  // behind it has proved half of what it set out to.
  expect(deployment.source.files.map((f) => f.name)).toEqual(["payload.bin", "schema.sql", "notes.txt"]);
  for (const file of deployment.source.files) {
    expect(file.sha256, `${file.name} has no digest, so the source machine is not serving what it should`).toMatch(
      /^[0-9a-f]{64}$/
    );
  }
  // Its host key exists and is the machine's own, generated on first start.
  // The wizard's verify step is what an operator meets this through.
  expect((await deployment.source.hostKey()).line).toMatch(/^ssh-ed25519 \S+/);

  // ------------------------------------------------- the negative control
  //
  // The enrolment page WITHOUT a token refuses, and says the token is what
  // is missing. Without this the test below would pass just as well against
  // an engine that had stopped checking the token at all, which is the
  // failure this whole flow exists to prevent: enrolment is the one moment
  // where reaching the port is not the same thing as being allowed to claim
  // the instance.
  await page.goto(`${deployment.uiUrl}/enroll`);
  await page.getByLabel("Username").fill(deployment.admin.username);
  await page.getByLabel(/^Password/).fill(WRONG_ON_PURPOSE);
  await page.getByLabel(/^Confirm password/).fill(WRONG_ON_PURPOSE);
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(page.getByText("This page was opened without an enrolment token.")).toBeVisible();
  expect(
    await deployment.manager.stateFile("local-auth.json"),
    "a tokenless enrolment attempt created an administrator record"
  ).toBeNull();

  // ------------------------------------------------------- the enrolment
  //
  // The real thing: the one-time token out of the engine's own log, into
  // the link, and an account created through the form. Everything about how
  // the token is handled is in harness/fixtures.ts and harness/secrets.ts;
  // what matters here is that the browser is what does it.
  await enrolAdministrator(page, deployment);

  // Signed in, on the dashboard, with the first-run banner an install with
  // no configuration is supposed to show. This is the UI's own answer.
  await expect(page.getByText("Backup Manager has no configuration yet")).toBeVisible();

  // ------------------------------------------------ and on the other side
  //
  // What the UI says and what the deployment did are two claims, and this
  // suite exists because only the second one is evidence. The administrator
  // record is on the manager's state volume, read by a container this run
  // started rather than by the engine that wrote it.
  const record = await deployment.manager.stateFile("local-auth.json");
  expect(record, "the UI reported an enrolled administrator and the state volume has no record of one").not.toBeNull();
  expect(record).toContain(deployment.admin.username);
  // The password is not in it, in any form this test can look for. The
  // record holds an Argon2id hash, so this is a cheap assertion and it is
  // the one that would catch the expensive mistake.
  expect(
    record?.includes(deployment.admin.password),
    "the administrator record contains the password as submitted"
  ).toBe(false);

  // The token is not in the page's address any more either. The app
  // replaces the enrolment URL with the dashboard's on its way in, so the
  // one-time secret does not sit in the address bar of a browser somebody
  // walks away from.
  expect(new URL(page.url()).search).not.toContain("token=");

  // ------------------------------------------------------------- and once
  //
  // Enrolment is single-shot. Opening the link again, token and all, is
  // refused with the one message that has somewhere to send the operator.
  // This is the other half of the control above: the first refusal proves
  // the token is checked, and this one proves an account that exists cannot
  // be replaced by anyone who still has the link.
  //
  // From a browser with no session, which is both the shape that matters
  // and the only one that reaches the page at all. It matters because the
  // link is the thing that gets forwarded, pasted into a chat or left in a
  // terminal, so the question is what a stranger holding it can do. And it
  // is the only route because App.tsx routes /enroll away once the session
  // is authenticated: with the cookie still there the form never renders,
  // and this block would be waiting on a control that is not coming.
  await page.context().clearCookies();
  await openEnrolmentPage(page, deployment);
  await page.getByLabel("Username").fill("second-administrator");
  await page.getByLabel(/^Password/).fill(WRONG_ON_PURPOSE);
  await page.getByLabel(/^Confirm password/).fill(WRONG_ON_PURPOSE);
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(page.getByText("An administrator account already exists on this instance.")).toBeVisible();
  expect(
    (await deployment.manager.stateFile("local-auth.json"))?.includes(deployment.admin.username),
    "a second enrolment attempt changed the administrator record"
  ).toBe(true);
});
