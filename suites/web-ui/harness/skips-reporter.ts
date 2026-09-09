// Why every skipped case was skipped, printed at the end of the run.
//
// This exists because the design it belongs to does not work without it.
// `mockOnly`, `needs` and `destructive` (e2e/fixtures.ts) each call
// `test.skip(condition, reason)`, and the whole argument for them over
// deleting a case is that the reason reaches whoever reads the run. It
// does not: Playwright's list reporter prints
//
//     -   23 [generic] › accessibility › a progress bar exposes its value
//
// and nothing else. The reason is in the annotation, which only the HTML
// and JSON reporters render, and a suite whose skip reasons are only
// legible after unzipping a report is a suite whose skips nobody reads.
// That is the shape this repository exists to argue against: a check that
// stopped running and did not say so.
//
// So this prints them, grouped, at the end, and it prints the counts even
// when nothing was skipped, because "0 skipped" is itself the reading that
// says the deployment was fully seeded.
//
// It is deliberately the last word of the run rather than a line per skip
// as they happen: interleaved with 260 result lines the reasons scroll
// past, and the useful artefact is the LIST, which is a to-do for whoever
// owns the topology.

import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/** One skipped case, with whatever reason it carried. */
interface Skipped {
  title: string;
  reason: string;
}

/** The three prefixes fixtures.ts stamps onto a reason, in the order they
 *  are worth reading: what can never run here, what this deployment cannot
 *  currently satisfy, and what was deliberately not armed. */
const GROUPS: Array<{ prefix: string; heading: string }> = [
  {
    prefix: "mock-only:",
    heading: "Cannot run against a real deployment (each names what it would take)"
  },
  {
    prefix: "needs ",
    heading: "This deployment is not in the state the case is about"
  },
  {
    prefix: "destructive:",
    heading: "Destroys data nothing puts back, and was not armed"
  }
];

/** Reads the reason off whichever of the two places Playwright put it.
 *
 *  A `test.skip(condition, reason)` evaluated at RUN time annotates the
 *  result; one evaluated while the file is collected annotates the test.
 *  Both shapes occur in this suite (`needs` runs inside a test or a
 *  beforeEach, `mockOnly` runs inside a test), so both are read rather
 *  than assuming the one that happened to be true when this was written. */
function reasonFor(test: TestCase, result: TestResult): string {
  const annotations = [...(result.annotations ?? []), ...test.annotations];
  const skip = annotations.find((a) => a.type === "skip" && (a.description ?? "") !== "");
  return skip?.description ?? "(no reason given)";
}

export default class SkipsReporter implements Reporter {
  private readonly skipped: Skipped[] = [];
  private ran = 0;

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === "skipped") {
      this.skipped.push({ title: test.titlePath().slice(1).join(" › "), reason: reasonFor(test, result) });
    } else {
      this.ran += 1;
    }
  }

  onEnd() {
    const total = this.ran + this.skipped.length;
    console.log("");
    console.log(
      "Against this deployment, " + this.ran + " of " + total + " cases asserted and " +
        this.skipped.length + " declined, for these reasons:"
    );

    if (this.skipped.length === 0) {
      // Worth saying out loud rather than printing nothing. A run with no
      // skips means the deployment satisfied every precondition in the
      // suite, which is a fact about the topology and not an empty list.
      console.log("  (nothing declined: this deployment satisfied every precondition in the suite)");
      console.log("");
      return;
    }

    // Grouped by reason rather than by case, because the reasons repeat:
    // eleven cases wanting a quarantined backup is one thing to arrange,
    // not eleven.
    for (const group of GROUPS) {
      const mine = this.skipped.filter((s) => s.reason.startsWith(group.prefix));
      if (mine.length === 0) continue;

      console.log("");
      console.log("  " + group.heading + " (" + mine.length + "):");
      const byReason = new Map<string, string[]>();
      for (const s of mine) {
        const reason = s.reason.slice(group.prefix.length).trim();
        byReason.set(reason, [...(byReason.get(reason) ?? []), s.title]);
      }
      for (const [reason, titles] of byReason) {
        console.log("    - " + reason);
        for (const title of titles) console.log("        " + title);
      }
    }

    const other = this.skipped.filter((s) => !GROUPS.some((g) => s.reason.startsWith(g.prefix)));
    if (other.length > 0) {
      // A skip this suite's own helpers did not produce. Worth its own
      // heading rather than folding into the groups above: a bare
      // `test.skip()` somebody added by hand is exactly the quiet deletion
      // those helpers exist to prevent.
      console.log("");
      console.log("  Skipped without going through mockOnly/needs/destructive (" + other.length + "):");
      for (const s of other) console.log("    - " + s.title + ": " + s.reason);
    }
    console.log("");
  }
}
