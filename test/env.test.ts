import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadDotEnv } from "../_shared/env";

/**
 * loadDotEnv is a thin wrapper around Node's `process.loadEnvFile`.
 *
 * NOTE on scope: jest's test environment neutralizes `process.loadEnvFile`
 * (it becomes a no-op — never sets env vars, never throws), so the
 * env-mutation and parse-error paths cannot be observed here. Those are
 * Node's responsibility, exercised by real `pi` subprocesses in the
 * integration checklist. These tests cover what the WRAPPER itself owns:
 * the existence/access check and the return-shape contract.
 */
describe("loadDotEnv", () => {
  let tmpCwd: string;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "vfy-env-"));
  });
  afterEach(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("returns loaded:false with a reason when no .env exists in cwd", async () => {
    const res = await loadDotEnv(tmpCwd);
    expect(res.loaded).toBe(false);
    expect(res.reason).toBe("no .env in cwd");
    expect(res.path).toBe(path.join(tmpCwd, ".env"));
  });

  it("returns loaded:true when a .env file is present", async () => {
    fs.writeFileSync(path.join(tmpCwd, ".env"), "EXAMPLE_KEY=example-value\n");
    const res = await loadDotEnv(tmpCwd);
    expect(res.loaded).toBe(true);
    expect(res.path).toBe(path.join(tmpCwd, ".env"));
    expect(res.reason).toBeUndefined();
  });
});
