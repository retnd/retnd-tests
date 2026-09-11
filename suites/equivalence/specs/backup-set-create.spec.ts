import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, signIn, test } from "../harness/fixtures";
import { compareState, runCli } from "../harness/tools";

// Matrix row: "Add a backup set", the create half.
//
// This row used to say the CLI equivalent was "edit config.yaml per FR-5,
// then check", which is not a CLI equivalent at all: it is the absence of
// one, written as though it were a feature. The Web UI and the API could
// both create a backup set and the CLI could not, so the row recorded a
// capability that existed on two surfaces and not on the third.
// backupd#356 added `backupd backup-set create`, and this is
// what turns that into a proved row rather than a claim.
//
// # Why this drives the API rather than the wizard
//
// The row is about CREATE, and the wizard's own path to it goes through a
// live host-key probe: its "Verify server" step opens a real SSH
// connection to the machine being backed up, and no fixture in this
// repository has one. The API is the same operation without that step,
// and it is what the wizard calls, so driving POST /backup-sets is the
// honest comparison this fixture can actually make. The wizard's own
// steps are a different row and still blocked on an SSH endpoint, which
// is backupd#87-shaped work.
//
// # Why the key is placed rather than imported
//
// Both surfaces take an ssh_key_id, a reference to a key this deployment
// has already imported, and both mint that id as a fresh uuid at import
// time. Two independent imports of the same key therefore land under two
// different filenames by design, which is correct behaviour and would
// make a filesystem comparison unequal for a reason that has nothing to
// do with creation. So the key is placed under one id on both sides
// first, and the import is left to the row it belongs to. What is being
// compared here is what CREATE does with the same inputs.
const KEY_ID = "equivalence-fixed-key";

/** A real ed25519 private key, generated per run and never written into
 *  this repository. PKCS#8 PEM rather than OpenSSH's own container
 *  because that is what node can emit, and it is a shape the product
 *  genuinely accepts: internal/transport/rclone.ValidateImportedPrivateKey
 *  goes through ssh.ParseRawPrivateKey, which reads a "PRIVATE KEY" block.
 */
function newPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  return privateKey as unknown as string;
}

/** A syntactically real known_hosts line for a host nothing in this suite
 *  ever dials. Creation never opens a connection: the trust anchor is
 *  decided before the set is persisted, which is exactly why it is an
 *  input here rather than something either surface goes and fetches. */
const KNOWN_HOSTS_LINE =
  "[source.example.internal]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ7Zq1i0i7Xw3v0m7d3Wl1nZk5Q9tJm2fVYy0m9c8ZqR";

/** The one backup set both surfaces are asked to create, in each
 *  surface's own vocabulary. One object, so the two calls below cannot
 *  quietly diverge on a value and still be called a comparison. */
const SPEC = {
  source: "api",
  name: "postgres",
  host: "source.example.internal",
  port: 2222,
  user: "backupuser",
  remotePath: "/srv/backups",
  localPath: "/srv/restore/postgres",
  include: ["*.dump.zst", "*.sql.gz"],
  completionStrategy: "rename",
  staleAfterSeconds: 172800,
  readOnly: true
};

function placeKey(work: string, pem: string): void {
  // Where core/service's own keysDirIn puts an imported key: a sibling of
  // config.yaml. Read back through resolveSSHKeyFileIn, which only checks
  // the file is there, so placing it is the same thing an import leaves
  // behind minus the random id.
  const dir = resolve(work, "ssh_keys");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(dir, KEY_ID), pem, { mode: 0o600 });
}

async function csrf(page: import("@playwright/test").Page): Promise<string> {
  const cookie = (await page.context().cookies()).find((c) => c.name === "bm_csrf");
  if (!cookie) throw new Error("no bm_csrf cookie, so a CSRF-gated request cannot be made");
  return cookie.value;
}

