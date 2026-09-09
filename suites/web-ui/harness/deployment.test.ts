// What the runner reads out of the environment, and what it refuses.
//
// These replaced the port helper's unit tests, and they are the same kind
// of test for the opposite job: that one pinned how a port was derived and
// validated, because the suite started its own server; this one pins how a
// deployment is named and validated, because it no longer does.
//
// The refusals are the point. A suite that silently defaults its base URL
// is a suite that can report green against nothing, so every one of those
// cases asserts that the run STOPS, and asserts on the words it stops
// with, because a refusal nobody can act on costs as much as no refusal.

import { describe, expect, it } from "vitest";

import {
  BASE_URL_VAR,
  PASSWORD_VAR,
  PLATFORM_VAR,
  USERNAME_VAR,
  resolveArtifactPaths,
  resolveBaseUrl,
  resolveChromiumArgs,
  resolveDeployment,
  resolvePlatform,
  resolveWorkers
} from "./deployment";

/** A complete, valid environment. Every case below starts from this and
 *  breaks exactly one thing, so a failure names the thing it broke. */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    RM_BASE_URL: "http://rclone-manager:8080",
    RM_ADMIN_USERNAME: "e2e-admin",
    // Not a credential: this file never talks to anything, and the string
    // exists only so the resolver has a non-empty value to carry.
    RM_ADMIN_PASSWORD: "unit-test-placeholder-value",
    ...overrides
  } as NodeJS.ProcessEnv;
}

describe("the base URL", () => {
  it("is taken as given, so a container name resolves through Docker's DNS", () => {
    expect(resolveBaseUrl(env())).toBe("http://rclone-manager:8080");
  });

  it("refuses to default, and says why there is no default", () => {
    expect(() => resolveBaseUrl(env({ RM_BASE_URL: undefined }))).toThrow(/RM_BASE_URL/);
    // The whole reason this variable is required rather than defaulted.
    expect(() => resolveBaseUrl(env({ RM_BASE_URL: undefined }))).toThrow(/localhost/);
  });

  it("treats an empty value as unset rather than as a URL", () => {
    expect(() => resolveBaseUrl(env({ RM_BASE_URL: "   " }))).toThrow(/is not set/);
  });

  it("refuses something that is not a URL at all", () => {
    expect(() => resolveBaseUrl(env({ RM_BASE_URL: "http://" }))).toThrow(/not a URL/);
  });

  // The commonest way to get this wrong, and the reason the refusal names
  // the fix. `rclone-manager:8080` is not rejected as unparseable: URL
  // reads it as a scheme called `rclone-manager`, so without this check it
  // would sail through and reach page.goto as nonsense.
  it("refuses a host and port with no scheme in front of it", () => {
    expect(() => resolveBaseUrl(env({ RM_BASE_URL: "rclone-manager:8080" }))).toThrow(
      /write http:\/\/host:port/
    );
  });

  it("refuses a scheme a browser cannot be pointed at", () => {
    expect(() => resolveBaseUrl(env({ RM_BASE_URL: "ftp://rclone-manager" }))).toThrow(/http or https/);
  });

  it("trims a trailing slash, so a path is appended once", () => {
    expect(resolveBaseUrl(env({ RM_BASE_URL: "http://rclone-manager:8080/" }))).toBe(
      "http://rclone-manager:8080"
    );
  });
});

describe("the credentials", () => {
  it("are required, both of them", () => {
    expect(() => resolveDeployment(env({ RM_ADMIN_USERNAME: undefined }))).toThrow(
      new RegExp(USERNAME_VAR)
    );
    expect(() => resolveDeployment(env({ RM_ADMIN_PASSWORD: undefined }))).toThrow(
      new RegExp(PASSWORD_VAR)
    );
  });

  it("carry no bootstrap token unless the run was handed one", () => {
    expect(resolveDeployment(env()).bootstrapToken).toBeNull();
    expect(resolveDeployment(env({ RM_BOOTSTRAP_TOKEN: "tok" })).bootstrapToken).toBe("tok");
  });
});

describe("the seeded backup set", () => {
  it("is absent unless the topology named one", () => {
    expect(resolveDeployment(env()).seededBackupSet).toBeNull();
  });

  it("comes through as the topology spells it", () => {
    expect(resolveDeployment(env({ RM_BACKUP_SET: "e2e/vps" })).seededBackupSet).toBe("e2e/vps");
  });

  // A set id is source and set, two segments. A one-segment value would
  // reach a spec as a name nothing on the page ever matches, and the
  // failure would read as the page missing a set rather than as the run
  // being told the wrong thing.
  it("refuses a value that is not a backup set id", () => {
    expect(() => resolveDeployment(env({ RM_BACKUP_SET: "vps" }))).toThrow(/RM_BACKUP_SET/);
  });
});

