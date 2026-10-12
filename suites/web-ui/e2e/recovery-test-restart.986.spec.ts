import { NEEDS_BREAKABLE_ENGINE, canBreakEngine, resolveEngineControl, startEngine, stopEngine } from "../harness/engine";
import { NEEDS_SLOW_RECOVERY_SET, resolveAssuranceFixtures } from "../harness/assurance";
import { OPERATION, liveFeed, setPath, startRecoveryTest } from "./assurance-page";
import { expect, needs, test } from "./fixtures";

/**
 * retnd#986: the engine restarts in the middle of a recovery test.
 *
 * # What an operator is owed
 *
 * Three things, none of which depends on how the product chooses to record an
 * interrupted test:
 *
 *   1. It is not a pass. The test that was cut off never reached its end, so
 *      no copy of the set carries a recovery state of `passed` that it did
 *      not carry before.
 *   2. The page does not go on saying it is running. A restart takes the
 *      goroutine with it; a feed that rehydrates a start line with no end and
 *      a page that draws that as a live spinner forever is a stale indicator
 *      nobody can clear.
 *   3. The set is not wedged. A second test can be started and is accepted.
 *
 * # Why the engine is really stopped
 *
 * The same reason engine-unreachable.spec.ts gives: a mock of "the process
 * went away" asserts the page, not the product. The rig stops the engine
 * container while the test is genuinely executing its validator, starts it
 * again and waits until it is healthy (harness/engine.ts).
 *
 * # What it needs
 *
 * A rig that can break the engine, and a set whose recovery-test validator
 * holds for tens of seconds so there is a middle to catch
 * (harness/assurance.ts). The rig supplies neither by default.
 */

test.describe("an engine restart in the middle of a recovery test", () => {
  test.describe.configure({ timeout: 900_000 });

  test.beforeEach(({ bm }) => {
    needs(bm.facts.configured, "a configured deployment");
    needs(canBreakEngine(), NEEDS_BREAKABLE_ENGINE);
    needs(resolveAssuranceFixtures().slowRecoverySet !== null, NEEDS_SLOW_RECOVERY_SET);
  });

  // One deployment is shared by the whole run: an engine left stopped by a
  // failing assertion would fail every file after this one, so it is healed
  // here as well as in the case.
  test.afterAll(async () => {
    const control = resolveEngineControl();
    if (control) await startEngine(control).catch(() => undefined);
  });

  test("the cut-off test is not a pass, is not shown running, and does not wedge the set", async ({ bm }) => {
    const setId = resolveAssuranceFixtures().slowRecoverySet ?? "";
    const control = resolveEngineControl();
    expect(control, "needs() above established the rig can break the engine").not.toBeNull();

    const passedBefore = await passedCopies(bm.api, setId);

    // 1. Start the test and wait until it is genuinely in flight: its start
    //    line is on the feed and its end line is not.
    const opId = await startRecoveryTest(bm.api, setId);
    await expect
      .poll(
        async () => {
          const feed = await liveFeed(bm.api, setId);
          const mine = feed.events.filter((e) => e.fields.op_id === opId);
          return {
            started: mine.some((e) => e.event === "recovery_test_start"),
            ended: mine.some((e) => e.event === "recovery_test_end")
          };
        },
        { message: "the test is in flight: started and not ended", timeout: 120_000, intervals: [500] }
      )
      .toEqual({ started: true, ended: false });

    // 2. Take the engine away and bring it back, healthy.
    await stopEngine(control!);
    await startEngine(control!);

    // 3a. Not a pass.
    expect(await passedCopies(bm.api, setId), "an interrupted test must not leave a new pass behind").toBeLessThanOrEqual(
      passedBefore
    );
    const feed = await liveFeed(bm.api, setId);
    expect(
      feed.events.filter((e) => e.fields.op_id === opId && e.event === "recovery_test_end" && e.result === "success"),
      "no success line was ever written for a test that was cut off"
    ).toEqual([]);

    // 3b. Not shown running. The page asks the feed for the set's open
    //     operation; after a restart that answer has to settle.
    await bm.goto(setPath(setId));
    await expect(
      bm.page.locator(`${OPERATION}[data-state="running"]`),
      "the page is still drawing the cut-off test as running"
    ).toHaveCount(0, { timeout: 90_000 });
    await expect(bm.page.getByRole("region", { name: "Assurance" })).not.toContainText("Recovery test passed");

    // 3c. Not wedged: a second test is accepted.
    const second = await startRecoveryTest(bm.api, setId);
    expect(second).not.toEqual(opId);
  });
});

/** How many of the set's copies carry a recovery state of passed. */
async function passedCopies(
  api: import("@playwright/test").APIRequestContext,
  setId: string
): Promise<number> {
  const [source, set] = setId.split("/");
  const res = await api.get("/api/v1/backups?setId=" + encodeURIComponent(setId));
  expect(res.status(), `listing ${source}/${set}'s backups`).toBe(200);
  const body = (await res.json()) as { artifacts?: { placements?: { recovery_state?: string }[] }[] };
  return (body.artifacts ?? []).reduce(
    (n, a) => n + (a.placements ?? []).filter((p) => p.recovery_state === "passed").length,
    0
  );
}
