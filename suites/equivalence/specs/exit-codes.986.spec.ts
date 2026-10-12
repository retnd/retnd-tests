import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, signIn, test } from "../harness/fixtures";
import type { Build } from "../harness/tools";
import type { Locator } from "@playwright/test";

// retnd#986: one success and one refusal per surface, compared by two REAL
// exit codes.
//
// assurance-recovery.986.spec.ts compares a refusal by the engine's code
// (`RECOVERY_LOCAL_COPY_CORRUPT`, a string in a JSON body) against the CLI's
// exit status (14), which is a mapping somebody wrote, so the two halves of
// that comparison are not the same kind of thing. Here both sides are
// processes that ended with a status.
//
// The browser has no exit status, but it does print the command it is
// equivalent to ("Same thing from the terminal", CommandEcho). That string is
// a claim, so it is taken off the page, run for real against the deployment
// the browser acted on, and its exit status is compared with the status of
// the same operation run independently against the CLI's own deployment.
// Three things then have to agree: the browser's outcome, the status of the
// command the browser printed, and the status of the CLI. If the page printed
// a command that does something other than what the button does, the first
// two part ways; if the CLI and the page disagree about a refusal, the last
// two do.
//
// Only commands made of characters an id, a flag and a redirect to a file can
// contain are executed. A page that echoed anything else would be a reason to
// stop, not to run it.
const SET = "production/postgres-primary";
const ART = `${SET}/pg-2026-06-01.dump`;
const SAFE = /^retnd [A-Za-z0-9_./: -]+( > [A-Za-z0-9_.-]+)?$/;

/** Runs a command the page printed, as the build under test, in `work`. */
function runEchoed(build: Build, work: string, echoed: string): { code: number; stderr: string } {
  const command = echoed.replace(/\s+/g, " ").trim();
  expect(command, `the page printed a command this case will not run: ${command}`).toMatch(SAFE);
  const [argvPart, redirect] = command.slice("retnd ".length).split(" > ");
  const dir = resolve(work, "echoed");
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(build.cli, [...argvPart.split(" "), "--config", resolve(work, "config.yaml")], {
    encoding: "buffer",
    cwd: dir,
    maxBuffer: 64 << 20
  });
  if (r.error) throw r.error;
  if (redirect) writeFileSync(resolve(dir, redirect), r.stdout);
  return { code: r.status ?? -1, stderr: r.stderr.toString("utf8") };
}