describe("the provider bundle", () => {
  it("is generic unless the deployment says otherwise", () => {
    expect(resolvePlatform(env())).toBe("generic");
  });

  it("is taken from the environment when it is one this product ships", () => {
    expect(resolvePlatform(env({ RM_PLATFORM: "synology" }))).toBe("synology");
  });

  // The sharp one. This variable DESCRIBES the image rather than
  // configuring it, so a typo does not fall back to a default that happens
  // to work: it makes the provider spec assert one platform's treatment
  // against another's, which is a red nobody can read.
  it("refuses a name this product does not ship, and lists the ones it does", () => {
    expect(() => resolvePlatform(env({ RM_PLATFORM: "qnap" }))).toThrow(new RegExp(PLATFORM_VAR));
    expect(() => resolvePlatform(env({ RM_PLATFORM: "qnap" }))).toThrow(/openmediavault/);
  });
});

describe("the source machine", () => {
  it("is absent unless the run was told where it is", () => {
    expect(resolveDeployment(env()).source).toBeNull();
  });

  it("comes back whole when it is named", () => {
    const source = resolveDeployment(
      env({
        RM_VPS_HOST: "vps",
        RM_VPS_USER: "backup",
        RM_VPS_PATH: "/srv/outgoing"
      })
    ).source;
    expect(source).toEqual({ host: "vps", port: 22, user: "backup", path: "/srv/outgoing" });
  });

  // A half-named source is worse than none: the wizard cases would type a
  // hostname, fail to list anything, and report a product defect.
  it("refuses a hostname with nothing to list on it", () => {
    expect(() => resolveDeployment(env({ RM_VPS_HOST: "vps" }))).toThrow(/RM_VPS_USER/);
  });
});

describe("how many browsers run at once", () => {
  it("is one, because one deployment is one database", () => {
    expect(resolveWorkers(env())).toBe(1);
  });

  it("can be raised deliberately", () => {
    expect(resolveWorkers(env({ RM_WORKERS: "4" }))).toBe(4);
  });

  it("refuses a value that is not a count", () => {
    expect(() => resolveWorkers(env({ RM_WORKERS: "lots" }))).toThrow(/RM_WORKERS/);
    expect(() => resolveWorkers(env({ RM_WORKERS: "0" }))).toThrow(/RM_WORKERS/);
  });
});

describe("Chromium inside a container", () => {
  // 64MB of /dev/shm is the container default, Chromium puts its
  // renderer's shared memory there, and running out of it kills the tab
  // with a bare "Target closed" that reads as a product failure.
  it("always keeps its shared memory off /dev/shm", () => {
    expect(resolveChromiumArgs(env())).toContain("--disable-dev-shm-usage");
  });

  // Opt-in, because it is a real reduction in isolation and only an image
  // that runs the browser as root needs it.
  it("only drops the sandbox when the image says it has to", () => {
    expect(resolveChromiumArgs(env())).not.toContain("--no-sandbox");
    expect(resolveChromiumArgs(env({ RM_NO_SANDBOX: "1" }))).toContain("--no-sandbox");
  });
});

describe("where the evidence goes", () => {
  // The one that cost a run. Playwright removes its own outputDir on
  // startup, and RM_ARTIFACTS_DIR is a bind mount, which cannot be
  // unlinked from inside the container: pointing outputDir straight at it
  // dies with EACCES rmdir before a browser ever starts. So both paths sit
  // a level below it.
  it("never puts the test output directory on the mount point itself", () => {
    const paths = resolveArtifactPaths(env({ RM_ARTIFACTS_DIR: "/artifacts" }));
    expect(paths.outputDir).not.toBe("/artifacts");
    expect(paths.outputDir.startsWith("/artifacts/")).toBe(true);
  });

  // And Playwright refuses an HTML report folder nested inside the test
  // output folder, so the two are siblings.
  it("keeps the HTML report beside the test output rather than inside it", () => {
    const paths = resolveArtifactPaths(env({ RM_ARTIFACTS_DIR: "/artifacts" }));
    expect(paths.htmlReport.startsWith(paths.outputDir)).toBe(false);
    expect(paths.htmlReport.startsWith("/artifacts/")).toBe(true);
  });

  it("tolerates a trailing slash on the mount path", () => {
    expect(resolveArtifactPaths(env({ RM_ARTIFACTS_DIR: "/artifacts/" })).outputDir).toBe(
      "/artifacts/test-results"
    );
  });

  it("falls back to the suite directory when no artifacts directory is named", () => {
    expect(resolveArtifactPaths(env()).outputDir).toBe("./test-results");
  });
});

describe("the whole deployment", () => {
  it("resolves every field a run needs from one call", () => {
    const deployment = resolveDeployment(env({ RM_ALLOW_DESTRUCTIVE: "1" }));
    expect(deployment.baseURL).toBe("http://rclone-manager:8080");
    expect(deployment.credentials.username).toBe("e2e-admin");
    expect(deployment.platform).toBe("generic");
    expect(deployment.allowDestructive).toBe(true);
  });

  it("keeps destructive runs off by default", () => {
    expect(resolveDeployment(env()).allowDestructive).toBe(false);
    // Anything other than the exact opt-in is off, so a stray "true" or
    // "yes" cannot quietly arm a run that deletes retained backups.
    expect(resolveDeployment(env({ RM_ALLOW_DESTRUCTIVE: "true" })).allowDestructive).toBe(false);
  });

  it("names the missing variable rather than the first thing that broke", () => {
    expect(() => resolveDeployment(env({ RM_BASE_URL: undefined }))).toThrow(
      new RegExp(BASE_URL_VAR)
    );
  });
});
