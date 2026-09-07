// Which image this run deploys, and how it is made to prove it.
//
// Every other suite here resolves the build under test through
// `build-under-test.json` and `tools/getbuild`, and this one does too. What
// it needs is one step further along: not a binary on the host but the
// container image an operator actually receives, since the thing under test
// is a deployment rather than a process. So the pin resolves the checkout,
// and `container/Dockerfile` in that checkout turns it into an image, which
// is exactly the route `getbuild`'s own docker builder takes and the same
// tag it uses, so the two share one cache rather than building twice.
//
// The identity handshake still happens, and it happens INSIDE the image:
// the run asks the image's own `/backup-manager` which commit it is, and
// refuses the run unless the answer matches the pin. Copying the binary out
// and handshaking the copy would prove something about the copy.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { docker, dockerOrThrow } from "./docker";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../../..");

interface ResolvedBuild {
  mode: string;
  provenance: string;
  cli: string;
  web?: string;
  source_dir?: string;
  version: string;
  commit: string;
}

export interface ImageUnderTest {
  /** What `docker run` is given. */
  reference: string;
  /** The commit the binaries inside it report about themselves. */
  commit: string;
  version: string;
  /** One line naming where this image came from, printed at startup so a
   *  run that passes has said out loud what it passed against. */
  provenance: string;
}

let cached: ImageUnderTest | undefined;
let cachedBuild: ResolvedBuild | undefined;

/** Resolves the image under test, builds it if this machine has not got it
 *  yet, and makes it state its own identity.
 *
 *  `RM_IMAGE` names an image directly, for the day the registry mode in
 *  docs/pinning.md goes live and for a developer testing a local build. It
 *  changes where the image comes from and nothing else: the handshake below
 *  still runs, and still compares against the pin unless `RM_COMMIT` says
 *  what that image is meant to be. That is the same contract local mode
 *  already has, and it is the point: naming an image is not evidence about
 *  what is in it. */
export async function resolveImage(): Promise<ImageUnderTest> {
  if (cached) return cached;

  const build = resolveBuild();
  const expectedCommit = (process.env.RM_COMMIT ?? "").trim() || build.commit;
  const explicit = (process.env.RM_IMAGE ?? "").trim();
  const reference = explicit !== "" ? explicit : `rclone-manager-tests/but:${build.commit.slice(0, 12)}`;

  const present = await docker(["image", "inspect", reference]);
  let provenance: string;
  if (present.code === 0) {
    provenance = `${reference}, already on this machine`;
  } else if (explicit !== "") {
    await dockerOrThrow(`pulling the image under test (${reference})`, ["pull", reference]);
    provenance = `${reference}, pulled`;
  } else {
    provenance = `${reference}, built from ${buildImageFromCheckout(build)}`;
  }

  const commit = await handshake(reference, expectedCommit, build);
  cached = { reference, commit, version: build.version, provenance };
  return cached;
}

/** The pin, resolved through the same command every other suite here uses.
 *
 *  It costs a `go run` and a compile of two binaries this suite never
 *  executes, and it is still the right call: `getbuild` is where "which
 *  build is under test" is decided, and a second mechanism answering the
 *  same question is how two suites end up certifying two different
 *  commits while both reporting green. */
