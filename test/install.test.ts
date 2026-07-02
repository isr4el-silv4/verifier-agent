import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installVerifierPersona } from "../_shared/install";

describe("installVerifierPersona", () => {
  const personasDir = path.join(os.homedir(), ".pi", "agent", "personas");
  const personaPath = path.join(personasDir, "verifier.yaml");

  // Track whether we need to restore the original file
  let originalContent: string | null = null;
  let fileExistedBefore: boolean;

  beforeEach(() => {
    fileExistedBefore = fs.existsSync(personaPath);
    if (fileExistedBefore) {
      originalContent = fs.readFileSync(personaPath, "utf8");
    }
  });

  afterEach(() => {
    // Restore original state
    if (fileExistedBefore && originalContent !== null) {
      fs.writeFileSync(personaPath, originalContent, "utf8");
    } else if (!fileExistedBefore) {
      try {
        fs.unlinkSync(personaPath);
      } catch {
        // ignore
      }
    }
  });

  it("creates the personas directory and installs the file", async () => {
    // Remove the file if it exists to test fresh install
    if (fs.existsSync(personaPath)) {
      fs.unlinkSync(personaPath);
    }

    const result = await installVerifierPersona();
    expect(result).toBe(personaPath);
    expect(fs.existsSync(personaPath)).toBe(true);

    const content = fs.readFileSync(personaPath, "utf8");
    expect(content).toContain("name: verifier");
    expect(content).toContain("systemPromptMode: replace");
    expect(content).toContain("<BUILDER_SESSION_ID>");
  });

  it("is idempotent — skips write when content is identical", async () => {
    // Install once
    await installVerifierPersona();
    const stat1 = fs.statSync(personaPath);

    // Small delay to ensure mtime would differ if rewritten
    await new Promise((r) => setTimeout(r, 10));

    // Install again — should detect identical content and skip
    await installVerifierPersona();
    const stat2 = fs.statSync(personaPath);

    // mtime should be unchanged (within 2s tolerance for filesystem granularity)
    expect(Math.abs(stat2.mtimeMs - stat1.mtimeMs)).toBeLessThan(2000);
  });

  it("overwrites when content differs", async () => {
    // Write a stale version
    fs.writeFileSync(personaPath, "---\nname: stale\n---\nstale body\n", "utf8");
    const statBefore = fs.statSync(personaPath);
    const oldContent = fs.readFileSync(personaPath, "utf8");
    expect(oldContent).toContain("stale");

    await new Promise((r) => setTimeout(r, 10));

    // Install — should detect different content and overwrite
    await installVerifierPersona();
    const statAfter = fs.statSync(personaPath);
    const newContent = fs.readFileSync(personaPath, "utf8");

    expect(newContent).toContain("name: verifier");
    expect(newContent).not.toContain("stale");
    // mtime should have changed
    expect(statAfter.mtimeMs).toBeGreaterThan(statBefore.mtimeMs);
  });

  it("returns the installed path", async () => {
    const result = await installVerifierPersona();
    expect(result).toBe(path.join(os.homedir(), ".pi", "agent", "personas", "verifier.yaml"));
  });
});
