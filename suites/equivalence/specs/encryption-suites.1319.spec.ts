import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { expect, signIn, test } from "../harness/fixtures";
import type { Build } from "../harness/tools";
import type { Locator, Page } from "@playwright/test";

// retnd#1319 (EPIC T, T2.4): the rotate-across-suites flow done twice, once in
// the browser against a served deployment and once with the CLI against its
// bit-identical twin, proved row by row rather than asserted.
//
// The flow is the one an operator takes to move a deployment off its suite:
// enable encryption (a first key under the build's default, age-pq/v1), pin
// the policy to the other suite (age/v1), which answers that a rotation is
// needed and rotates nothing, then rotate into it and hand over the bundle.
//
// Three things have to agree, step by step:
//   - every command the page printed for a step is the CLI argv this spec
//     ran for the same step, so the page cannot echo one thing and do
//     another without this going red;
//   - the CLI's exit status for each step is 0, the browser's outcome for
//     each step is success;
//   - the key registry and the policy each side ends with: read back through
//     `encryption key list --json` and `encryption policy --json` on both
//     work directories, compared on suite and status per key and on the
//     resolved and configured suite, with ids and instants left out because
//     no two deployments share them.
//
// What this does not do: produce an encrypted copy. A configurable medium is
// S3 only and this suite has no endpoint (suites/cli/COVERAGE.md, Known gaps);
// the copy-level rows live in retnd's own core/tests (retnd#1319).

const SAFE = /^retnd [A-Za-z0-9_./: -]+$/;

function cli(build: Build, work: string, argv: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(build.cli, [...argv, "--config", resolve(work, "config.yaml")], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** The registry as (suite, status) pairs, sorted, which is what the two
 *  sides can share; key ids and timestamps are each deployment's own. */
function registry(build: Build, work: string): string[] {
  const r = cli(build, work, ["encryption", "key", "list", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  const keys = (JSON.parse(r.stdout).keys ?? []) as Array<{ suite: string; status: string }>;
  return keys.map((k) => `${k.suite} ${k.status}`).sort();
}

function policy(build: Build, work: string): { mode: string; suite: string; suite_configured: string; rotation_needed: boolean } {
  const r = cli(build, work, ["encryption", "policy", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  const p = JSON.parse(r.stdout);
  return { mode: p.mode, suite: p.suite, suite_configured: p.suite_configured, rotation_needed: !!p.rotation_needed };
}

/** Every `retnd encryption ...` command printed under scope, normalised. */
async function printed(scope: Locator): Promise<string[]> {
  const codes = scope.locator("code", { hasText: /^\s*retnd encryption / });
  return (await codes.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
}

/** The command the page printed for one step must be the step's CLI argv. */
function sameStep(echoed: string[], argv: string[]) {
  const want = "retnd " + argv.join(" ");
  for (const e of echoed) expect(e, `the page printed a command this spec will not compare: ${e}`).toMatch(SAFE);
  expect(echoed, `the page did not print \`${want}\` for this step`).toContain(want);
}

async function card(page: Page, uiUrl: string) {
  await page.goto(uiUrl + "/settings");
  const c = page.locator("[data-encryption-card]");
  await expect(c).toBeVisible();
  return c;
}

test.describe("retnd#1319: rotating across suites in the browser and on the CLI", () => {
  test("each step echoes the CLI's argv, and both deployments end in the same registry and policy", async ({ page, pair }) => {
    const { build } = pair;
    const ui = pair.ui.work;
    const twin = pair.cli.work;

    // The control: two untouched twins agree, and agree on nothing encrypted.
    expect(registry(build, ui)).toEqual(registry(build, twin));
    expect(registry(build, twin)).toEqual([]);

    await signIn(page, pair.ui);
    const c = await card(page, pair.ui.uiUrl);

    // Step 1: enable, which mints the first key under the default.
    await c.getByRole("switch", { name: "Encrypt copies sent to destinations" }).click();
    const enable = page.getByRole("dialog", { name: "Enable retained-copy encryption" });
    sameStep(await printed(enable), ["encryption", "policy", "patch", "--mode", "required", "--managed"]);
    await enable.getByRole("button", { name: "Enable and create key" }).click();
    await expect(enable).toBeHidden();
    expect(cli(build, twin, ["encryption", "key", "create"]).code).toBe(0);
    expect(cli(build, twin, ["encryption", "policy", "patch", "--mode", "required", "--managed"]).code).toBe(0);
    expect(registry(build, ui)).toEqual(["age-pq/v1 active"]);
    expect(registry(build, twin)).toEqual(["age-pq/v1 active"]);

    // Step 2: pin the other suite. Both sides are told to rotate, neither
    // rotates.
    await c.getByRole("radio", { name: /^age\/v1/ }).check();
    const change = page.getByRole("dialog", { name: "Change the suite" });
    sameStep(await printed(change), ["encryption", "policy", "patch", "--suite", "age/v1"]);
    await change.getByRole("button", { name: "Change suite" }).click();
    await expect(change.locator('[data-suite-step="rotate"]')).toHaveAttribute("data-state", "now");
    const patched = cli(build, twin, ["encryption", "policy", "patch", "--suite", "age/v1"]);
    expect(patched.code, patched.stderr).toBe(0);
    expect(policy(build, ui)).toEqual(policy(build, twin));
    expect(policy(build, twin)).toEqual({ mode: "required", suite: "age/v1", suite_configured: "age/v1", rotation_needed: true });
    expect(registry(build, ui)).toEqual(registry(build, twin));

    // Step 3: rotate into it, then the bundle.
    sameStep(await printed(change), ["encryption", "key", "rotate", "--suite", "age/v1"]);
    await change.getByRole("button", { name: "Rotate key" }).click();
    await change.getByRole("checkbox", { name: /I understand this file can decrypt every copy/ }).check();
    const download = page.waitForEvent("download");
    await change.getByRole("button", { name: "Download bundle" }).click();
    await download;
    await change.getByRole("button", { name: "I have stored the bundle safely" }).click();
    await expect(change).toBeHidden();
    expect(cli(build, twin, ["encryption", "key", "rotate", "--suite", "age/v1"]).code).toBe(0);

    // Where both end: one active key under age/v1, the first one superseded
    // and still there (it guards whatever it wrote), and the policy satisfied.
    expect(registry(build, ui)).toEqual(registry(build, twin));
    expect(registry(build, twin)).toEqual(["age-pq/v1 superseded", "age/v1 active"]);
    expect(policy(build, ui)).toEqual(policy(build, twin));
    expect(policy(build, twin).rotation_needed).toBe(false);
  });
});
