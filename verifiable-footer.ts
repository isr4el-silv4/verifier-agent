/**
 * Builder-side UI: input-bar border embedding.
 *
 * `BuilderInputEditor` (CustomEditor subclass) embeds context info directly
 * into the input box's border lines via `fitBorder`:
 *
 *   ──────────────────────────────────── ◌ verifier idle ──
 *     [cursor — your normal input]
 *   ── claude-sonnet-4-6 ────────────────────────── 12% ───
 *
 *   Top-right border:    verifier connection status
 *   Bottom-left border:  active model id
 *   Bottom-right border: ctx-window utilization
 *
 * Adapted from the original the-verifier-agent (imports updated to
 * @earendil-works/* packages).
 */

import {
  CustomEditor,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ─── Shared types ────────────────────────────────────────────────────────────

export type ConnectionPhase =
  | "idle"
  | "disconnected"
  | "spawning"
  | "connected"
  | "error";

export interface BuilderUIDeps {
  /** Current verifier-connection phase. Read on every render. */
  getPhase: () => ConnectionPhase;
  /** Builder session id (canonical, full uuid). Read on every render. */
  getSessionId: () => string;
}

/**
 * Safely read a property from a possibly-stale ctx. Pi marks captured ctx
 * stale across session-replacement boundaries. Render factories run when pi
 * decides to render — wrap each access and fall back.
 */
function safeCtx<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ─── Input-bar border embedding (CustomEditor subclass) ──────────────────────

/**
 * `fitBorder` — build a fresh border line with text embedded, sized to width.
 */
function fitBorder(
  left: string,
  right: string,
  width: number,
  border: (text: string) => string,
  fill: (text: string) => string = border,
): string {
  if (width <= 0) return "";
  if (width === 1) return border("─");
  let leftText = left;
  let rightText = right;
  const fixedWidth = 2;
  const minimumGap = 3;
  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(rightText) > 0
  ) {
    rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
  }
  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(leftText) > 0
  ) {
    leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
  }
  const gapWidth = Math.max(
    0,
    width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText),
  );
  return `${border("─")}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

/**
 * Builder's input-box editor with status text embedded in the border lines.
 */
export class BuilderInputEditor extends CustomEditor {
  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    private deps: BuilderUIDeps,
    private ctx: ExtensionContext,
  ) {
    super(tui, theme, keybindings, {});
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length < 2) return lines;

    const theme = safeCtx(() => this.ctx.ui.theme, null);
    if (!theme) return lines;
    const bc = (s: string) => this.borderColor(s);

    // ─── Top border: verifier connection status (top-right) ──────────────
    const phase = this.deps.getPhase();
    const glyph =
      phase === "connected"
        ? "●"
        : phase === "spawning"
          ? "◌"
          : phase === "error"
            ? "⚠"
            : phase === "disconnected"
              ? "✗"
              : "◌"; // idle
    const phaseFg =
      phase === "connected"
        ? "success"
        : phase === "error" || phase === "disconnected"
          ? "error"
          : "muted";
    const topRight = theme.fg(phaseFg, ` ${glyph} verifier ${phase} `);
    lines[0] = fitBorder("", topRight, width, bc);

    // ─── Bottom border: model (left) + ctx % (right) ─────────────────────
    const model = safeCtx(() => this.ctx.model?.id ?? "no-model", "no-model");
    const usage = safeCtx(() => this.ctx.getContextUsage?.(), undefined);
    const pct = usage && usage.percent !== null ? usage.percent : 0;
    const bottomLeft = theme.fg("dim", ` ${model} `);
    const bottomRight = theme.fg("dim", ` ${Math.round(pct)}% `);
    lines[lines.length - 1] = fitBorder(bottomLeft, bottomRight, width, bc);

    return lines;
  }
}
