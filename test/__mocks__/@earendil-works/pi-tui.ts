// Manual mock for @earendil-works/pi-tui
export interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

export function truncateToWidth(text: string, width: number, _placeholder = ""): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return text.slice(0, width - 1) + "…";
}

export function visibleWidth(text: string): number {
  // Strip ANSI escapes for width calc in tests.
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export class Text {
  constructor(public content: string = "", ..._args: any[]) {}
  render(_width: number): string[] { return [this.content]; }
  invalidate(): void {}
}

export class Container {
  private children: any[] = [];
  addChild(c: any): void { this.children.push(c); }
  render(width: number): string[] {
    const lines: string[] = [];
    for (const c of this.children) {
      if (typeof c.render === "function") lines.push(...c.render(width));
    }
    return lines;
  }
  invalidate(): void {}
}
