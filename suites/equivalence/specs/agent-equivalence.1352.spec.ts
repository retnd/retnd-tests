import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { expect, test } from "@playwright/test";

import { bootStack, buildUiBundle, resolveUiDir, type Stack } from "../harness/stack";
import { materialise, resolveBuild, type Build } from "../harness/tools";

// retnd#1352 (EPIC U, U2.4, FR-94): the same read and the same refusal, put to
// the CLI, to the stdio transport and to the HTTP transport, and the answers
// held equal. The browser's half is ui/shared/e2e/1352-agent-equivalence.spec.ts
// in the product repository, which has no exit status to compare and so
// compares the code and the message the page prints against this table.
//
// Three things have to agree for each row, in the shape
// encryption-suites.1319.spec.ts and exit-codes.986.spec.ts set:
//   - the code and the message are the same strings on every surface;
//   - the exit code a tool result reports is the status the CLI's own process
//     ended with for the same call;
//   - the `command` a tool result echoes is the CLI twin the catalogue names
//     (`retnd agent tools --json`), so the echo cannot say one thing while the
//     transport does another.
//
// The rows:
//   reads:    status, backups_list, encryption_state
//   refusals: a read token asking run_cycle (AGENT_SCOPE_INSUFFICIENT), and a
//             person's run_cycle against the same call approved for an
//             operate token.
//
// What "the CLI twin" can mean. The CLI is the cookie client: it signs in as
// the administrator and never presents a bearer, so it cannot be refused for
// a scope and has no way to make a read token's call. For the scope refusal
// the equivalent is therefore the API itself (the same POST with the token's
// bearer), and the CLI's part is the exit status it gives an engine refusal
// whose code it has no mapping of its own for, which a real CLI refusal
// (`agent confirmations approve` on an id that is not there) shows.
//
// What "a shut gate" cannot mean here. The destructive gate is open for the
// generic profile (NewProfileGate: a local-account profile with no gateway
// opens it), and this harness boots the generic engine, so `operation run`
// really does exit 0 and queue the cycle. The earlier draft of this spec
// expected exit 50 from a gate nothing in this rig can shut; the third test
// now holds what is real on this rig, a person's run and an approved one
// ending alike. It was red until retnd#1385 (the approval replay was refused
// as plain http, exit 52) was fixed, and is the reproduction of that.

interface Answer {
  code: string;
  message: string;
  exit: number;
}

interface Surface {
  name: string;
  call(tool: string, args?: Record<string, unknown>): Promise<Record<string, any>>;
  close(): void;
}

const READS = ["status", "backups_list", "encryption_state"];

function cli(build: Build, work: string, argv: string[], env: Record<string, string> = {}) {
  const r = spawnSync(build.cli, [...argv, "--config", resolve(work, "config.yaml")], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 << 20
  });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** What a routed CLI call needs to reach the engine and sign in as the
 *  administrator. The CLI is the cookie client and presents no bearer:
 *  RETND_AGENT_TOKEN is read only by `agent serve --stdio`. */
function attach(stack: Stack): Record<string, string> {
  return { RETND_API_URL: stack.engineUrl, RETND_API_USERNAME: stack.username, RETND_API_PASSWORD: stack.password };
}

function mint(build: Build, stack: Stack, name: string, scope: string): string {
  const r = cli(build, stack.work, ["agent", "token", "create", name, "--scope", scope], attach(stack));
  expect(r.code, r.stderr).toBe(0);
  const token = r.stdout.trim();
  expect(token, "the token is the only thing on standard output").toMatch(/^rat_\S+$/);
  return token;
}

/** The answer a tool result carries, with the transport's own envelope gone. */
function answerOf(result: Record<string, any>): Answer {
  const s = result.structuredContent ?? {};
  return { code: String(s.code ?? ""), message: String(s.message ?? ""), exit: Number(s.exit_code ?? 0) };
}

class StdioSurface implements Surface {
  name = "stdio";
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, (v: any) => void>();
  private id = 0;

