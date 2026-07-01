// Manual mock for @earendil-works/pi-coding-agent

export type ExtensionAPI = any;
export type ExtensionContext = any;
export type ExtensionCommandContext = any;

export type InputEvent = { type: "input"; text: string; source: string };
export type InputEventResult = { action: "continue" | "handled" | "transform"; text?: string };
export type AgentEndEvent = { type: "agent_end"; messages: any[] };
export type SessionStartEvent = { type: "session_start"; reason: string };
export type SessionShutdownEvent = { type: "session_shutdown"; reason: string };

export class CustomEditor {
  [k: string]: any;
  constructor(..._args: any[]) {}
  render(width: number): string[] { return []; }
  handleInput(_data: string): void {}
}

/**
 * Faithful re-implementation of pi-coding-agent's parseFrontmatter for tests.
 * Mirrors the real one: normalizes newlines, splits on `---` delimiters, and
 * parses the YAML block with simple-scalar type coercion (numbers / booleans /
 * strings) — exactly how the `yaml` package parses the verifier.yaml scalars.
 */
type ParsedFrontmatter<T extends Record<string, unknown>> = {
  frontmatter: T;
  body: string;
};

function coerceScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  // integer
  if (/^-?\d+$/.test(v)) return Number(v);
  // float
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  // quoted string
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const valueRaw = line.slice(colonIndex + 1);
    out[key] = coerceScalar(valueRaw);
  }
  return out;
}

export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
): ParsedFrontmatter<T> => {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter: {} as T, body: normalized };
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter: {} as T, body: normalized };
  }
  const yamlString = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();
  return { frontmatter: parseSimpleYaml(yamlString) as T, body };
};

export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;
