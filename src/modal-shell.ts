/**
 * Reusable overlay shell: mounting, framing, sizing, windowing, and
 * scrolling for the extension's modals. Consumers describe a modal as a
 * `FrameSpec` (border + title rows + body hook + footer rows) plus an input
 * hook; this module owns everything terminal-shaped.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI
} from "@earendil-works/pi-tui";

/** A framed row: `null` renders as a full-strength ├─┤ rule, a string as content. */
export type FrameRow = string | null;

/** Default share of the terminal height a modal body targets. */
const DEFAULT_HEIGHT_RATIO = 0.7;
/** Fallback total height when the terminal reports no usable row count. */
const FALLBACK_BOX_ROWS = 14;

// The bordered box shared by the detail modal and the workflow confirm
// dialog: each row is truncated to the inner width; null draws a ├─┤ divider.
export function frameLines(border: (text: string) => string, width: number, rows: FrameRow[]): string[] {
  const innerWidth = Math.max(4, width - 4);
  const rule = (left: string, right: string) => border(`${left}${"─".repeat(width - 2)}${right}`);
  return [
    rule("╭", "╮"),
    ...rows.map((content) =>
      content === null
        ? rule("├", "┤")
        : `${border("│")} ${truncateToWidth(content, innerWidth, "…", true)} ${border("│")}`
    ),
    rule("╰", "╯")
  ];
}

/**
 * Title row with right-aligned metadata: `left` flush left, `right` flush
 * right, at least one space between (gap = max(1, inner - visible(left) -
 * visible(right))). `theme` is accepted for signature parity with the other
 * row builders; styling is the caller's job.
 */
