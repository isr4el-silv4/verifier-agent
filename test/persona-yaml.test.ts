import { describe, it, expect } from "@jest/globals";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseVerifierPersona, templateBody } from "../_shared/frontmatter";

describe("installed verifier.yaml persona", () => {
  const personaPath = path.join(os.homedir(), ".pi", "agent", "personas", "verifier.yaml");

  it("exists at the global personas path", () => {
    expect(fs.existsSync(personaPath)).toBe(true);
  });

  it("parses with the required pi-native fields and no model/domain", () => {
    const content = fs.readFileSync(personaPath, "utf-8");
    const { frontmatter, body } = parseVerifierPersona(content);
    expect(frontmatter.name).toBe("verifier");
    expect(frontmatter.systemPromptMode).toBe("replace");
    expect(frontmatter.inheritProjectContext).toBe(false);
    expect(frontmatter.interactive).toBe(false);
    expect(frontmatter.max_loops).toBe(3);
    expect(frontmatter.tools).toContain("verifier_prompt");
    expect(frontmatter).not.toHaveProperty("model");
    expect(frontmatter).not.toHaveProperty("domain");
    // body carries the template slots the launcher fills
    expect(body).toContain("<BUILDER_SESSION_ID>");
    expect(body).toContain("<BUILDER_SESSION_FILE>");
    expect(body).toContain("<MAX_LOOPS>");
    expect(body).toContain("<SOCKET_PATH>");
  });

  it("templates cleanly with the launcher's spawn-time vars (no DOMAIN slot)", () => {
    const { body } = parseVerifierPersona(fs.readFileSync(personaPath, "utf-8"));
    const rendered = templateBody(body, {
      BUILDER_SESSION_ID: "abc-123",
      BUILDER_SESSION_FILE: "/home/u/.pi/agent/sessions/abc-123.jsonl",
      MAX_LOOPS: "3",
      SOCKET_PATH: "/tmp/pi-verifier/abc-123.sock",
    });
    expect(rendered).toContain("session `abc-123`");
    expect(rendered).not.toContain("<BUILDER_SESSION_ID>");
    expect(rendered).not.toContain("<DOMAIN>");
  });
});
