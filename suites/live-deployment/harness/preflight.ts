// What has to be true before a single browser starts, checked once, out
// loud, in the runner.
//
// Two things go wrong here rather than deep inside a test. Docker being
// absent is one: this suite deploys the product into containers, so a
// machine without a daemon cannot perform the proof at all, and it says so
// and stops instead of producing a green run that stood nothing up. The
// other is the image under test, which is resolved and made to state its
// own commit here so that a mismatch aborts before any test has reported
// anything.
//
// It also prints what this run is about to certify. suites/web-ui prints
// the tree it serves for the same reason: a run that passes should have
// said out loud what it passed against.
import { requireDocker } from "./docker";
import { resolveImage } from "./image";

export default async function preflight(): Promise<void> {
  await requireDocker();
  const image = await resolveImage();
  process.stdout.write(
    `live-deployment: image under test is ${image.provenance}\n` +
      `live-deployment: it reports version ${image.version}, commit ${image.commit}\n`
  );
}