  constructor(build: Build, stack: Stack, tokenFile: string) {
    this.child = spawn(build.cli, ["agent", "serve", "--stdio", "--token-file", tokenFile], {
      env: { ...process.env, RETND_API_URL: stack.engineUrl },
      stdio: ["pipe", "pipe", "pipe"]
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) this.pending.get(msg.id)?.(msg);
    });
  }

  private rpc(method: string, params: unknown): Promise<any> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`stdio ${method} timed out`)), 30_000);
      this.pending.set(id, (v) => {
        clearTimeout(timer);
        res(v);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async init() {
    await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "equivalence", version: "0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  }

  async call(tool: string, args: Record<string, unknown> = {}) {
    const msg = await this.rpc("tools/call", { name: tool, arguments: args });
    expect(msg.error, JSON.stringify(msg.error)).toBeUndefined();
    return msg.result;
  }

  close() {
    this.child.kill();
  }
}

class HttpSurface implements Surface {
  name = "http";
  private session = "";
  private id = 0;

  constructor(private url: string, private token: string) {}

  private async rpc(method: string, params: unknown, notify = false): Promise<any> {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
    const id = notify ? undefined : ++this.id;
    if (id !== undefined) body.id = id;
    const r = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.token}`,
        ...(this.session ? { "Mcp-Session-Id": this.session } : {})
      },
      body: JSON.stringify(body)
    });
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (notify) return undefined;
    const text = await r.text();
    const data = (r.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)))
      : [JSON.parse(text)];
    return data.find((m: any) => m.id === id) ?? data[0];
  }

  async init() {
    await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "equivalence", version: "0" } });
    await this.rpc("notifications/initialized", {}, true);
  }

  async call(tool: string, args: Record<string, unknown> = {}) {
    const msg = await this.rpc("tools/call", { name: tool, arguments: args });
    expect(msg.error, JSON.stringify(msg.error)).toBeUndefined();
    return msg.result;
  }

  close() {}
}

/** Signs in as the administrator over HTTP and returns what a mutating call
 *  needs: the cookies and the CSRF pair. */
async function person(stack: Stack) {
  const cold = await fetch(`${stack.engineUrl}/health/live`);
  const csrf = /retnd_csrf=([^;]+)/.exec(cold.headers.get("set-cookie") ?? "")?.[1] ?? "";
  const login = await fetch(`${stack.engineUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, Cookie: `retnd_csrf=${csrf}` },
    body: JSON.stringify({ username: stack.username, password: stack.password })
  });
  expect(login.status).toBe(204);
  const session = /retnd_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
  return { csrf, cookie: `retnd_csrf=${csrf}; retnd_session=${session}` };
}

/** The CLI twin the catalogue names for a tool: `retnd agent tools --json`
 *  carries it in the row's `twin` field, as a string beginning "retnd ". */
function twinOf(build: Build, stack: Stack, tool: string): string {
  const r = cli(build, stack.work, ["agent", "tools", "--json"], attach(stack));
  expect(r.code, r.stderr).toBe(0);
  const rows = JSON.parse(r.stdout).tools as Array<Record<string, any>>;
  const row = rows.find((x) => x.name === tool);
  expect(row, `the catalogue has no row for ${tool}`).toBeDefined();
  const twin = row!.twin;
  expect(typeof twin === "string" && twin.startsWith("retnd "), `the ${tool} row names no retnd twin`).toBe(true);
  return twin as string;
}

/** Runs a twin as the CLI would be typed, with `--json` left to the caller. */
function runTwin(build: Build, stack: Stack, twin: string, env: Record<string, string>) {
  const argv = twin.replace(/^retnd /, "").split(" ").filter(Boolean);
  return cli(build, stack.work, argv, env);
}

