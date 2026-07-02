/**
 * Installation logic for the verifier persona file.
 *
 * When the extension is installed via `pi install npm:@package-name`, the
 * persona YAML must be placed at `~/.pi/agent/personas/verifier.yaml` so
 * the launcher and builder-side code can find it at runtime.
 *
 * This module copies the bundled `verifier.yaml` (shipped alongside the
 * extension source) to the global personas directory. It is idempotent:
 * if the file already exists with identical content, no write occurs.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Resolved at module-load time: `__dirname` is `_shared/`, so the persona
// sits one level up at `<extensionRoot>/verifier.yaml`.
const bundledPersonaPath = path.join(__dirname, "..", "verifier.yaml");

const PERSONAS_DIR = path.join(os.homedir(), ".pi", "agent", "personas");
const INSTALLED_PATH = path.join(PERSONAS_DIR, "verifier.yaml");

/**
 * Ensure the verifier persona is installed at the global path.
 *
 * @returns The absolute path to the installed persona (always `INSTALLED_PATH`).
 *          Throws if the bundled source is missing or the write fails.
 */
export async function installVerifierPersona(): Promise<string> {
  // Read the bundled source
  let source: string;
  try {
    source = await fs.readFile(bundledPersonaPath, "utf8");
  } catch (err) {
    throw new Error(
      `verifier: bundled persona not found at ${bundledPersonaPath}. ` +
        `This should not happen — check the npm package contents. ` +
        `(${(err as Error).message})`,
    );
  }

  // Ensure target directory exists
  await fs.mkdir(PERSONAS_DIR, { recursive: true });

  // Skip write if identical content already in place
  try {
    const existing = await fs.readFile(INSTALLED_PATH, "utf8");
    if (existing === source) {
      return INSTALLED_PATH;
    }
  } catch {
    // File doesn't exist yet — fall through to write
  }

  // Write (or overwrite)
  await fs.writeFile(INSTALLED_PATH, source, { encoding: "utf8", mode: 0o644 });
  return INSTALLED_PATH;
}