function resolveBuild(): ResolvedBuild {
  if (cachedBuild) return cachedBuild;
  const raw = execFileSync("go", ["run", "./tools/getbuild/cmd/getbuild"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  cachedBuild = JSON.parse(raw) as ResolvedBuild;
  return cachedBuild;
}

/** The rclone-manager checkout the pin resolved.
 *
 *  The source machine's one shared Dockerfile lives in there, so asking for
 *  it here rather than anywhere else is what keeps both halves of a
 *  deployment on one commit: the manager is that commit's image, and the
 *  machine it backs up is that commit's definition of a simulated VPS. */
export function checkoutDir(): string {
  const build = resolveBuild();
  if (!build.source_dir) {
    throw new Error(
      "the pinned build resolved without a source checkout, so this run cannot reach " +
        "scripts/e2e/source-machine.Dockerfile, which is the one definition of the machine being backed up. " +
        "Use a pin mode that produces a checkout, or set RM_SOURCE_DIR (see docs/pinning.md)."
    );
  }
  return build.source_dir;
}

/** Builds `container/Dockerfile` out of the pinned checkout.
 *
 *  Not a `docker compose build`: compose's own `build:` block needs the
 *  whole `.env` a deployment has, and what is wanted here is only the
 *  image. The build arguments are the two the Dockerfile documents as its
 *  one deliberate source of version information, and passing them is what
 *  makes the handshake below possible at all: without them the binaries
 *  report `commit none` and the run is refused, which is the handshake
 *  working rather than something to route around. */
function buildImageFromCheckout(build: ResolvedBuild): string {
  const checkout = build.source_dir;
  if (!checkout) {
    throw new Error(
      "the pinned build resolved without a source checkout, so there is no container/Dockerfile to build the " +
        "image under test from. Point this run at an image with RM_IMAGE, or use a pin mode that produces a " +
        "checkout (see docs/pinning.md)."
    );
  }
  const dockerfile = resolve(checkout, "container/Dockerfile");
  if (!existsSync(dockerfile)) {
    throw new Error(`the pinned checkout at ${checkout} has no container/Dockerfile, so there is no image to build.`);
  }
  process.stderr.write(`live-deployment: building the image under test from ${checkout} (once per commit)\n`);
  execFileSync(
    "docker",
    [
      "build",
      "-f",
      "container/Dockerfile",
      "--build-arg",
      `VERSION=${build.version}`,
      "--build-arg",
      `COMMIT=${build.commit}`,
      "-t",
      `rclone-manager-tests/but:${build.commit.slice(0, 12)}`,
      "."
    ],
    { cwd: checkout, stdio: ["ignore", "inherit", "inherit"] }
  );
  return checkout;
}

/** Makes the image say which commit it is, and refuses the run if it is
 *  not the one the pin promised.
 *
 *  Run with no network, no mounts and nothing to write to: the point is to
 *  read one line out of a binary, and a throwaway container that can reach
 *  the network is a larger thing than the question needs. */
async function handshake(reference: string, expected: string, build: ResolvedBuild): Promise<string> {
  const out = await dockerOrThrow(
    `asking ${reference} which build it is`,
    ["run", "--rm", "--network", "none", "--read-only", reference, "/backup-manager", "version"],
    { timeoutMs: 60_000 }
  );
  const reported = /^commit (\S+)$/m.exec(out)?.[1];
  if (!reported) {
    throw new Error(`${reference} printed no commit line, so there is nothing to check the pin against:\n${out}`);
  }
  if (!commitsAgree(reported, expected)) {
    throw new Error(
      `identity handshake failed: the image ${reference} reports commit ${reported}, but the pin ` +
        `(${build.mode} mode, ${build.provenance}) promised ${expected}.\n` +
        "Refusing to run: a suite that certifies an unknown build certifies nothing. " +
        "If that image really is the build you mean to test, say so with RM_COMMIT.\n" +
        `version output:\n${out}`
    );
  }
  return reported;
}

/** The same rule `tools/getbuild/handshake.go` applies to a binary, applied
 *  to an image: either side may be an abbreviation of the other, seven
 *  characters is the shortest thing git hands out so anything shorter is no
 *  answer at all, and a build from a modified tree may carry `-dirty` that
 *  the pin does not.
 *
 *  Restated in TypeScript rather than shelled out to, because the Go
 *  handshake takes a path to a binary on the host and what is being
 *  identified here is an image. `harness/image.test.ts` pins the rule,
 *  including the cases where it must say no. */
export function commitsAgree(observed: string, expected: string): boolean {
  const o = observed.replace(/-dirty$/, "");
  const e = expected.replace(/-dirty$/, "");
  if (o.length < 7 || e.length < 7) return false;
  return o.startsWith(e) || e.startsWith(o);
}
