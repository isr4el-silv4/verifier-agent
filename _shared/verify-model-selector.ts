/**
 * Version-compatible model selector for the /verify wizard.
 *
 * Uses only the stable `ctx.modelRegistry.getAvailable()` API (a compat facade
 * present in pi-coding-agent 0.80.x through 0.82.x) and TUI primitives from
 * pi-tui. Unlike Pi's internal `ModelSelectorComponent` (which changed its
 * constructor from `ModelRegistry` → `ModelRuntime` between 0.80 and 0.82),
 * this selector works across all versions without modification.
 *
 * Behaviour:
 *   - Default scope = "scoped" (user's curated model list).
 *   - Typing narrows the visible list via fuzzy matching.
 *   - Pressing Tab toggles between "scoped" and "all" views.
 *   - Up / Down arrows navigate; Enter selects; Escape cancels.
 */

import type { Model } from "@earendil-works/pi-ai";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  getKeybindings,
  Input,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";

interface ModelItem {
  provider: string;
  id: string;
  model: Model<any>;
}

function searchText(item: ModelItem): string {
  const { id, provider } = item;
  const name = item.model?.name ? ` ${item.model.name}` : "";
  return `${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

/**
 * ANSI helper for foreground styling.
 * Uses simple 256-colour codes that work everywhere without needing a Theme.
 */
const c = {
  accent: (s: string) => `\x1b[38;5;75m${s}\x1b[0m`,
  muted: (s: string) => `\x1b[38;5;245m${s}\x1b[0m`,
  success: (s: string) => `\x1b[38;5;78m${s}\x1b[0m`,
  text: (s: string) => `\x1b[38;5;252m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export interface VerifyModelSelectorOptions {
  tui: TUI;
  allModels: ModelItem[];
  scopedModelItems: ModelItem[];
  currentModel?: Model<any>;
  onSelect: (model: Model<any>) => void;
  onCancel: () => void;
}

const MAX_VISIBLE = 10;

export class VerifyModelSelector extends Container implements Focusable {
  private _focused = true;
  get focused(): boolean { return this._focused; }
  set focused(v: boolean) {
    this._focused = v;
    this.searchInput.focused = v;
  }

  private tui: TUI;
  private searchInput: Input;
  private listContainer: Container;
  private scopeLabel: Text;
  private allModels: ModelItem[];
  private scopedModelItems: ModelItem[];
  private scope: "scoped" | "all";
  private activeModels: ModelItem[];
  private filteredModels: ModelItem[];
  private selectedIndex = 0;
  private currentModel?: Model<any>;
  private opts: VerifyModelSelectorOptions;

  constructor(opts: VerifyModelSelectorOptions) {
    super();
    this.opts = opts;
    this.tui = opts.tui;
    this.allModels = opts.allModels;
    this.scopedModelItems = opts.scopedModelItems;
    this.currentModel = opts.currentModel;

    // Start in "scoped" if any exist, otherwise "all".
    this.scope = this.scopedModelItems.length > 0 ? "scoped" : "all";
    this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
    this.filteredModels = this.activeModels;

    // ── Layout ──────────────────────────────────────────────────────────
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));

    // Scope toggle label + hint
    this.scopeLabel = new Text(this.renderScopeLine(), 0, 0);
    this.addChild(this.scopeLabel);
    this.addChild(new Spacer(1));

    // Search input
    this.searchInput = new Input();
    this.searchInput.onSubmit = () => {
      const item = this.filteredModels[this.selectedIndex];
      if (item) this.opts.onSelect(item.model);
    };
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    // Scrollable list
    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    // Footer keybind hints
    this.addChild(new Text(
      rawKeyHint("↑↓", "navigate") + "  " +
      keyHint("tui.input.tab", "scope") + "  " +
      keyHint("tui.select.confirm", "select") + "  " +
      keyHint("tui.select.cancel", "cancel"),
      1, 0,
    ));

    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());

    this.updateList();
  }

  private renderScopeLine(): string {
    const allText = this.scope === "all" ? c.accent("all") : c.muted("all");
    const scopedText = this.scope === "scoped" ? c.accent("scoped") : c.muted("scoped");
    const hint = keyHint("tui.input.tab", "scope") + c.muted(" (all/scoped)");
    return `${c.muted("Scope: ")}${allText}${c.muted(" | ")}${scopedText}  ${hint}`;
  }

  private setScope(scope: "scoped" | "all"): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.activeModels = scope === "scoped" ? this.scopedModelItems : this.allModels;
    this.selectedIndex = 0;
    this.filterModels(this.searchInput.getValue());
    this.scopeLabel.setText(this.renderScopeLine());
  }

  private filterModels(query: string): void {
    this.filteredModels = query
      ? fuzzyFilter(this.activeModels, query, (item) => searchText(item))
      : this.activeModels;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
    this.updateList();
  }

  /**
   * Check if a model is the "current" one.
   * Uses a lightweight comparison since Model objects may differ between
   * registry refreshes.
   */
  private isCurrent(item: ModelItem): boolean {
    const cur = this.currentModel;
    if (!cur) return false;
    return cur.provider === item.provider && cur.id === item.id;
  }

  private updateList(): void {
    this.listContainer.clear();
    if (this.filteredModels.length === 0) {
      this.listContainer.addChild(new Text(c.muted("  No matching models"), 0, 0));
      return;
    }

    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2),
        this.filteredModels.length - MAX_VISIBLE),
    );
    const end = Math.min(start + MAX_VISIBLE, this.filteredModels.length);

    for (let i = start; i < end; i++) {
      const item = this.filteredModels[i];
      if (!item) continue;
      const isSelected = i === this.selectedIndex;
      const isCurrent = this.isCurrent(item);
      const providerBadge = c.muted(`[${item.provider}]`);
      const checkmark = isCurrent ? c.success(" ✓") : "";

      const line = isSelected
        ? c.accent("→ ") + c.accent(c.bold(item.id)) + ` ${providerBadge}${checkmark}`
        : `  ${c.text(item.id)} ${providerBadge}${checkmark}`;
      this.listContainer.addChild(new Text(line, 0, 0));
    }

    if (start > 0 || end < this.filteredModels.length) {
      const scrollInfo = c.muted(`  (${this.selectedIndex + 1}/${this.filteredModels.length})`);
      this.listContainer.addChild(new Text(scrollInfo, 0, 0));
    }

    // Show the selected model's friendly name below the list
    const selected = this.filteredModels[this.selectedIndex];
    if (selected?.model?.name) {
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(new Text(c.muted(`  ${selected.model.name}`), 0, 0));
    }
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();

    if (kb.matches(keyData, "tui.input.tab")) {
      const next: "scoped" | "all" = this.scope === "scoped" ? "all" : "scoped";
      if (this.scopedModelItems.length > 0 || next === "all") {
        this.setScope(next);
      }
      return;
    }

    if (kb.matches(keyData, "tui.select.up")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex = this.selectedIndex === 0
        ? this.filteredModels.length - 1
        : this.selectedIndex - 1;
      this.updateList();
      return;
    }

    if (kb.matches(keyData, "tui.select.down")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1
        ? 0
        : this.selectedIndex + 1;
      this.updateList();
      return;
    }

    if (kb.matches(keyData, "tui.select.confirm")) {
      const item = this.filteredModels[this.selectedIndex];
      if (item) this.opts.onSelect(item.model);
      return;
    }

    if (kb.matches(keyData, "tui.select.cancel")) {
      this.opts.onCancel();
      return;
    }

    // Everything else goes to search input → re-filter
    this.searchInput.handleInput(keyData);
    this.filterModels(this.searchInput.getValue());
  }
}
