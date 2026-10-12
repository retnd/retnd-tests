import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { expect, signIn, test } from "../harness/fixtures";
import { runCli } from "../harness/tools";

// retnd#986 (EPIC Q, FR-74): the recovery and assurance surfaces, driven once
// through the browser and once through the CLI, and compared by what each
// leaves behind rather than by what each prints.
//
// The fixture is `seeded-local`: a local copy whose bytes come from a PRNG
// seeded by the scenario, so the digest below is the same on every machine
// and every run. It is pinned here, in the spec, rather than recomputed from
// whatever the product delivered: a recovery that handed over the right
// number of the wrong bytes would otherwise agree with itself.
//
// Every row has a refusal as well as a success, because a pair of surfaces
// that agree only when things go well have not been shown to agree.
const SET = "production/postgres-primary";
const ART = `${SET}/pg-2026-06-01.dump`;
const DIGEST = "55611b10e46648a984c74726d94237a8d37d9ec1c366240fa82c50cd676cdd8c";
const SIZE = 4096;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Finds the one file under `dir` whose name ends with `-<name>`: how a
 *  staged recovery is named, a unique prefix and then the operator's name. */
function stagedFile(dir: string, name: string): string {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith("-" + name)) hits.push(p);
    }
  };
  walk(dir);
  expect(hits, `expected exactly one staged file named *-${name} under ${dir}`).toHaveLength(1);
  return hits[0];
}

const localCopy = (work: string) => resolve(work, "local", ART);

/** Changes one byte in the middle of the local copy, keeping its size, which is
 *  the corruption a size check would pass. */
function corrupt(path: string) {
  const b = readFileSync(path);
  b[100] = b[100] ^ 0xff;
  writeFileSync(path, b);
}

