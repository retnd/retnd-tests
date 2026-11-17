import type { Locator, Page } from "@playwright/test";

import type { WireArtifactRow } from "../harness/api";

/** The one row of the Backups table that is this artifact.
 *
 *  A file name alone is not an identity: every spec that runs a backup of
 *  its own leaves a `marker.txt` behind, in a set of its own, so by the
 *  time a later spec looks the name up there are many rows carrying it.
 *  The set it lives in is what tells them apart (retnd-tests#106). */
export function artifactRow(page: Page, artifact: Pick<WireArtifactRow, "name" | "set_name">): Locator {
  return page.getByRole("row").filter({ hasText: artifact.name });
}