export function headerRow(_theme: Theme, left: string, right: string, innerWidth: number): string {
  const gap = Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

/**
 * Scroll state for one body. Text mode follows the tail until a manual
 * scroll-up disarms it, then re-arms once the offset reaches the bottom
 * (JobDetail). Rows mode clamps, or keeps a supplied cursor row visible
 * (trail). Also records the last rendered body height and total so input
 * hooks can page without re-deriving the chrome math.
 */
export class Viewport {
  /** Offset used by the next render. */
  offset = 0;
  /** True while the body pins to the tail; disarmed by scrolling up. */
  private following = true;
  /** Body height of the last render. */
  bodyRows = 1;
  /** Total rows/lines of the last render. */
  total = 0;

  /** Scroll by `delta` lines. A negative delta disarms tail-following. */
  lineBy(delta: number, bodyRows: number, total: number): void {
    if (delta < 0) this.following = false;
    const maxScroll = Math.max(0, total - bodyRows);
    this.offset = Math.max(0, Math.min(this.offset + delta, maxScroll));
  }

  /** Scroll by `pages` body-heights. A negative value disarms tail-following. */
  pageBy(pages: number, bodyRows: number, total: number): void {
    if (pages < 0) this.following = false;
    const maxScroll = Math.max(0, total - bodyRows);
    this.offset = Math.max(0, Math.min(this.offset + pages * Math.max(1, bodyRows), maxScroll));
  }

  /** Clamp `offset` so `row` sits inside the body window. */
  keepRowVisible(row: number, bodyRows: number, total: number): void {
    const maxScroll = Math.max(0, total - bodyRows);
    const clamped = Math.max(0, Math.min(this.offset, maxScroll));
    if (row < clamped) this.offset = row;
    else if (row >= clamped + bodyRows) this.offset = row - bodyRows + 1;
    else this.offset = clamped;
  }

  /**
   * Resolve the offset for a text body of `lineCount` wrapped lines: follow
   * pins to the last page, otherwise clamp and re-arm once at the bottom.
   */
  resolveText(lineCount: number, bodyRows: number): number {
    this.bodyRows = Math.max(0, bodyRows);
    this.total = lineCount;
    const maxScroll = Math.max(0, lineCount - bodyRows);
    if (this.following) {
      this.offset = maxScroll;
    } else {
      this.offset = Math.min(this.offset, maxScroll);
      if (this.offset >= maxScroll) this.following = true;
    }
    return this.offset;
  }

  /**
   * Window `rows` to the current body height. `cursorRow` keeps a cursor in
   * view; `fill` pads a short window to `bodyRows` with blank rows.
   */
  window(rows: FrameRow[], bodyRows: number, opts?: { fill?: boolean; cursorRow?: number }): FrameRow[] {
    this.bodyRows = Math.max(0, bodyRows);
    this.total = rows.length;
    if (opts?.cursorRow !== undefined && opts.cursorRow >= 0) {
      this.keepRowVisible(opts.cursorRow, bodyRows, rows.length);
    }
    const maxScroll = Math.max(0, rows.length - bodyRows);
    this.offset = Math.max(0, Math.min(this.offset, maxScroll));
    const visible = rows.slice(this.offset, this.offset + bodyRows);
    if (opts?.fill) {
      while (visible.length < bodyRows) visible.push("");
    }
    return visible;
  }
}

export type BodyCtx = { theme: Theme; innerWidth: number; bodyRows: number };
export type BodyResult =
  | { text: string } // helper wraps to innerWidth, then windows
  | { rows: FrameRow[]; cursorRow?: number }; // pre-laid-out rows, helper windows

export type FrameSpec = {
  border: (theme: Theme) => (text: string) => string;
  /** Title rows, including the trailing ├─┤ divider (a `null` row). */
  titleRows: (ctx: { theme: Theme; innerWidth: number }) => FrameRow[];
  body: (ctx: BodyCtx) => BodyResult;
  /** Footer rows, including the leading divider/spacer and the hint. */
  footerRows: (ctx: { theme: Theme; innerWidth: number }) => FrameRow[];
  /** Share of terminal height; also feeds the overlay's maxHeight. */
  heightRatio?: number;
  /** Pad a short body window to the full body height (JobDetail). */
  fillBody?: boolean;
  /** Reserve 2 rows and splice "↑ N more"/"↓ N more" when the body overflows. */
  indicators?: boolean;
};

/**
 * Pure render: title → windowed body → footer → frame. Body height is
 * derived from the terminal rows, the two border rows, and the title/footer
 * row counts (minus 2 more while reserving indicator rows).
 */
export function renderFrame(
  spec: FrameSpec,
  env: { theme: Theme; tui: TUI; viewport: Viewport; width: number }
): string[] {
  const { theme, tui, viewport, width } = env;
  const border = spec.border(theme);
  const innerWidth = Math.max(4, width - 4);
  const titleRows = spec.titleRows({ theme, innerWidth });
  const footerRows = spec.footerRows({ theme, innerWidth });
  const ratio = spec.heightRatio ?? DEFAULT_HEIGHT_RATIO;

  const tuiRows = tui?.terminal?.rows;
  const totalRows =
    typeof tuiRows === "number" && Number.isFinite(tuiRows) && tuiRows > 0
      ? Math.max(1, Math.floor(tuiRows * ratio))
      : FALLBACK_BOX_ROWS;
  const room = Math.max(0, totalRows - 2 - titleRows.length - footerRows.length);

  const result = spec.body({ theme, innerWidth, bodyRows: room });

  let body: FrameRow[];
  if ("text" in result) {
    const lines = wrapTextWithAnsi(result.text, innerWidth);
    const offset = viewport.resolveText(lines.length, room);
    body = lines.slice(offset, offset + room);
    if (spec.fillBody) {
      while (body.length < room) body.push("");
    }
  } else {
    const rows = result.rows;
    const overflow = spec.indicators === true && rows.length > room;
    const bodyRows = overflow ? Math.max(1, room - 2) : room;
    const visible = viewport.window(rows, bodyRows, { fill: spec.fillBody, cursorRow: result.cursorRow });
    if (overflow) {
      const offset = viewport.offset;
      const up = offset > 0 ? theme.fg("muted", `↑ ${offset} more`) : "";
      const remaining = rows.length - offset - bodyRows;
      const down = remaining > 0 ? theme.fg("muted", `↓ ${remaining} more`) : "";
      body = [up, ...visible, down];
    } else {
      body = visible;
    }
  }

  // titleRows carries its trailing divider and footerRows its leading one,
  // so no extra null here — one was double-ruled under the header and
  // over-counted chrome by a line against the room formula above.
  return frameLines(border, width, [...titleRows, ...body, ...footerRows]);
}

export type ModalApi = { viewport: Viewport; requestRender: () => void; done: (r?: any) => void };
/** Return true when the hook handled the input; false falls through to defaults. */
export type InputHook = (data: string, api: ModalApi) => boolean;

/** JobDetail's input map: shift/pg page, up/down line, esc/ctrl+c/q close. */
export const jobDetailScrollKeys: InputHook = (data, api) => {
  const viewport = api.viewport;
  if (matchesKey(data, "shift+up")) {
    viewport.pageBy(-1, viewport.bodyRows, viewport.total);
    api.requestRender();
    return true;
  }
  if (matchesKey(data, "shift+down")) {
    viewport.pageBy(1, viewport.bodyRows, viewport.total);
    api.requestRender();
    return true;
  }
  if (matchesKey(data, "up")) {
    viewport.lineBy(-1, viewport.bodyRows, viewport.total);
    api.requestRender();
    return true;
  }
  if (matchesKey(data, "down")) {
    viewport.lineBy(1, viewport.bodyRows, viewport.total);
    api.requestRender();
    return true;
  }
  if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
    api.done(undefined);
    return true;
  }
  return false;
};

