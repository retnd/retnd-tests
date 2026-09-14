/**
 * The script tree the rig seeds, written down once (backupd#816).
 *
 * # Why these are constants and the SET NAMES are not
 *
 * A backup set name is a thing the rig chooses and could reasonably
 * change, so it arrives in an environment variable and a spec that was
 * not given one says so. A script's FILENAME is different: it is half of
 * the fixture's behaviour. `10-fail.local.sh` exits non-zero, and a case
 * that asserted on whatever script happened to be in the directory would
 * pass against a tree that no longer contains the failure it is named
 * for.
 *
 * So the tree is pinned here, agreed with the rig before either side
 * wrote it, and a mismatch is a loud failure in one place rather than a
 * quiet green in eleven.
 *
 * # The suffix is the target
 *
 * `NAME.local.sh` executes on the manager through the Host Workflow
 * Runner; `NAME.remote.sh` is sent to the source machine over an
 * execution connection. Nothing in this suite infers the target from
 * anything else, because the product does not either.
 */

/** The happy path: one hook each side of the backup, both local, both
 *  succeeding. */
export const HAPPY_BEFORE = "10-quiesce.local.sh";
export const HAPPY_AFTER = "90-resume.local.sh";
export const HAPPY_BEFORE_LINE = "e2e-hook happy before ok";
export const HAPPY_AFTER_LINE = "e2e-hook happy after ok";

/** The remote pair, executed over the exec-capable connection. The
 *  "before" one prints the hostname it ran on, which is the only line in
 *  this suite that proves a hook really left the manager. */
export const REMOTE_BEFORE = "10-marker.remote.sh";
export const REMOTE_AFTER = "90-marker.remote.sh";
export const REMOTE_BEFORE_LINE = "e2e-hook remote before ok";

/** The same bytes as the remote pair, on the SFTP-only source, where the
 *  server genuinely refuses an exec channel. */
export const SFTP_ONLY_SCRIPT = "10-marker.remote.sh";

/** A before hook that exits non-zero, so the backup is never attempted. */
export const BEFORE_FAIL = "10-fail.local.sh";

/** An after hook that exits non-zero, so the backup succeeded and the
 *  workflow did not. This is the split #814 exists to make sayable. */
export const AFTER_FAIL = "90-fail.local.sh";

/** OSC 8, an xterm title set and a window manipulation, then a plain
 *  line. None of the three may reach the browser as an effect. */
export const HOSTILE = "50-hostile.local.sh";

/** Prints the LENGTH of the resolved secret and never the secret.
 *
 *  Deliberately, and the reason is the assertion it protects: a script
 *  that echoed the material would put it in the durable log, the terminal
 *  would correctly render it, and "the secret is nowhere in the DOM"
 *  would fail against a product doing exactly the right thing. */
export const SECRET_SCRIPT = "10-secret.local.sh";
export const SECRET_ENV_NAME = "WF_E2E_SECRET";
export const SECRET_LINE = "e2e-hook secret resolved, length";

/** A bounded burst, for the follower cases. */
export const SLOW_SCRIPT = "10-burst.local.sh";

/** Long enough to be caught mid-flight and crashed into, and the cleanup
 *  hook that a resume is then owed. */
export const CRASH_HOLD = "10-hold.local.sh";
export const CRASH_CLEANUP = "90-release.local.sh";
export const CRASH_CLEANUP_LINE = "e2e-hook crash cleanup ran";

/** A hook that SUCCEEDS and is deliberately untidy, so the findings
 *  panel has something in it. Both of its rules are below the severity
 *  that gates a save, which is the point: a warning is reported and
 *  saves fine, and only an error refuses.
 *
 *  BSH002 is an unchecked `cd` (warning) and BSH001 an unquoted
 *  expansion (info); every other seeded script is deliberately clean, so
 *  an empty panel elsewhere is the contrast that makes this one mean
 *  something. */
export const FINDINGS_SCRIPT = "10-findings.local.sh";
export const FINDINGS_WARNING_CODE = "BSH002";
export const FINDINGS_INFO_CODE = "BSH001";

/** And the one whose finding IS at error severity: BSH003, a forced
 *  recursive delete whose expansion can be empty. It is the only fixture
 *  that proves the GATE rather than the report, and it is attached to no
 *  set for a reason the rig found by trying: a save that points at it is
 *  REFUSED, by the CLI and by the API alike, so a set configured with it
 *  is not a state any route can reach.
 *
 *  The position is the rule's own, read off the refusal the engine
 *  printed: pinning it is what keeps this case from passing on a
 *  different script in the same directory. */
export const REJECTED_SCRIPT = "10-reject.local.sh";
export const REJECTED_ERROR_CODE = "BSH003";
export const REJECTED_POSITION = "23:8";

/** Six scripts across two stages, for the case that counts mounted
 *  terminals. */
export const MANY_BEFORE = ["10-a.local.sh", "20-b.local.sh", "30-c.local.sh", "40-d.local.sh"];
export const MANY_AFTER = ["50-e.local.sh", "60-f.local.sh"];

/** Attached to no set until a spec attaches it, so that the deployment's
 *  ordinary state has no global stages and the "nothing runs for this
 *  set" empty state stays reachable. */
export const GLOBAL_BEFORE = "05-global.local.sh";
export const GLOBAL_BEFORE_LINE = "e2e-hook global before ok";

/** The variable naming the directory above, relative to the workflow
 *  root, as `settings workflow patch --before-dir` spells it. */
export const GLOBAL_BEFORE_DIR_VAR = "RM_WF_GLOBAL_BEFORE_DIR";
