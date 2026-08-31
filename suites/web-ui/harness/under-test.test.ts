// The port one run serves itself on has to be the same number in every
// process of that run, and this proves it with the real scanner rather
// than a stub of it.
//
// Playwright re-evaluates playwright.config.ts in the runner and again in
// every worker. Before the handoff, each of those processes ran its own
// free-port scan, and by the time a worker ran its one the runner's Vite
// was already holding the runner's answer, so the worker walked to the
// next slot and pointed `baseURL` at nothing. Each test below therefore
// occupies the runner's port for real, the way Vite does, and then asks a
// second process what it would resolve.
//
// The negative control is the load-bearing half. "Two calls agreed" is
// also what you get from a scanner that never moves, so the same
// occupied port is put in front of a resolver with no handoff to inherit,
// and that one has to DISAGREE. Without it this file would pass just as
// happily against the broken version.
import { createServer, type Server } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { PORT_HANDOFF_VAR, resolvePort } from "./under-test";

const HERE = dirname(fileURLToPath(import.meta.url));
// Any directory does: resolvePort only asks git which checkout it is in,
// so that two worktrees derive different ports. It never reads the app.
const SOME_CHECKOUT = resolve(HERE, "../../..");

const opened: Server[] = [];

/** Hold a port the way the runner's own Vite holds it. */
function occupy(port: number): Promise<void> {
  return new Promise((ok, fail) => {
    const server = createServer();
    opened.push(server);
    server.once("error", fail);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => ok());
  });
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => new Promise<void>((ok) => s.close(() => ok()))));
});

describe("resolvePort", () => {
  it("gives a worker the runner's port back even once the runner's server holds it", async () => {
    const runnerEnv: NodeJS.ProcessEnv = {};
    const runnerPort = resolvePort(SOME_CHECKOUT, runnerEnv);

    await occupy(runnerPort);

    // A forked worker inherits the runner's environment, so this is the
    // same object a worker would see. This assertion comes first on
    // purpose: it is the race, and it is what should be the visible red
    // if the handoff is ever taken back out.
    const workerEnv: NodeJS.ProcessEnv = { ...runnerEnv };
    expect(resolvePort(SOME_CHECKOUT, workerEnv)).toBe(runnerPort);

    // The control: with nothing to inherit, the scan really does move on
    // from an occupied port. So the agreement above is the handoff doing
    // its job, and not the port happening to still be free.
    expect(resolvePort(SOME_CHECKOUT, {})).not.toBe(runnerPort);

    // And the mechanism it agreed through, so a run that agreed for some
    // other reason still reads as a change worth looking at.
    expect(runnerEnv[PORT_HANDOFF_VAR]).toBe(String(runnerPort));
  });

  it("refuses an inherited value that is not a port instead of resolving NaN", () => {
    for (const bad of ["", " ", "not-a-port", "0", "70000", "5930x"]) {
      const env: NodeJS.ProcessEnv = { [PORT_HANDOFF_VAR]: bad };
      if (bad.trim() === "") {
        // An empty value means "nothing was handed over", the same way
        // E2E_PORT treats one, so it falls through to the scan.
        expect(resolvePort(SOME_CHECKOUT, env)).toBeGreaterThan(0);
        continue;
      }
      expect(() => resolvePort(SOME_CHECKOUT, env)).toThrow(PORT_HANDOFF_VAR);
    }
  });

  it("lets E2E_PORT win outright, and hands nothing over, because every process reads it", () => {
    const env: NodeJS.ProcessEnv = { E2E_PORT: "5273" };
    expect(resolvePort(SOME_CHECKOUT, env)).toBe(5273);
    expect(env[PORT_HANDOFF_VAR]).toBeUndefined();
  });
});
