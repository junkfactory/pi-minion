import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { MinionConfig, MinionRequest } from "../src/adapters/types.js";

export function fakeConfig(overrides: Partial<MinionConfig> = {}): MinionConfig {
  return {
    allowedModels: ["sonnet", "opus"],
    blockedModels: [],
    allowedTools: [],
    maxBudgetUsd: 5,
    timeoutMs: 900_000,
    ...overrides
  };
}

export function fakeRequest(overrides: Partial<MinionRequest> = {}): MinionRequest {
  return {
    task: "Explore the repo",
    workspace: "/tmp/workspace",
    model: "sonnet",
    effort: "medium",
    ...overrides
  };
}

// Stub for the pi adapter's modelRegistry hook (setModelRegistry): ownsModel
// routes against these Model-like rows — { id, provider } is all its matcher
// reads.
export function fakeModelRegistry(
  models: Array<{ id: string; provider: string }>
): ModelRegistry {
  return { getAvailable: () => models } as unknown as ModelRegistry;
}

// Minimal stand-ins for Pi's real Theme/TUI/ExtensionContext — only the
// surface agent.ui.ts actually touches. Kept intentionally dumb (fg/bold are
// no-ops) so assertions read the plain text a real theme would only color.
export function fakeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    getThinkingBorderColor: (_level: string) => (text: string) => text
  };
}

export function fakeTui(rows = 40) {
  return {
    requestRender: () => {},
    terminal: { rows, columns: 100 }
  };
}

export type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[] };

export function fakeCtx(
  theme: ReturnType<typeof fakeTheme> = fakeTheme(),
  options: { sessionId?: string; cwd?: string; confirmReturn?: boolean } = {}
) {
  const sessionId = options.sessionId ?? "test-session";
  const cwd = options.cwd ?? "/tmp/workspace";
  const state = {
    widgetFactory: undefined as WidgetFactory | undefined,
    widgetRemoved: false,
    notifications: [] as Array<{ msg: string; type?: string }>,
    customFactory: undefined as
      | ((tui: unknown, theme: unknown, keybindings: unknown, done: (r: unknown) => void) => unknown)
      | undefined,
    selectReturn: undefined as string | undefined,
    selectOptions: undefined as string[] | undefined,
    confirmCalls: [] as Array<{ title: string; body: string }>,
    confirmReturn: options.confirmReturn ?? true,
    // Resolves the pending ctx.ui.custom promise — tests close overlays
    // (e.g. the trail browser) by invoking the `done` callback they
    // captured from the factory, which calls this with undefined.
    customResolve: undefined as ((result?: unknown) => void) | undefined
  };
  const ctx = {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined
    },
    ui: {
      get theme() {
        return theme;
      },
      setWidget: (_key: string, content: WidgetFactory | undefined) => {
        if (content === undefined) {
          state.widgetRemoved = true;
          state.widgetFactory = undefined;
        } else {
          state.widgetRemoved = false;
          state.widgetFactory = content;
        }
      },
      notify: (msg: string, type?: string) => state.notifications.push({ msg, type }),
      select: async (_title: string, options: string[]) => {
        state.selectOptions = options;
        return state.selectReturn;
      },
      confirm: async (title: string, body: string) => {
        state.confirmCalls.push({ title, body });
        return state.confirmReturn;
      },
      custom: (factory: typeof state.customFactory) => {
        state.customFactory = factory;
        return new Promise((resolve) => {
          // Stashed so tests can resolve it (e.g. by invoking the `done`
          // callback they passed into the factory). The trail browser
          // component captures `done` and calls it on Esc/q/ctrl+c; tests
          // capture it via state.killCustom() to drive the browser closed.
          state.customResolve = resolve;
        });
      }
    }
  };
  return { ctx, state };
}
