import { NEEDS_SLOW_RECOVERY_SET, resolveAssuranceFixtures } from "../harness/assurance";
import { OPERATION, RECOVERY_TEST_STAGE_ORDER, operationSettles, setPath } from "./assurance-page";
import { expect, needs, test } from "./fixtures";

/**
 * retnd#985: stage progress for a recovery test, and a reload that replays it.
 *
 * Two claims, both about what an operator sees rather than about what the
 * engine logs:
 *
 *   - the page names the stage the test is in, the stages it names are the
 *     engine's own and arrive in the engine's order, and none goes backwards;
 *   - a reload in the middle lands on the SAME operation, at the same stage or
 *     later, with every line it already had and no line twice. Nothing the
 *     page holds is the source of truth; the feed is.
 *
 * # Why the test is slow on purpose
 *
 * A recovery test over three small files finishes before the page has drawn
 * its first stage, so a case about the middle needs a middle. The rig names a
 * set whose validator holds (harness/assurance.ts). Without one the case
 * states the skip; it does not pass over a test that was over before it began.
 *
 * # What it does not assert
 *
 * The verdict. A slow validator may pass or fail depending on the fixture, and
 * this case is about progress, so it accepts any terminal state and asserts
 * only that the page reached one and that no stage it drew was invented.
 */

test.describe("stage progress and a reload that replays it", () => {
  test.describe.configure({ timeout: 600_000 });

  test.beforeEach(({ bm }) => {
    needs(bm.facts.configured, "a configured deployment");
    needs(resolveAssuranceFixtures().slowRecoverySet !== null, NEEDS_SLOW_RECOVERY_SET);
  });

  test("a recovery test names its stages in order, and a reload mid-run lands on the same operation", async ({ bm }) => {
    const setId = resolveAssuranceFixtures().slowRecoverySet ?? "";
    await bm.goto(setPath(setId));
    const section = bm.page.getByRole("region", { name: "Assurance" });
    const run = section.getByRole("button", { name: "Run recovery test" });
    await expect(run, "the set page offers Run recovery test").toBeEnabled();
    await run.click();

    const op = bm.page.locator(OPERATION).first();
    await expect(op).toHaveAttribute("data-state", "running");
    await expect(bm.page.getByTestId("stage-label")).toContainText(/^Stage: /);
    const id = await op.getAttribute("data-operation-id");
    expect(id, "the operation publishes its id").toBeTruthy();

    // Let it get past its first stage so a reload has something to replay.
    await expect
      .poll(async () => (await op.getAttribute("data-stage")) ?? "", { timeout: 120_000, intervals: [500] })
      .not.toBe(RECOVERY_TEST_STAGE_ORDER[0]);
    const before = await lineSeqs(bm.page);
    const stageBefore = (await op.getAttribute("data-stage")) ?? "";
    expect(before.length, "a test past its first stage has lines to replay").toBeGreaterThan(0);

    // The reload.
    await bm.page.reload();
    const again = bm.page.locator(OPERATION).first();
    await expect(again, "the reload re-attached to the operation instead of showing nothing").toBeVisible({
      timeout: 30_000
    });
    expect(await again.getAttribute("data-operation-id"), "same operation, not a new one").toBe(id);
    const after = await lineSeqs(bm.page);
    for (const seq of before) {
      expect(after, `line ${String(seq)} survived the reload`).toContain(seq);
    }
    expect(new Set(after).size, "no line appears twice after the replay").toBe(after.length);
    const stageAfter = (await again.getAttribute("data-stage")) ?? "";
    expect(
      RECOVERY_TEST_STAGE_ORDER.indexOf(stageAfter),
      `after the reload the stage is ${stageAfter}, which must be ${stageBefore} or later`
    ).toBeGreaterThanOrEqual(RECOVERY_TEST_STAGE_ORDER.indexOf(stageBefore));

    // Watch it to the end, collecting every stage the page drew.
    const drawn: string[] = [stageBefore];
    const watching = (async () => {
      for (;;) {
        const state = await again.getAttribute("data-state");
        const stage = (await again.getAttribute("data-stage")) ?? "";
        if (stage !== "" && drawn[drawn.length - 1] !== stage) drawn.push(stage);
        if (state !== "running") return;
        await bm.page.waitForTimeout(250);
      }
    })();
    await Promise.all([watching, operationSettles(bm.page, 480_000)]);

    for (const stage of drawn) {
      expect(RECOVERY_TEST_STAGE_ORDER, `the page drew a stage the engine does not name: ${stage}`).toContain(stage);
    }
    const idx = drawn.map((s) => RECOVERY_TEST_STAGE_ORDER.indexOf(s));
    expect(idx, `stages went backwards: ${drawn.join(" -> ")}`).toEqual([...idx].sort((a, b) => a - b));
  });
});

async function lineSeqs(page: import("@playwright/test").Page): Promise<number[]> {
  const seqs = await page.locator('[data-testid="operation-line"]').evaluateAll((els) =>
    els.map((e) => Number((e as HTMLElement).dataset.seq))
  );
  return seqs.filter((n) => Number.isFinite(n));
}