/**
 * Generic custom component: renders through `renderFrame`; input goes to the
 * supplied hook first, then the built-in default (esc close + line/page
 * scroll). The viewport is fetched per call so the owner can swap it when the
 * active body changes.
 */
export class ModalShell<S> implements Component {
  private readonly api: ModalApi;

  constructor(
    private readonly opts: {
      theme: Theme;
      tui: TUI;
      spec: FrameSpec;
      viewport: () => Viewport;
      input?: InputHook;
      done: (r?: S) => void;
    }
  ) {
    this.api = {
      get viewport(): Viewport {
        return opts.viewport();
      },
      requestRender: () => opts.tui.requestRender(),
      done: (r?: any) => opts.done(r as S)
    };
  }

  invalidate(): void {
    // No cached rendering state — render() always reads live state.
  }

  render(width: number): string[] {
    return renderFrame(this.opts.spec, {
      theme: this.opts.theme,
      tui: this.opts.tui,
      viewport: this.opts.viewport(),
      width
    });
  }

  handleInput(data: string): void {
    if (this.opts.input?.(data, this.api)) return;
    const viewport = this.opts.viewport();
    if (matchesKey(data, "up")) {
      viewport.lineBy(-1, viewport.bodyRows, viewport.total);
      this.opts.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      viewport.lineBy(1, viewport.bodyRows, viewport.total);
      this.opts.tui.requestRender();
      return;
    }
    if (matchesKey(data, "shift+up") || matchesKey(data, "pageUp")) {
      viewport.pageBy(-1, viewport.bodyRows, viewport.total);
      this.opts.tui.requestRender();
      return;
    }
    if (matchesKey(data, "shift+down") || matchesKey(data, "pageDown")) {
      viewport.pageBy(1, viewport.bodyRows, viewport.total);
      this.opts.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.opts.done();
    }
  }
}

/**
 * Mount a custom overlay. Single source for the ratio ↔ maxHeight pairing:
 * `heightRatio` drives both the render math (via `FrameSpec`) and the
 * overlay's `maxHeight` percentage. A stale/failed `ctx.ui.custom` resolves
 * to `fallback`; `finally` always runs.
 */
export async function openModal<T>(
  ctx: ExtensionContext,
  opts: {
    make: (tui: TUI, done: (r: T) => void) => Component;
    fallback: T;
    heightRatio?: number;
    width?: string;
    finally?: () => void;
  }
): Promise<T> {
  const ratio = opts.heightRatio ?? DEFAULT_HEIGHT_RATIO;
  const width = opts.width ?? "80%";
  try {
    return await ctx.ui.custom<T>(
      (tui, _theme, _keybindings, done) => opts.make(tui, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: width as `${number}%`, maxHeight: `${Math.round(ratio * 100)}%` as `${number}%` }
      }
    );
  } catch {
    return opts.fallback;
  } finally {
    opts.finally?.();
  }
}
