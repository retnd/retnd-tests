import type { APIRequestContext, Page } from "@playwright/test";

import { csrfHeaders } from "../harness/session";
import { expect } from "./fixtures";

/**
 * What the recovery and assurance specs share about the screens (retnd#985).
 *
 * Selectors are the ones the page publishes for exactly this: `data-claim`
 * and `data-state` on a chip, `data-stage`, `data-state` and `data-seq` on an
 * operation, and the words on a button. Nothing here reads a colour or a
 * class name.
 */

/** The stages a recovery test goes through, in the engine's order. A copy of
 *  ui/shared's RECOVERY_TEST_STAGES, because this suite imports nothing from
 *  the product (README: it is an outside consumer). If the engine changes the
 *  order, the stage-progress spec goes red and says which stage moved. */
export const RECOVERY_TEST_STAGE_ORDER: readonly string[] = [
  "resolving_copy",
  "reading",
  "verifying",
  "validating",
  "cleaning_temporary_files",
  "complete"
];

export const OPERATION = '[data-testid="operation-progress"]';

/** A backup's page, from its `source/set/name` id. */
export const backupPath = (id: string): string => "/backups/" + id.split("/").map(encodeURIComponent).join("/");

/** A set's page, from its `source/set` id. */
export const setPath = (id: string): string => "/sets/" + id.split("/").map(encodeURIComponent).join("/");

/** The three claims on a backup's page, by their own attribute. */
export const claim = (page: Page, which: "stored" | "content" | "recovery") =>
  page.locator('[data-testid="assurance-claims"]').first().locator(`[data-claim="${which}"]`);

/** Waits for the operation on the page to stop running, and returns how it
 *  ended. A scrub that found a bad copy and one that found none are both
 *  terminal; the chip, not this, says which. */
export async function operationSettles(page: Page, timeoutMs = 180_000): Promise<string> {
  const op = page.locator(OPERATION).first();
  await expect(op).toBeVisible({ timeout: 30_000 });
  await expect(op).not.toHaveAttribute("data-state", "running", { timeout: timeoutMs });
  return (await op.getAttribute("data-state")) ?? "";
}

/** Presses Scrub now on a set's page. A page with no such button on a build
 *  that is meant to have it is a failure, not a skip: the button is the
 *  feature (retnd#1059, the scrub-start route). */
export async function scrubNow(page: Page, setId: string): Promise<string> {
  await page.goto(setPath(setId));
  const section = page.getByRole("region", { name: "Assurance" });
  const button = section.getByRole("button", { name: "Scrub now" });
  await expect(button, "the set page offers Scrub now, which needs the scrub-start route").toBeVisible();
  await expect(button).toBeEnabled();
  await button.click();
  return operationSettles(page);
}

/** Starts a recovery test through the route the page uses, and returns the
 *  operation id it answered with. */
export async function startRecoveryTest(api: APIRequestContext, setId: string): Promise<string> {
  const [source, set] = setId.split("/");
  const res = await api.post(
    "/api/v1/backup-sets/" + encodeURIComponent(source) + "/" + encodeURIComponent(set) + "/recovery-test",
    { headers: await csrfHeaders(api), data: {} }
  );
  expect(res.status(), "starting a recovery test answers 202 with an operation id: " + (await res.text())).toBe(202);
  const body = (await res.json()) as { operation_id?: string };
  expect(body.operation_id, "the 202 carries the id the feed's lines are keyed by").toBeTruthy();
  return body.operation_id ?? "";
}

export interface LiveEvent {
  sequence: number;
  event: string;
  result?: string;
  fields: Record<string, string>;
}

/** What the set's live feed holds, flattened the way the page flattens it:
 *  the events with their key/value fields as a record, and the actions that
 *  have started and not yet ended. */
export async function liveFeed(
  api: APIRequestContext,
  setId: string
): Promise<{ events: LiveEvent[]; unfinished: { actionId: string; action: string }[] }> {
  const res = await api.get("/api/v1/activity/live?backup_set=" + encodeURIComponent(setId));
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    sets?: {
      backup_set_id?: string;
      events?: { sequence: number; event: string; result?: string; fields?: { key: string; value: string }[] }[];
      unfinished_actions?: { action_id: string; action: string }[];
    }[];
  };
  const mine = (body.sets ?? []).find((s) => s.backup_set_id === setId);
  return {
    events: (mine?.events ?? []).map((e) => ({
      sequence: e.sequence,
      event: e.event,
      result: e.result,
      fields: Object.fromEntries((e.fields ?? []).map((f) => [f.key, f.value]))
    })),
    unfinished: (mine?.unfinished_actions ?? []).map((u) => ({ actionId: u.action_id, action: u.action }))
  };
}