test.describe("create a backup set", () => {
  test("creating one through the API leaves the same backend state as creating it through the CLI", async ({
    page,
    pair
  }) => {
    const pem = newPrivateKey();
    placeKey(pair.ui.work, pem);
    placeKey(pair.cli.work, pem);

    const sources = (work: string) => runCli(pair.build, work, ["sources"]).stdout;

    const uiBefore = sources(pair.ui.work);
    const cliBefore = sources(pair.cli.work);
    expect(uiBefore, "the two sides did not start from the same configuration").toBe(
      cliBefore.replaceAll(pair.cli.work, pair.ui.work)
    );
    expect(uiBefore, "the fixture already has the set this row is about to create").not.toContain(
      `${SPEC.source}/${SPEC.name}`
    );

    // ---- the API side, which is what the wizard calls
    await signIn(page, pair.ui);
    const created = await page.request.post(pair.ui.uiUrl + "/api/v1/backup-sets", {
      headers: { "X-CSRF-Token": await csrf(page) },
      data: {
        source_name: SPEC.source,
        name: SPEC.name,
        host: SPEC.host,
        port: SPEC.port,
        user: SPEC.user,
        ssh_key_id: KEY_ID,
        known_hosts_line: KNOWN_HOSTS_LINE,
        remote_path: SPEC.remotePath,
        local_path: SPEC.localPath,
        include: SPEC.include,
        completion_strategy: SPEC.completionStrategy,
        stale_after_seconds: SPEC.staleAfterSeconds,
        read_only: SPEC.readOnly
      }
    });
    expect(created.status(), await created.text()).toBe(201);

    // ---- the CLI side, through the verb backupd#356 added
    const cli = runCli(pair.build, pair.cli.work, [
      "backup-set",
      "create",
      `${SPEC.source}/${SPEC.name}`,
      "--host", SPEC.host,
      "--port", String(SPEC.port),
      "--user", SPEC.user,
      "--ssh-key-id", KEY_ID,
      "--known-hosts-line", KNOWN_HOSTS_LINE,
      "--remote-path", SPEC.remotePath,
      "--local-path", SPEC.localPath,
      "--include", SPEC.include.join(","),
      "--completion-strategy", SPEC.completionStrategy,
      "--stale-after", `${SPEC.staleAfterSeconds}s`,
      "--read-only"
    ]);
    expect(cli.code, cli.stderr).toBe(0);

    // ---- both changes really landed, before anything is compared
    const uiAfter = sources(pair.ui.work);
    const cliAfter = sources(pair.cli.work);
    expect(uiAfter, "the API call did not reach the backend").not.toBe(uiBefore);
    expect(cliAfter, "the CLI verb did not change the configuration").not.toBe(cliBefore);
    expect(uiAfter).toContain(`${SPEC.source}/${SPEC.name}`);
    expect(cliAfter).toContain(`${SPEC.source}/${SPEC.name}`);

    // ---- the configuration each side persisted, compared directly
    //
    // Unlike the settings row, this one CAN compare config.yaml, and
    // should: both surfaces reach the same core/service method, so the
    // two files come out of the same YAML writer, and the only thing that
    // legitimately differs is the work directory in the absolute paths.
    // A difference here is a real divergence between the two surfaces,
    // which is the whole thing this row exists to catch, so it is asserted
    // before the broader comparison rather than folded into it.
    const uiConfig = readFileSync(resolve(pair.ui.work, "config.yaml"), "utf8").replaceAll(pair.ui.work, "${WORK}");
    const cliConfig = readFileSync(pair.cli.config, "utf8").replaceAll(pair.cli.work, "${WORK}");
    expect(cliConfig, "the API and the CLI persisted different configurations for the same request").toBe(uiConfig);

    // ---- and the same backend state, through the same oracle every
    //      other row here uses
    const result = compareState(pair.build, pair.ui.work, pair.cli.work, {
      // local-auth.json: only the UI side has an enrolled administrator,
      // because a browser has to sign in and the CLI has no equivalent to
      // enrol one with. Setup asymmetry, named rather than absorbed.
      // local-auth.json.lock for the same reason harness.spec.ts names it:
      // a process-lifetime advisory flock, so its presence says which side
      // still had a server up, not what either side wrote.
      //
      // config.yaml: both sides write it through the same YAML writer, so
      // the only thing that differs is the work directory inside its
      // absolute paths, which a byte digest cannot forgive and
      // maskVolatile does not try to. It is compared directly above,
      // path-normalised, which is a stronger assertion than the file half
      // could make anyway.
      ignoreFiles: ["config.yaml", "local-auth.json", "local-auth.json.lock"],
      maskVolatile: true
    });
    expect(result.equal, "the API and the CLI left different backend state:\n" + result.report).toBe(true);
  });
});