test.describe("retnd#1352: the same read and the same refusal on the CLI, stdio and http", () => {
  let build: Build;
  let stack: Stack;
  let readToken: string;
  let operateToken: string;
  const surfaces: Surface[] = [];
  const surfacesAs = new Map<string, Surface[]>();

  test.beforeAll(async () => {
    build = resolveBuild();
    // The transport is off by default, so this deployment turns it on in its
    // own configuration before it boots, the way an operator would.
    const work = materialise("seeded-local", "agent-equivalence-1352", build.cli, new Date().toISOString());
    appendFileSync(resolve(work.work, "config.yaml"), "agents:\n  http_transport: on\n");
    stack = await bootStack(build, work.work, buildUiBundle(resolveUiDir(build)));

    readToken = mint(build, stack, "equiv-read", "read");
    operateToken = mint(build, stack, "equiv-operate", "operate");

    const dir = mkdtempSync(resolve(tmpdir(), "agent-equivalence-"));
    for (const [label, token] of [["read", readToken], ["operate", operateToken]] as const) {
      const file = resolve(dir, `${label}.token`);
      writeFileSync(file, token + "\n", { mode: 0o600 });
      const stdio = new StdioSurface(build, stack, file);
      await stdio.init();
      const http = new HttpSurface(`${stack.engineUrl}/api/v1/agent/mcp`, token);
      await http.init();
      surfacesAs.set(label, [stdio, http]);
      surfaces.push(stdio, http);
    }
  });

  test.afterAll(async () => {
    for (const s of surfaces) s.close();
    await stack?.stop();
  });

  for (const tool of READS) {
    test(`read ${tool}: equal answers, the CLI's exit status and the catalogue's twin`, async () => {
      const twin = twinOf(build, stack, tool);
      const reference = runTwin(build, stack, twin, attach(stack));
      expect(reference.code, `the CLI twin \`${twin}\` failed: ${reference.stderr}`).toBe(0);

      const answers: Array<[string, Answer, string]> = [];
      for (const s of surfacesAs.get("read")!) {
        const result = await s.call(tool);
        answers.push([s.name, answerOf(result), String(result.structuredContent?.command ?? "")]);
      }
      for (const [name, a, command] of answers) {
        expect(a.exit, `${name} reported exit ${a.exit} for a read the CLI answered with ${reference.code}`).toBe(reference.code);
        expect(command.replace(/ --json$/, ""), `${name} echoed a command other than the catalogue's twin`).toBe(twin);
      }
      expect(answers[0][1], "stdio and http answered differently").toEqual(answers[1][1]);
    });
  }

  test("refusal: a read token asking run_cycle is refused alike by the API, stdio and http, with the exit status the CLI gives that refusal", async () => {
    // The API twin: the same POST, the read token's bearer, no confirmation.
    const direct = await fetch(`${stack.engineUrl}/api/v1/operations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readToken}`, "Idempotency-Key": "equivalence-1352-scope" },
      body: JSON.stringify({ action: "run_cycle" })
    });
    const envelope = ((await direct.json()) as { error: { code: string; message: string } }).error;
    expect(direct.status).toBe(403);
    expect(envelope.code).toBe("AGENT_SCOPE_INSUFFICIENT");

    // The CLI's own exit for an engine refusal it has no mapping for: a real
    // refusal from a real CLI call, so the number is read and not assumed.
    const anchor = cli(build, stack.work, ["agent", "confirmations", "approve", "cnf_not_there"], attach(stack));
    expect(anchor.stderr, "the anchor refusal is the one it was meant to be").toContain("AGENT_CONFIRMATION_NOT_FOUND");
    expect(anchor.code, "the anchor must be a refusal").not.toBe(0);

    const answers: Array<[string, Answer]> = [];
    for (const s of surfacesAs.get("read")!) {
      const result = await s.call("run_cycle");
      answers.push([s.name, answerOf(result)]);
    }
    for (const [name, a] of answers) {
      expect(a.code, `${name}`).toBe(envelope.code);
      expect(a.message, `${name}'s message is not the API's`).toBe(envelope.message);
      expect(a.exit, `${name}'s exit code against the CLI's exit for an unmapped engine refusal`).toBe(anchor.code);
    }
    expect(answers[0][1], "stdio and http answered differently").toEqual(answers[1][1]);
  });

  test("refusal: a person's run_cycle and an approved operate token's run_cycle end alike", async () => {
    // The person: the CLI routed to the engine, as the administrator.
    const twin = twinOf(build, stack, "run_cycle");
    const typed = runTwin(build, stack, twin, attach(stack));
    expect(typed.code, typed.stderr).toBe(0);

    // The agent: an operate token's call becomes a confirmation, and the
    // operator approves it with a step-up.
    const { csrf, cookie } = await person(stack);
    // The revision a run is checked against. The CLI reads it from
    // GET /system/version itself; no agent tool reads that route, so an agent
    // has to be handed it (retnd#1387), and this test hands it over the way an
    // operator would.
    const version = await fetch(`${stack.engineUrl}/api/v1/system/version`, { headers: { Cookie: cookie } });
    const revision = String(((await version.json()) as Record<string, any>).config_revision ?? "");
    expect(revision, "the engine names its configuration revision").not.toBe("");
    const executions: Array<[string, Record<string, any>]> = [];
    for (const s of surfacesAs.get("operate")!) {
      const pending = await s.call("run_cycle", { body: { config_revision: revision } });
      expect(answerOf(pending).code).toBe("AGENT_CONFIRMATION_REQUIRED");
      const id = String(pending.structuredContent?.confirmation_id ?? "");
      expect(id, "the pending call names its confirmation").not.toBe("");
      const approved = await fetch(`${stack.engineUrl}/api/v1/agent/confirmations/${id}/approve`, {
        method: "POST",
        headers: { "X-CSRF-Token": csrf, Cookie: cookie, "X-Retnd-Step-Up-Password": stack.password }
      });
      expect(approved.status).toBe(200);
      const body = (await approved.json()) as Record<string, any>;
      executions.push([s.name, body.execution ?? {}]);
    }
    for (const [name, e] of executions) {
      expect(e.code, `${name}: what the approved call ended with`).not.toBe("INSECURE_TRANSPORT_ACK_REQUIRED");
      expect(e.exit_code, `${name}: exit code against the CLI's own, execution ${JSON.stringify(e)}`).toBe(typed.code);
      expect(e.status, `${name}: the engine's status`).toBeLessThan(400);
    }
  });
});
