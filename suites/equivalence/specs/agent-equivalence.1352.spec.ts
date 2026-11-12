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
//             person at the shut gate, reached by the transports as an
//             operate token's call approved by the operator (the gate then
//             refuses it exactly as it refuses a person: DESTRUCTIVE_OPERATIONS_DISABLED, 50).
//
// Written against the spec's names table (section 12) while the transports
// were still being written; not run. The places that assume a name the spec
// does not fix are marked ASSUMES and are the first thing to read if a row
// goes red for the wrong reason.

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

/** What a routed CLI call needs to reach the engine and be a person (or, with
 *  `token`, an agent). ASSUMES RETND_AGENT_TOKEN is what the attached CLI
 *  presents as a bearer when set, the way the stdio verb takes it. */
function attach(stack: Stack, token?: string): Record<string, string> {
  const env: Record<string, string> = { RETND_API_URL: stack.engineUrl };
  if (token) env.RETND_AGENT_TOKEN = token;
  else {
    env.RETND_API_USERNAME = stack.username;
    env.RETND_API_PASSWORD = stack.password;
  }
  return env;
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
    this.child = spawn(build.cli, ["agent", "serve", "--stdio", "--token-file", tokenFile, "--config", resolve(stack.work, "config.yaml")], {
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

/** The CLI twin the catalogue names for a tool. ASSUMES a `retnd agent tools
 *  --json` row carries it as a string beginning "retnd " under one of these
 *  keys. */
function twinOf(build: Build, stack: Stack, tool: string): string {
  const r = cli(build, stack.work, ["agent", "tools", "--json"], attach(stack));
  expect(r.code, r.stderr).toBe(0);
  const rows = (JSON.parse(r.stdout).tools ?? JSON.parse(r.stdout)) as Array<Record<string, any>>;
  const row = rows.find((x) => x.tool === tool || x.name === tool);
  expect(row, `the catalogue has no row for ${tool}`).toBeDefined();
  const twin = ["twin", "command", "cli", "retnd"].map((k) => row![k]).find((v) => typeof v === "string" && v.startsWith("retnd "));
  expect(twin, `the ${tool} row names no retnd twin`).toBeDefined();
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

  test("refusal: a read token asking run_cycle is refused alike by the CLI, stdio and http", async () => {
    const answers: Array<[string, Answer]> = [];
    for (const s of surfacesAs.get("read")!) {
      const result = await s.call("run_cycle");
      answers.push([s.name, answerOf(result)]);
    }
    const twin = twinOf(build, stack, "run_cycle");
    const typed = runTwin(build, stack, twin, attach(stack, readToken));
    expect(typed.code, "the CLI under a read token should be refused").not.toBe(0);

    for (const [name, a] of answers) {
      expect(a.code, `${name}`).toBe("AGENT_SCOPE_INSUFFICIENT");
      expect(a.exit, `${name} exit code against the CLI's own`).toBe(typed.code);
      expect(typed.stderr, `${name}'s message is not the one the CLI printed`).toContain(a.message);
    }
    expect(answers[0][1], "stdio and http answered differently").toEqual(answers[1][1]);
  });

  test("refusal: a person at the shut gate, and an approved operate call, are refused alike", async () => {
    // The person: the CLI routed to the engine, as the administrator.
    const twin = twinOf(build, stack, "run_cycle");
    const typed = runTwin(build, stack, twin, attach(stack));
    expect(typed.code, typed.stderr).toBe(50);

    // The agent: an operate token's call becomes a confirmation, the operator
    // approves it with a step-up, and the gate refuses what was approved.
    const { csrf, cookie } = await person(stack);
    const answers: Array<[string, Answer]> = [];
    for (const s of surfacesAs.get("operate")!) {
      const pending = await s.call("run_cycle");
      expect(answerOf(pending).code).toBe("AGENT_CONFIRMATION_REQUIRED");
      const id = String(pending.structuredContent?.confirmation_id ?? pending.structuredContent?.confirmation?.id ?? "");
      expect(id, "the pending call names its confirmation").not.toBe("");
      const approved = await fetch(`${stack.engineUrl}/api/v1/agent/confirmations/${id}/approve`, {
        method: "POST",
        headers: { "X-CSRF-Token": csrf, Cookie: cookie, "X-Retnd-Step-Up-Password": stack.password }
      });
      const body = (await approved.json()) as Record<string, any>;
      answers.push([s.name, { code: String(body.code ?? ""), message: String(body.message ?? ""), exit: Number(body.exit_code ?? 0) }]);
    }
    for (const [name, a] of answers) {
      expect(a.code, name).toBe("DESTRUCTIVE_OPERATIONS_DISABLED");
      expect(a.exit, `${name} exit code against the CLI's own`).toBe(typed.code);
      expect(typed.stderr, `${name}'s message is not the one the CLI printed`).toContain(a.message);
    }
    expect(answers[0][1], "stdio and http answered differently").toEqual(answers[1][1]);
  });
});
