import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveSocketPath,
  ensureSocketDir,
  writeSocketRef,
  readSocketRef,
  cleanup,
} from "../_shared/socket-path";

const SOCKET_DIR = "/tmp/pi-verifier";
const SHORT_SID = "abc12345";

describe("resolveSocketPath", () => {
  it("returns canonical socket path under /tmp/pi-verifier and a breadcrumb under <cwd>/.pi/state", () => {
    const cwd = "/home/user/proj";
    const { socketPath, refPath } = resolveSocketPath(SHORT_SID, cwd);
    expect(socketPath).toBe(`/tmp/pi-verifier/${SHORT_SID}.sock`);
    expect(refPath).toBe(`/home/user/proj/.pi/state/verifier-${SHORT_SID}.sock.ref`);
  });

  it.each([
    ["empty", ""],
    ["slash", "a/b"],
    ["null byte", "a\0b"],
    ["whitespace", "a b"],
  ])("throws on invalid sessionId (%s)", (_label, sid) => {
    expect(() => resolveSocketPath(sid, "/cwd")).toThrow(/sessionId must be/);
  });

  it("throws when the resolved path would exceed the sun_path budget", () => {
    // 100-byte budget; craft a sessionId long enough to push past it.
    const longSid = "x".repeat(100);
    expect(() => resolveSocketPath(longSid, "/cwd")).toThrow(/sun_path limit/);
  });
});

describe("ensureSocketDir", () => {
  it("creates /tmp/pi-verifier with mode 0700 (idempotent)", async () => {
    await ensureSocketDir();
    const stat = fs.statSync(SOCKET_DIR);
    expect(stat.isDirectory()).toBe(true);
    // mode bits (ignore file-type high bits)
    expect(stat.mode & 0o777).toBe(0o700);
    // idempotent second call
    await expect(ensureSocketDir()).resolves.toBeUndefined();
  });
});

describe("writeSocketRef / readSocketRef", () => {
  let tmpCwd: string;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "vfy-cwd-"));
  });
  afterEach(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("writes and reads back the socket path breadcrumb", async () => {
    const refPath = path.join(tmpCwd, ".pi", "state", "verifier-x.sock.ref");
    await writeSocketRef("/tmp/pi-verifier/x.sock", refPath);
    const got = await readSocketRef(refPath);
    expect(got).toBe("/tmp/pi-verifier/x.sock");
  });

  it("creates the .pi/state parent dir if missing", async () => {
    const refPath = path.join(tmpCwd, ".pi", "state", "verifier-y.sock.ref");
    expect(fs.existsSync(path.dirname(refPath))).toBe(false);
    await writeSocketRef("/tmp/pi-verifier/y.sock", refPath);
    expect(fs.existsSync(refPath)).toBe(true);
  });

  it("readSocketRef throws a clear ENOENT message when missing", async () => {
    const refPath = path.join(tmpCwd, "nope.sock.ref");
    await expect(readSocketRef(refPath)).rejects.toThrow(/No verifier socket breadcrumb/);
  });
});

describe("cleanup", () => {
  let tmpCwd: string;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "vfy-cleanup-"));
  });
  afterEach(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("unlinks both socket and ref files that exist", async () => {
    const sockPath = path.join(tmpCwd, "s.sock");
    const refPath = path.join(tmpCwd, "s.sock.ref");
    fs.writeFileSync(sockPath, "");
    fs.writeFileSync(refPath, "");
    await cleanup(sockPath, refPath);
    expect(fs.existsSync(sockPath)).toBe(false);
    expect(fs.existsSync(refPath)).toBe(false);
  });

  it("swallows ENOENT (safe to call when nothing was created)", async () => {
    await expect(
      cleanup(path.join(tmpCwd, "missing.sock"), path.join(tmpCwd, "missing.ref")),
    ).resolves.toBeUndefined();
  });
});
