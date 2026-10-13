import { NEEDS_BUILTIN_CHECK_SET, resolveAssuranceFixtures } from "../harness/assurance";
import { LiveEvent, OPERATION, liveFeed, recoveryTestPolicy, setPath, startRecoveryTest, withBuiltinCheckOff } from "./assurance-page";
import { expect, needs, test } from "./fixtures";

/**
 * retnd#1111: a recovery test on a set with no validator and a readable
 * newest copy runs the product's built-in structure check.
 *
 * recovery-test-no-validator.1108.spec.ts holds the other half: the refusal
 * that still applies when the check is off or the type has no reader. The
 * two are meant to be read together, and this file is named for the product
 * issue so the report and its reproduction find each other (the tests
 * repository's own issue is #91).
 *
 * # What an operator is owed
 *
 *   1. The Run recovery test button is offered, enabled, with no refusal
 *      text beside it.
 *   2. Pressing it ends on the chip "Recovered, readable" (data-state
 *      `pass_builtin`), never "Recovery test passed": the check proves the
 *      file decodes end to end, not that anything restores into an
 *      application.
 *   3. The follow feed ends "recovered and readable: <artifact> (built-in
 *      check)", and its start line names the built-in structure check.
 *   4. On the wire the copy says `recovery_state: readable` and
 *      `recovery_check: builtin`, and `passed` stays reserved for a
 *      validator's acceptance.
 *   5. With the set's built-in check off, the same set is refused again, so
 *      the switch does what its name says.
 *
 * # What it needs
 *
 * A set with no validator whose newest copy is a type the check can read.
 * The rig's seeded set is three files nothing can read (payload.bin,
 * schema.sql, notes.txt), so the rig names a second set in
 * RETND_BUILTIN_CHECK_SET and these cases decline, naming that, without it.
 */

const NO_VALIDATOR = /no (recovery-test )?validator is declared/i;
const BUILTIN_VALIDATOR_ID = "retnd-builtin-structure";

interface Run {
  opId: string;
  events: LiveEvent[];
  start: LiveEvent | undefined;
  end: LiveEvent | undefined;
}

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
  return {
    opId,
    events: mine,
    start: mine.find((e) => e.event === "recovery_test_start"),
    end: mine.find((e) => e.event === "recovery_test_end")
  };
}

/** The recovery state and check the newest copy of a set carries on the wire. */
async function newestCopyRecord(bm: { api: Parameters<typeof startRecoveryTest>[0] }, setId: string) {
  const res = await bm.api.get("/api/v1/backups?setId=" + encodeURIComponent(setId));
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    artifacts?: { id: string; produced_at?: string; placements?: { status: string; recovery_state?: string; recovery_check?: string }[] }[];
  };
  const newest = [...(body.artifacts ?? [])].sort((a, b) => (b.produced_at ?? "").localeCompare(a.produced_at ?? ""))[0];
  const placement = (newest?.placements ?? []).find((p) => p.status === "ACTIVE");
  return { artifact: newest?.id ?? "", state: placement?.recovery_state, check: placement?.recovery_check };
}

