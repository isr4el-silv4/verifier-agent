import { describe, it, expect } from "@jest/globals";
import { parseVerifierPersona, templateBody } from "../_shared/frontmatter";

const VALID = `---
name: verifier
description: Generic verifier
tools: read, grep, find, ls, bash, verifier_prompt
systemPromptMode: replace
inheritProjectContext: false
interactive: false
max_loops: 3
---

# Verifier

Session <BUILDER_SESSION_ID>, file <BUILDER_SESSION_FILE>.
Use up to <MAX_LOOPS> loops. Socket <SOCKET_PATH>.`;

describe("parseVerifierPersona", () => {
  it("parses a well-formed persona with all required + optional fields", () => {
    const { frontmatter, body } = parseVerifierPersona(VALID);
    expect(frontmatter.name).toBe("verifier");
    expect(frontmatter.description).toBe("Generic verifier");
    expect(frontmatter.tools).toBe("read, grep, find, ls, bash, verifier_prompt");
    expect(frontmatter.systemPromptMode).toBe("replace");
    expect(frontmatter.inheritProjectContext).toBe(false);
    expect(frontmatter.interactive).toBe(false);
    expect(frontmatter.max_loops).toBe(3);
    expect(body).toContain("# Verifier");
    expect(body).toContain("<BUILDER_SESSION_ID>");
  });

  it("coerces YAML booleans to real booleans (not strings)", () => {
    const { frontmatter } = parseVerifierPersona(VALID);
    expect(typeof frontmatter.inheritProjectContext).toBe("boolean");
    expect(typeof frontmatter.interactive).toBe("boolean");
  });

  it("does NOT require model or domain (dropped from the original format)", () => {
    // A persona without model/domain must parse cleanly.
    expect(() => parseVerifierPersona(VALID)).not.toThrow();
    expect(parseVerifierPersona(VALID).frontmatter).not.toHaveProperty("model");
    expect(parseVerifierPersona(VALID).frontmatter).not.toHaveProperty("domain");
  });

  it("treats max_loops as optional (absent → undefined)", () => {
    const noLoops = VALID.replace("max_loops: 3\n", "");
    const { frontmatter } = parseVerifierPersona(noLoops);
    expect(frontmatter.max_loops).toBeUndefined();
  });

  it.each([
    ["name", "name"],
    ["description", "description"],
    ["tools", "tools"],
    ["systemPromptMode", "systemPromptMode"],
  ])("throws a field-naming error when required string %s is missing", (key) => {
    const bad = VALID.replace(new RegExp(`^${key}:.*$`, "m"), "");
    expect(() => parseVerifierPersona(bad)).toThrow(
      new RegExp(`required field "${key}" is missing`),
    );
  });

  it.each(["inheritProjectContext", "interactive"])(
    "throws when required boolean %s is missing or not a boolean",
    (key) => {
      const bad = VALID.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: not-a-bool`);
      expect(() => parseVerifierPersona(bad)).toThrow(new RegExp(key));
    },
  );

  it("throws when max_loops is present but not a finite number", () => {
    const bad = VALID.replace("max_loops: 3", "max_loops: not-a-number");
    expect(() => parseVerifierPersona(bad)).toThrow(/max_loops/);
  });
});

describe("templateBody", () => {
  it("replaces <UPPER_SNAKE> placeholders with the provided values", () => {
    const out = templateBody("hi <NAME> @ <SOCKET_PATH>", {
      NAME: "verifier",
      SOCKET_PATH: "/tmp/x.sock",
    });
    expect(out).toBe("hi verifier @ /tmp/x.sock");
  });

  it("replaces all occurrences of a placeholder", () => {
    const out = templateBody("<X>-<X>-<X>", { X: "0" });
    expect(out).toBe("0-0-0");
  });

  it("leaves unknown placeholders untouched (two-stage templating)", () => {
    const out = templateBody("spawn <BUILDER_SESSION_ID>; verify turn <TURN_INDEX>", {
      BUILDER_SESSION_ID: "s-1",
    });
    expect(out).toBe("spawn s-1; verify turn <TURN_INDEX>");
  });

  it("throws when a var name is not UPPER_SNAKE_CASE", () => {
    expect(() => templateBody("x", { lowercase: "v" })).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => templateBody("x", { "WITH-DASH": "v" })).toThrow(/UPPER_SNAKE_CASE/);
  });
});
