import http from "node:http";

import { csrfHeaders } from "../harness/session";
import { NEEDS_BIG_ARTIFACT, resolveAssuranceFixtures } from "../harness/assurance";
import { backupPath } from "./assurance-page";
import { expect, needs, test } from "./fixtures";

/**
 * retnd#985 / retnd#1072: a browser that leaves in the middle of a download.
 *
 * # What the page owes
 *
 * The browser's own download manager is the progress and cancel surface for a
 * streamed download (retnd#1072), so the page cannot see the transfer. What it
 * CAN do is say what the server recorded, and that has to be one of three
 * distinct things: completed, interrupted at N of M bytes, or failed
 * verification. An interrupted download must read as interrupted, with how far
 * it got, and must never reach the rendering of a success. A reload does not
 * lose it, because it is read from the server and not held by the page.
 *
 * # Pending product
 *
 * The recorded outcome and its rendering are retnd W-12b's (the artifact
 * page, retnd#1057 on top of the durable feed). This case is written against
 * the decision (EPIC Q panel 2, call 6) and is expected to be RED until that
 * lands; it is not skipped, because a skip would turn the day the product
 * lands into a day nothing notices.
 *
 * # How the browser leaves
 *
 * The case is the client. It mints a grant through the API, opens the
 * download with the session's cookies, reads the first bytes, and destroys the
 * socket: a TCP reset, which is what closing a tab does to a transfer in
 * flight. It needs a backup large enough that the engine has not already
 * written all of it (harness/assurance.ts says how large and why), which the
 * rig does not seed by default; without one the case states that skip, and that
 * is the only skip in it.
 */

test.describe("a download the browser abandons", () => {
  test.beforeEach(({ bm }) => {
    needs(bm.facts.configured, "a configured deployment");
    needs(resolveAssuranceFixtures().bigArtifact !== null, NEEDS_BIG_ARTIFACT);
  });

  test("the artifact page says interrupted at N of M bytes, and a reload keeps saying it", async ({ bm }) => {
    const big = resolveAssuranceFixtures().bigArtifact;
    expect(big).not.toBeNull();
    const id = big?.id ?? "";

    // Mint a grant for a browser download.
    const mint = await bm.api.post("/api/v1/backups/" + id.split("/").map(encodeURIComponent).join("/") + "/recovery", {
      headers: await csrfHeaders(bm.api),
      data: { target: { kind: "download" } }
    });
    expect(mint.status(), "minting a download grant: " + (await mint.text())).toBeLessThan(300);
    const grant = (await mint.json()) as { download_url?: string; size_bytes?: number };
    expect(grant.download_url, "the grant names the URL the browser follows").toBeTruthy();

    // Read a little, then reset the connection.
    const received = await readThenReset(bm, grant.download_url ?? "", 1 << 20);
    expect(received, "some bytes arrived before the client left").toBeGreaterThan(0);
    expect(received, "and fewer than all of them, or this was never an interruption").toBeLessThan(big?.bytes ?? 0);

    // The page says what the server recorded.
    await bm.goto(backupPath(id));
    const outcome = bm.page.getByText(/interrupted at /i).first();
    await expect(outcome, "the artifact page renders the interrupted outcome").toBeVisible({ timeout: 60_000 });
    const text = (await outcome.innerText()).replace(/\s+/g, " ");
    const m = /interrupted at ([\d.,]+)\s*(\w*)\s+of\s+([\d.,]+)\s*(\w*)/i.exec(text);
    expect(m, `the outcome reads 'interrupted at N of M bytes': ${text}`).not.toBeNull();
    const [, n, nUnit, total, totalUnit] = m ?? [];
    expect(nUnit.toLowerCase(), "N and M are in the same unit").toBe(totalUnit.toLowerCase());
    if (nUnit === "" || nUnit.toLowerCase().startsWith("byte")) {
      const toNum = (s: string) => Number(s.replace(/[.,](?=\d{3}\b)/g, ""));
      expect(toNum(total), "M is the backup's size").toBe(big?.bytes);
      expect(toNum(n), "N is short of M").toBeLessThan(toNum(total));
    }

    // It is not a success, anywhere near it.
    await expect(bm.page.getByText(/download (completed|complete)\b/i)).toHaveCount(0);
    await expect(bm.page.getByText(/failed verification/i), "an interruption is not a verification failure").toHaveCount(0);

    // And a reload keeps it: the page holds nothing.
    await bm.page.reload();
    await expect(bm.page.getByText(/interrupted at /i).first()).toBeVisible({ timeout: 60_000 });
  });
});

/** GETs the grant's URL with the browser context's cookies, resolves with the
 *  number of body bytes read when it reset the socket after `atLeast`. */
async function readThenReset(
  bm: { api: import("@playwright/test").APIRequestContext },
  path: string,
  atLeast: number
): Promise<number> {
  const base = new URL(process.env.RETND_BASE_URL ?? "");
  const state = await bm.api.storageState();
  const cookie = state.cookies.map((c) => c.name + "=" + c.value).join("; ");
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      { host: base.hostname, port: base.port || 80, path, method: "GET", headers: { cookie } },
      (res) => {
        if ((res.statusCode ?? 0) >= 300) {
          reject(new Error("the grant did not redeem: " + String(res.statusCode)));
          res.destroy();
          return;
        }
        let got = 0;
        res.on("data", (chunk: Buffer) => {
          got += chunk.length;
          if (got >= atLeast) {
            res.destroy();
            req.destroy();
            resolve(got);
          }
        });
        res.on("end", () => resolve(got));
        res.on("error", () => resolve(got));
      }
    );
    req.on("error", () => undefined);
    req.end();
  });
}