test.describe("retnd#1111 a recovery test on a set with no validator and a readable copy", () => {
  // The cases share one set, and one of them changes a setting on it.
  test.describe.configure({ mode: "serial" });

  let setId = "";

  test.beforeEach(async ({ bm }) => {
    needs(bm.facts.configured, "a configured deployment");
    const named = resolveAssuranceFixtures().builtinCheckSet;
    needs(named !== null, NEEDS_BUILTIN_CHECK_SET);
    setId = named ?? "";
    // The rig's engine pulls this set on its own timer, so its first copy may
    // still be on its way when the first case starts.
    await expect
      .poll(async () => (await newestCopyRecord(bm, setId)).artifact, {
        message: "the set's first copy is ingested",
        timeout: 240_000,
        intervals: [2_000]
      })
      .not.toBe("");
    const policy = await recoveryTestPolicy(bm.api, setId);
    expect(policy.validator_id ?? "", "the set declares no validator (the rig's set is meant to have none)").toBe("");
    expect(policy.effective_check, "no validator and a readable newest copy: the built-in check is what would run: " + (policy.effective_check_reason ?? "")).toBe("builtin");
  });

  test("1111: Run recovery test is enabled, with no refusal beside it", async ({ bm }) => {
    await bm.goto(setPath(setId));
    const section = bm.page.getByRole("region", { name: "Assurance" });
    const run = section.getByRole("button", { name: "Run recovery test" });
    await expect(run).toBeVisible();
    await expect(run, "a check that can run is offered").toBeEnabled();
    // The refusal paragraph, by the id the page gives it: the words alone
    // also appear in the built-in check's own explanation beside the button.
    await expect(section.getByTestId("recovery-test-no-validator")).toHaveCount(0);
    await expect(bm.page.locator(OPERATION), "nothing starts until it is pressed").toHaveCount(0);
  });

  test("1111: pressing it ends on the chip Recovered, readable, and never on Recovery test passed", async ({ bm }) => {
    await bm.goto(setPath(setId));
    const section = bm.page.getByRole("region", { name: "Assurance" });
    const recovery = section.locator('[data-claim="recovery"]');
    await section.getByRole("button", { name: "Run recovery test" }).click();

    await expect(recovery).toHaveAttribute("data-state", "pass_builtin", { timeout: 120_000 });
    await expect(recovery).toContainText("Recovered, readable");
    await expect(recovery, "a structure check is not a validator's pass").not.toContainText("Recovery test passed");
  });

  test("1111: the feed starts on the built-in check and ends recovered and readable", async ({ bm }) => {
    await bm.goto(setPath(setId));
    const section = bm.page.getByRole("region", { name: "Assurance" });
    await section.getByRole("button", { name: "Run recovery test" }).click();

    const terminal = bm.terminal();
    await expect(terminal).toContainText("(built-in structure check)", { timeout: 120_000 });
    await expect(terminal).toContainText(/recovered and readable: \S+ \(built-in check\)/, { timeout: 120_000 });
    await expect(terminal, "the built-in check never reads as a validator's pass").not.toContainText("recovery test passed");
    await expect(terminal).not.toContainText("recovery test did not complete");
  });

  test("1111: on the wire the copy reads readable by the built-in check, and the end line carries its identity", async ({ bm }) => {
    const run = await runAndRead(bm, setId);

    expect(run.end?.result).toBe("success");
    expect(run.end?.fields.validator, "the engine's reserved identity for the built-in check").toBe(BUILTIN_VALIDATOR_ID);
    expect(run.start?.fields.validator).toBe(BUILTIN_VALIDATOR_ID);

    const copy = await newestCopyRecord(bm, setId);
    expect(copy.state, "passed means a validator accepted it; this was not that").toBe("readable");
    expect(copy.check).toBe("builtin");
  });

  test("1111: with the set's built-in check off the same set is refused, and switching it back runs again", async ({ bm }) => {
    await withBuiltinCheckOff(bm.api, setId, async () => {
      await bm.goto(setPath(setId));
      const section = bm.page.getByRole("region", { name: "Assurance" });
      await expect(section.getByRole("button", { name: "Run recovery test" })).toBeDisabled();
      await expect(section.getByTestId("recovery-test-no-validator")).toContainText(NO_VALIDATOR);

      const run = await runAndRead(bm, setId);
      expect(run.end?.result).toBe("warn");
      expect(run.end?.fields.reason ?? "").toMatch(NO_VALIDATOR);
    });

    // Put back by withBuiltinCheckOff; the button is offered again.
    await bm.goto(setPath(setId));
    await expect(bm.page.getByRole("region", { name: "Assurance" }).getByRole("button", { name: "Run recovery test" })).toBeEnabled();
  });
});
