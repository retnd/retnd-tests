import { csrfHeaders } from "../harness/session";
import { LiveEvent, OPERATION, liveFeed, setPath, startRecoveryTest } from "./assurance-page";
import { expect, needs, test } from "./fixtures";

/**
 * retnd#1108: a recovery test on a set that declares no validator.
 *
 * # What an operator is owed
 *
 * The refusal is right and stays: with nothing to run, the test says
 * `not_configured` and why. Three things around it are wrong today, and each
 * has its own case below, each named for the issue so the report and its
 * reproduction find each other:
 *
 *   1. The terminal printed `recovery stage: Complete` for a run that tested
 *      nothing. The stage is the engine's.
 *   2. The closing line read `recovery test complete ... state=not_configured`,
 *      which reads as a pass at a glance. The words are the engine's.
 *   3. The Run recovery test button is offered, enabled, on a set that can
 *      only refuse. The page's.
 *
 * Beside them is the control that has to stay green through the fix: reached
 * by the API (the route the page uses, and the one `retnd recovery-test`
 * shares), the refusal still happens, with its reason, and is never a pass.
 *
 * # What it needs
 *
 * A set with no recovery-test validator. The rig's seeded set is "a healthy
 * deployment with nothing declared" (README), so that is the anchor. Every
 * case that depends on it reads the engine's own answer first and declines,
 * naming why, when a validator turns out to be declared, rather than
 * passing against a set that is not the one this issue is about.
 */

interface Run {
  opId: string;
  events: LiveEvent[];
  summary: LiveEvent | undefined;
  end: LiveEvent | undefined;
  stages: string[];
}

/** Starts a recovery test through the route the page uses and waits for its
 *  end line, then returns what the set's live feed holds for that run. */
async function runAndRead(bm: { api: Parameters<typeof startRecoveryTest>[0] }, setId: string): Promise<Run> {
  const opId = await startRecoveryTest(bm.api, setId);
  let events: LiveEvent[] = [];
  await expect
    .poll(
      async () => {
        events = (await liveFeed(bm.api, setId)).events;
        return events.some((e) => e.event === "recovery_test_end" && e.fields.op_id === opId);
      },
      { message: "the run reaches its end line", timeout: 120_000, intervals: [500] }
    )
    .toBe(true);
  const mine = events.filter((e) => e.fields.op_id === opId);
  // The one summary line is keyed by the artifact, not the op id; it is the
  // newest recovery_test event at or after this run's start line.
  const startSeq = mine.find((e) => e.event === "recovery_test_start")?.sequence ?? 0;
  return {
    opId,
    events: mine,
    summary: events.filter((e) => e.event === "recovery_test" && e.sequence >= startSeq).pop(),
    end: mine.find((e) => e.event === "recovery_test_end"),
    stages: mine.filter((e) => e.event === "recovery_stage").map((e) => e.fields.stage)
  };
}

function needsNoValidator(run: Run): void {
  needs(
    run.summary?.fields.state === "not_configured",
    "a set with no recovery-test validator (this run ended " + (run.summary?.fields.state ?? "with no summary line") + ")"
  );
}

test.describe("retnd#1108 a recovery test on a set with no validator", () => {
  test.beforeEach(({ bm }) => {
    needs(bm.facts.configured, "a configured deployment");
    needs(bm.facts.seededBackupSet !== null, "the rig's seeded backup set");
    needs(bm.facts.backups.length > 0, "at least one ingested backup with a local copy");
  });

  test("1108: the stage list of a run that tested nothing has no Complete stage, in the feed or in the terminal", async ({ bm }) => {
    const setId = bm.facts.seededBackupSet ?? "";
    const run = await runAndRead(bm, setId);
    needsNoValidator(run);

    expect(run.stages, "the copy is resolved, and then nothing runs").not.toContain("complete");

    // and what the operator reads: the dock's own lines for this set
    await bm.goto(setPath(setId));
    const terminal = bm.terminal();
    await expect(terminal).toContainText("recovery test did not complete");
    await expect(terminal, "a stage line that says Complete above a line that says it did not").not.toContainText("recovery stage: Complete");
  });

  test("1108: the closing line does not say the test is complete while its state is not_configured", async ({ bm }) => {
    const setId = bm.facts.seededBackupSet ?? "";
    const run = await runAndRead(bm, setId);
    needsNoValidator(run);

    expect(run.summary?.message, "the engine's own words for the closing line").not.toBe("recovery test complete");
    expect(run.summary?.message ?? "").toMatch(/not run/i);

    await bm.goto(setPath(setId));
    const terminal = bm.terminal();
    await expect(terminal).toContainText("state=not_configured");
    await expect(terminal, "a pass-shaped line over a refusal").not.toContainText(/recovery test complete .*state=not_configured/);
  });

  test("1108: Run recovery test is disabled before it is pressed, with the reason beside it and a pointer to docs/recovery.md", async ({ bm }) => {
    const setId = bm.facts.seededBackupSet ?? "";
    // The same condition the first case reads off the engine, without pressing
    // the button: the policy names no validator and the mode is off.
    const [source, set] = setId.split("/");
    const res = await bm.api.get("/api/v1/backup-sets/" + encodeURIComponent(source) + "/" + encodeURIComponent(set) + "/assurance");
    expect(res.status()).toBe(200);
    const policy = (await res.json()) as { recovery_test?: { validator_id?: string; mode?: string } };
    needs(
      (policy.recovery_test?.validator_id ?? "") === "" && (policy.recovery_test?.mode ?? "off") === "off",
      "a set whose policy names no validator and has the recovery test off"
    );

    await bm.goto(setPath(setId));
    const section = bm.page.getByRole("region", { name: "Assurance" });
    const run = section.getByRole("button", { name: "Run recovery test" });
    await expect(run).toBeVisible();
    await expect(run, "a button that can only refuse must not be offered").toBeDisabled();
    await expect(section.getByText(/no recovery-test validator is declared/i)).toBeVisible();
    await expect(section.getByRole("link", { name: /recovery/i }).first()).toHaveAttribute("href", /docs\/recovery/);
    await expect(bm.page.locator(OPERATION), "the run never starts").toHaveCount(0);
  });

  test("1108 control: reached by the API, the refusal still happens, with its reason, and is never a pass", async ({ bm }) => {
    const setId = bm.facts.seededBackupSet ?? "";
    const run = await runAndRead(bm, setId);
    needsNoValidator(run);

    // The route answered 202 (startRecoveryTest asserts it) and the run ended
    // as a refusal: a warning, with the engine's reason, state not_configured.
    expect(run.end?.result).toBe("warn");
    expect(run.end?.fields.reason ?? "").toContain("no recovery-test validator is declared");
    expect(run.summary?.fields.state).toBe("not_configured");
    expect(run.summary?.fields.digest).toBe("not_compared");
    expect(run.events.some((e) => e.event === "recovery_test_end" && e.result === "success"), "a refusal is never a pass").toBe(false);

    // And the claim never reads as a pass for it.
    await bm.goto(setPath(setId));
    await expect(
      bm.page.getByRole("region", { name: "Assurance" }).locator('[data-claim="recovery"][data-state="pass"]')
    ).toHaveCount(0);

    // The same route, asked again with nothing running, is accepted again: a
    // refusal does not wedge the set.
    const again = await bm.api.post(
      "/api/v1/backup-sets/" + setId.split("/").map(encodeURIComponent).join("/") + "/recovery-test",
      { headers: await csrfHeaders(bm.api), data: {} }
    );
    expect(again.status()).toBe(202);
  });
});
