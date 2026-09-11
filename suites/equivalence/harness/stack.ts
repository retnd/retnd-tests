// Booting the real thing: the real engine serving the real /api/v1 over a
// real fixture work directory, with the real built UI bundle in front of
// it, so a browser can drive a backend-affecting action end to end.
//
// This is what separates Suite C from Suite B. Suite B drives the mock API
// under `npm run dev`; nothing it does reaches a backend, by design. Here
// the page the browser loads is `vite build` output, where
// import.meta.env.DEV is false and createMockApi is tree-shaken out
// entirely, so every call the page makes is a real HTTP request to a real
// engine that really writes to a real work directory.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { type Build, REPO_ROOT, WORK_ROOT } from "./tools";

/** A port nothing is listening on, taken from the ephemeral range and
 *  handed straight to a child that binds it. The window between the probe
 *  and the bind is real; the servers here are started by this process and
 *  never adopted, so losing it produces a start failure rather than a run
 *  that reports on somebody else's server. Suite B's README has the long
 *  version of why that distinction is not academic here. */
export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const server = createServer();
    server.once("error", rej);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) return rej(new Error("no port"));
      const port = addr.port;
      server.close(() => res(port));
    });
  });
}

/** The ui/shared whose production bundle the browser loads. RM_UI_DIR when
 *  the caller names one (backupd's own gate does), otherwise the
 *  pinned build's own checkout, so the page and the engine come from one
 *  commit rather than two independently chosen ones. */
export function resolveUiDir(build: Build): string {
  const explicit = (process.env.RM_UI_DIR ?? "").trim();
  const dir = explicit !== "" ? resolve(explicit) : resolve(build.source_dir ?? "", "ui/shared");
  if (!existsSync(resolve(dir, "package.json"))) {
    throw new Error(`no ui/shared at ${dir}. Set RM_UI_DIR to a checkout's ui/shared.`);
  }
  if (!existsSync(resolve(dir, "node_modules"))) {
    throw new Error(`${dir} has no installed dependencies, so it cannot be built. Fix it with: cd ${dir} && npm ci`);
  }
  return dir;
}

let cachedBundle: string | undefined;

/** Builds the production bundle once per run, into this repository's own
 *  .work/ rather than into the product checkout's dist/. The product tree
 *  under test is not this suite's to write into, and a suite that leaves
 *  build output in the tree it is testing has changed the thing it is
 *  measuring. */
export function buildUiBundle(uiDir: string): string {
  if (cachedBundle) return cachedBundle;
  const out = resolve(WORK_ROOT, "equiv-ui-bundle");
  execFileSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir"], {
    cwd: uiDir,
    stdio: ["ignore", "inherit", "inherit"]
  });
  cachedBundle = out;
  return out;
}

export interface Stack {
  /** The work directory this stack's engine reads and writes. */
  work: string;
  /** Where the browser goes. Same origin as the API, which the built
   *  client requires: its BASE is a relative "/api/v1". */
  uiUrl: string;
  engineUrl: string;
  /** The administrator this run enrolled. Generated per run and held in
   *  memory only; nothing here writes a credential to disk. */
  username: string;
  password: string;
  stop(): Promise<void>;
}

function waitFor(url: string, deadlineMs = 30_000): Promise<void> {
  const started = Date.now();
  return new Promise((res, rej) => {
    const attempt = async () => {
      try {
        const r = await fetch(url);
        if (r.status < 500) return res();
      } catch {
        // not up yet
      }
      if (Date.now() - started > deadlineMs) return rej(new Error(`nothing answered ${url} within ${deadlineMs}ms`));
      setTimeout(attempt, 150);
    };
    void attempt();
  });
}

/** Boots an engine plus a UI host over one work directory, enrols an
 *  administrator, and hands back everything a spec needs to drive it.
 *
 *  Enrolment happens over HTTP rather than through the browser on purpose.
 *  It is setup, not the action under test, and the one-time bootstrap
 *  token stays in a variable: it is never written to a file, never passed
 *  through argv where `ps` would show it, and never printed. */
export async function bootStack(build: Build, work: string, bundle: string): Promise<Stack> {
  const enginePort = await freePort();
  const uiPort = await freePort();
  const children: ChildProcess[] = [];

  const stop = async () => {
    for (const child of children) {
      if (child.pid !== undefined && child.exitCode === null) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
  };

  let engineOut = "";
  const engine = spawn(
    build.web,
    [
      "serve",
      "--config",
      resolve(work, "config.yaml"),
      "--listen",
      `127.0.0.1:${enginePort}`,
      "--auth-store",
      resolve(work, "state", "local-auth.json")
    ],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );
  children.push(engine);
  engine.stdout.on("data", (b: Buffer) => (engineOut += b.toString()));
  engine.stderr.on("data", (b: Buffer) => (engineOut += b.toString()));

  const engineUrl = `http://127.0.0.1:${enginePort}`;
  try {
    await waitFor(`${engineUrl}/health/live`);
  } catch (err) {
    await stop();
    throw new Error(`the engine did not come up:\n${engineOut}\n${String(err)}`);
  }

  const token = /Enrollment bootstrap token: (\S+)/.exec(engineOut)?.[1];
  if (!token) {
    await stop();
    throw new Error(`the engine printed no enrolment token, so this run cannot authenticate:\n${engineOut}`);
  }

  const username = "equivalence-admin";
  // Generated per run, held in memory, never written anywhere.
  const password = `equiv-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

  // Any GET issues the double-submit CSRF cookie; /health/live is the one
  // route outside the authenticated group, so it is reachable cold.
  const cold = await fetch(`${engineUrl}/health/live`);
  const csrf = /bm_csrf=([^;]+)/.exec(cold.headers.get("set-cookie") ?? "")?.[1];
  if (!csrf) {
    await stop();
    throw new Error("the engine issued no bm_csrf cookie, so enrolment cannot be submitted");
  }

  const enrolled = await fetch(`${engineUrl}/api/v1/auth/enroll`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      "X-Bootstrap-Token": token,
      Cookie: `bm_csrf=${csrf}`
    },
    body: JSON.stringify({ username, password })
  });
  if (enrolled.status !== 204) {
    await stop();
    throw new Error(`enrolment returned ${enrolled.status}: ${await enrolled.text()}`);
  }

  const ui = spawn(
    build.web,
    ["serve-ui", "--listen", `127.0.0.1:${uiPort}`, "--upstream", engineUrl, "--ui-dir", bundle],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );
  children.push(ui);
  let uiOut = "";
  ui.stdout.on("data", (b: Buffer) => (uiOut += b.toString()));
  ui.stderr.on("data", (b: Buffer) => (uiOut += b.toString()));

  const uiUrl = `http://127.0.0.1:${uiPort}`;
  try {
    await waitFor(`${uiUrl}/`);
  } catch (err) {
    await stop();
    throw new Error(`the UI host did not come up:\n${uiOut}\n${String(err)}`);
  }

  return { work, uiUrl, engineUrl, username, password, stop };
}