const cliOut = (build: { cli: string }, work: string, argv: string[]) => {
  const r = spawnSync(build.cli, [...argv, "--config", resolve(work, "config.yaml")], { encoding: "buffer", maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr.toString("utf8") };
};

const assuranceJson = (build: { cli: string }, work: string, argv: string[]) => {
  const r = runCli(build as never, work, argv);
  expect(r.code, r.stderr).toBe(0);
  // The two sides differ in the work directory that appears in the staging
  // root, which is a fact about where each was materialised and not a policy.
  return JSON.parse(r.stdout.replaceAll(work, "<work>"));
};

test.describe("deployment-wide assurance: the Settings card and `settings assurance patch`", () => {
  test("saving a scrub cadence in the browser leaves the same policy as patching it from the CLI", async ({ page, pair }) => {
    const before = assuranceJson(pair.build, pair.ui.work, ["settings", "assurance", "--json"]);
    expect(before.configured, "the fixture should start with assurance unconfigured").toBe(false);
    expect(assuranceJson(pair.build, pair.cli.work, ["settings", "assurance", "--json"])).toEqual(before);

    // ---- the browser
    await signIn(page, pair.ui);
    await page.goto(pair.ui.uiUrl + "/settings");
    const card = page.getByRole("region", { name: "Assurance" });
    await card.getByLabel("Scrub every").fill("3d");
    await card.getByRole("button", { name: "Save" }).click();
    await expect(card.getByText("Saved")).toBeVisible();

    // ---- the CLI: three days, spelled the way the CLI takes a duration
    const patched = runCli(pair.build, pair.cli.work, ["settings", "assurance", "patch", "--scrub-cadence", "72h"]);
    expect(patched.code, patched.stderr).toBe(0);

    // both really changed before anything is compared
    const ui = assuranceJson(pair.build, pair.ui.work, ["settings", "assurance", "--json"]);
    const cli = assuranceJson(pair.build, pair.cli.work, ["settings", "assurance", "--json"]);
    expect(ui, "the browser save did not reach the engine").not.toEqual(before);
    expect(cli, "the CLI patch did not change the policy").not.toEqual(before);
    expect(ui, "the two surfaces left different policies").toEqual(cli);

    // and the change reaches a set that inherits it, on both
    const set = (work: string) => runCli(pair.build, work, ["backup-set", "assurance", SET]).stdout;
    expect(set(pair.ui.work)).toContain("every 72h0m0s");
    expect(set(pair.cli.work)).toBe(set(pair.ui.work));
  });

  test("a cadence below the one-hour floor is refused on both, and nothing is written", async ({ page, pair }) => {
    await signIn(page, pair.ui);
    await page.goto(pair.ui.uiUrl + "/settings");
    const card = page.getByRole("region", { name: "Assurance" });
    await card.getByLabel("Scrub every").fill("30m");
    // The browser refuses before it asks: it says why, and Save stays disabled,
    // so no request is made at all.
    await expect(card.getByRole("alert")).toContainText("The shortest cadence is 1h.");
    await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();

    const r = runCli(pair.build, pair.cli.work, ["settings", "assurance", "patch", "--scrub-cadence", "30m"]);
    expect(r.code, "the CLI refuses with the ordinary failure status").toBe(1);
    expect(r.stderr).toContain("is below the floor of 1h0m0s");

    // neither side wrote anything: both policies are still the unconfigured default
    for (const work of [pair.ui.work, pair.cli.work]) {
      expect(assuranceJson(pair.build, work, ["settings", "assurance", "--json"]).configured).toBe(false);
    }
  });
});

test.describe("per-set assurance: the Assurance section and `backup-set assurance`", () => {
  test("choosing the set's own policy with a cadence in the browser equals `backup-set assurance --scrub-cadence`", async ({ page, pair }) => {
    await signIn(page, pair.ui);
    await page.goto(pair.ui.uiUrl + `/sets/${SET}`);
    const section = page.getByRole("region", { name: "Assurance" });
    await section.getByRole("radio", { name: "This set's own policy" }).check();
    await section.getByLabel("Scrub every").fill("12h");
    await section.getByRole("button", { name: "Save policy" }).click();

    const r = runCli(pair.build, pair.cli.work, ["backup-set", "assurance", SET, "--scrub-cadence", "12h"]);
    expect(r.code, r.stderr).toBe(0);

    const read = (work: string) => runCli(pair.build, work, ["backup-set", "assurance", SET, "--json"]);
    const a = read(pair.ui.work);
    const b = read(pair.cli.work);
    expect(a.code, a.stderr).toBe(0);
    expect(JSON.parse(a.stdout), "the browser's per-set policy differs from the CLI's").toEqual(JSON.parse(b.stdout));
    expect(JSON.parse(a.stdout).is_override, "the set should now carry its own policy").toBe(true);

    // a sibling set, which was not touched, still inherits on both sides
    const sibling = (work: string) => runCli(pair.build, work, ["backup-set", "assurance", "production/app-uploads"]).stdout;
    expect(sibling(pair.ui.work)).toContain("inherits the deployment's policy");
    expect(sibling(pair.cli.work)).toBe(sibling(pair.ui.work));
  });
});

test.describe("recovery: Recover artifact and `retnd recover`", () => {
  test("a download in the browser and `--to -` deliver the same bytes, and they are the recorded ones", async ({ page, pair }) => {
    await signIn(page, pair.ui);
    await page.goto(pair.ui.uiUrl + `/backups/${ART}`);
    await page.getByRole("button", { name: "Recover artifact", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Recover artifact" });
    await dialog.getByRole("radio", { name: "Download in this browser" }).check();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dialog.getByRole("button", { name: "Recover artifact", exact: true }).click()
    ]);
    const path = await download.path();
    const fromBrowser = readFileSync(path);
    // The page says the file was handed to the browser and never claims more:
    // the host verified the copy before sending a byte, and the page cannot
    // see the transfer finish.
    await expect(dialog).toContainText("handed to your browser");

    const cli = cliOut(pair.build, pair.cli.work, ["recover", ART, "--to", "-"]);
    expect(cli.code, cli.stderr).toBe(0);

    expect(fromBrowser.length).toBe(SIZE);
    expect(sha256(fromBrowser), "the browser did not receive the recorded bytes").toBe(DIGEST);
    expect(sha256(cli.stdout), "the CLI did not deliver the recorded bytes").toBe(DIGEST);
    expect(fromBrowser.equals(cli.stdout), "the two surfaces delivered different bytes").toBe(true);
  });

  test("a recovery to a staging name places the same verified bytes from either surface", async ({ page, pair }) => {
    await signIn(page, pair.ui);
    await page.goto(pair.ui.uiUrl + `/backups/${ART}`);
    await page.getByRole("button", { name: "Recover artifact", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Recover artifact" });
    await dialog.getByRole("radio", { name: "Staging path on the host" }).check();
    await dialog.getByRole("textbox", { name: /Recover to/ }).fill("equiv-copy");
    await dialog.getByRole("button", { name: "Recover artifact", exact: true }).click();
    await expect(dialog).toContainText("Recovered", { timeout: 30_000 });

    const cli = runCli(pair.build, pair.cli.work, ["recover", ART, "--to", "equiv-copy", "--json"]);
    expect(cli.code, cli.stderr).toBe(0);
    const reported = JSON.parse(cli.stdout.split("\n").filter((l) => l.startsWith("{") && l.includes('"sha256"')).pop()!);
    expect(reported.sha256, "the CLI reported a digest other than the recorded one").toBe(DIGEST);

    const ui = readFileSync(stagedFile(pair.ui.work, "equiv-copy"));
    const placed = readFileSync(stagedFile(pair.cli.work, "equiv-copy"));
    expect(sha256(ui), "the browser's staged copy is not the recorded bytes").toBe(DIGEST);
    expect(sha256(placed), "the CLI's staged copy is not the recorded bytes").toBe(DIGEST);

    // A recovery changes nothing the journal reports. What each side's
    // product says about the artifact afterwards is identical, and says the
    // artifact is still committed, which is what would notice a recovery that
    // quietly moved an artifact's state.
    const listing = (work: string) =>
      runCli(pair.build, work, ["artifacts"]).stdout.replaceAll(work, "<work>");
    expect(listing(pair.ui.work)).toContain("COMMITTED");
    expect(listing(pair.cli.work)).toBe(listing(pair.ui.work));

    // The engine this recovery just completed on is the one that refuses
    // every operation behind the destructive gate, and it still does. Q's
    // recovery route is deliberately outside that gate (Q1.1), so a recovery
    // that finished here finished on a gate-shut deployment, which is the
    // only kind this repository can build. A rig that had opened the gate
    // would be proving something no operator can do, so this asks the same
    // engine, in the same signed-in browser session, and expects the refusal.
    const refused = await page.evaluate(async () => {
      const csrf = document.cookie.split("; ").find((c) => c.startsWith("retnd_csrf="))?.split("=")[1] ?? "";
      const r = await fetch("/api/v1/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ kind: "run_cycle" })
      });
      return { status: r.status, body: await r.text() };
    });
    expect(refused.status, "the gate must still be shut: " + refused.body).toBe(403);
    expect(refused.body).toContain("DESTRUCTIVE_OPERATIONS_DISABLED");
  });

  test("a corrupted local copy is refused on both routes with the same sentence and the code the usage text names", async ({ page, pair }) => {
    corrupt(localCopy(pair.ui.work));
    corrupt(localCopy(pair.cli.work));

    await signIn(page, pair.ui);
    await page.goto(pair.ui.uiUrl + `/backups/${ART}`);
    await page.getByRole("button", { name: "Recover artifact", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Recover artifact" });
    await dialog.getByRole("radio", { name: "Staging path on the host" }).check();
    await dialog.getByRole("textbox", { name: /Recover to/ }).fill("refused-copy");

    // The refusal is a response of the engine's own, and its code is what the
    // CLI maps to an exit status; capture it rather than trusting the page.
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/v1/") && r.url().includes("recover") && r.status() >= 400),
      dialog.getByRole("button", { name: "Recover artifact", exact: true }).click()
    ]);
    const body = await response.json();
    expect(body.code ?? body.error?.code, "the engine's refusal code").toBe("RECOVERY_LOCAL_COPY_CORRUPT");
    await expect(dialog.getByRole("alert")).toContainText("does not match the checksum recorded when this backup was ingested");

    const cli = cliOut(pair.build, pair.cli.work, ["recover", ART, "--to", "refused-copy"]);
    expect(cli.code, "the CLI exit status for a corrupt local copy").toBe(14);
    expect(cli.stderr).toContain("does not match the checksum recorded when this backup was ingested");

    // the usage text is where an operator learns what 14 means
    const usage = runCli(pair.build, pair.cli.work, [], { config: false });
    expect(usage.stderr + usage.stdout).toContain("14 the copy on this host's disk failed its checksum");

    // and in neither case did a byte reach the staging root
    for (const work of [pair.ui.work, pair.cli.work]) {
      expect(() => stagedFile(work, "refused-copy"), "a refused recovery left a staged file").toThrow();
    }
  });
});