const cli = (build: Build, work: string, argv: string[]) => {
  const r = spawnSync(build.cli, [...argv, "--config", resolve(work, "config.yaml")], { encoding: "buffer", maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stderr: r.stderr.toString("utf8") };
};

/** The text of the first printed command under `scope` that starts with `verb`. */
async function printed(scope: Locator, verb: string): Promise<string> {
  const code = scope.locator("code", { hasText: new RegExp("^\\s*retnd " + verb) }).first();
  await expect(code, `the page prints a 'retnd ${verb}' command`).toBeVisible();
  return (await code.innerText()).trim();
}

function corrupt(path: string) {
  const b = readFileSync(path);
  b[100] = b[100] ^ 0xff;
  writeFileSync(path, b);
}
const localCopy = (work: string) => resolve(work, "local", ART);

async function openRecover(page: import("@playwright/test").Page, stack: { uiUrl: string }) {
  await page.goto(stack.uiUrl + `/backups/${ART}`);
  await page.getByRole("button", { name: "Recover artifact", exact: true }).click();
  return page.getByRole("dialog", { name: "Recover artifact" });
}

test.describe("recover: the printed command and the CLI exit with the same real status", () => {
  test("success: a staging recovery in the browser, its printed command, and the CLI all exit 0", async ({ page, pair }) => {
    await signIn(page, pair.ui);
    const dialog = await openRecover(page, pair.ui);
    await dialog.getByRole("radio", { name: "Staging path on the host" }).check();
    await dialog.getByRole("textbox", { name: /Recover to/ }).fill("exit-ok");
    const command = await printed(dialog, "recover");
    await dialog.getByRole("button", { name: "Recover artifact", exact: true }).click();
    await expect(dialog).toContainText("Recovered", { timeout: 30_000 });

    const echoed = runEchoed(pair.build, pair.ui.work, command);
    const direct = cli(pair.build, pair.cli.work, ["recover", ART, "--to", "exit-ok"]);
    expect(echoed.code, echoed.stderr).toBe(0);
    expect(direct.code, direct.stderr).toBe(0);
    expect(echoed.code, "the printed command and the CLI disagree").toBe(direct.code);
  });

  test("success: a download in the browser, its printed command, and the CLI all exit 0", async ({ page, pair }) => {
    await signIn(page, pair.ui);
    const dialog = await openRecover(page, pair.ui);
    await dialog.getByRole("radio", { name: "Download in this browser" }).check();
    const command = await printed(dialog, "recover");
    expect(command, "a download is printed as a redirect to a file").toContain(" --to - > ");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dialog.getByRole("button", { name: "Recover artifact", exact: true }).click()
    ]);
    expect((await download.path()) ?? "").not.toBe("");

    const echoed = runEchoed(pair.build, pair.ui.work, command);
    const direct = cli(pair.build, pair.cli.work, ["recover", ART, "--to", "-"]);
    expect(echoed.code, echoed.stderr).toBe(0);
    expect(echoed.code).toBe(direct.code);
  });

  test("refusal: a corrupted copy is refused by the browser, and the printed command and the CLI exit with the same non-zero status", async ({ page, pair }) => {
    corrupt(localCopy(pair.ui.work));
    corrupt(localCopy(pair.cli.work));

    await signIn(page, pair.ui);
    const dialog = await openRecover(page, pair.ui);
    await dialog.getByRole("radio", { name: "Staging path on the host" }).check();
    await dialog.getByRole("textbox", { name: /Recover to/ }).fill("exit-refused");
    const command = await printed(dialog, "recover");
    await dialog.getByRole("button", { name: "Recover artifact", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("does not match the checksum recorded when this backup was ingested");

    const echoed = runEchoed(pair.build, pair.ui.work, command);
    const direct = cli(pair.build, pair.cli.work, ["recover", ART, "--to", "exit-refused"]);
    expect(echoed.code, "a refused recovery must not exit 0").not.toBe(0);
    expect(echoed.code, "the printed command and the CLI disagree about the refusal").toBe(direct.code);
    expect(echoed.stderr, "and they say the same thing").toContain("does not match the checksum recorded");
    expect(direct.stderr).toContain("does not match the checksum recorded");
  });
});

test.describe("scrub: the printed command and the CLI exit with the same real status", () => {
  test("success: a clean copy scrubs with exit 0 by the printed command and by the CLI", async ({ page, pair }) => {
    await signIn(page, pair.ui);
    await page.goto(pair.ui.uiUrl + `/sets/${SET}`);
    const command = await printed(page.getByRole("region", { name: "Assurance" }), "scrub");

    const echoed = runEchoed(pair.build, pair.ui.work, command);
    const direct = cli(pair.build, pair.cli.work, ["scrub", SET]);
    expect(echoed.code, echoed.stderr).toBe(0);
    expect(echoed.code).toBe(direct.code);
  });

  test("refusal: a corrupted copy fails its scrub with the same non-zero status by the printed command and by the CLI", async ({ page, pair }) => {
    corrupt(localCopy(pair.ui.work));
    corrupt(localCopy(pair.cli.work));

    await signIn(page, pair.ui);
    await page.goto(pair.ui.uiUrl + `/sets/${SET}`);
    const command = await printed(page.getByRole("region", { name: "Assurance" }), "scrub");

    const echoed = runEchoed(pair.build, pair.ui.work, command);
    const direct = cli(pair.build, pair.cli.work, ["scrub", SET]);
    expect(echoed.code, "a failed scrub must not exit 0").not.toBe(0);
    expect(echoed.code, "the printed command and the CLI disagree about a failing scrub").toBe(direct.code);
  });
});
