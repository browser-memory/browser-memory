import type { Page, ConsoleMessage } from "playwright";

/**
 * Buffer of console messages from the explored pages. Equivalent to what playwright-mcp's
 * `browser_console_messages` gave, but captured by this server.
 *
 * Unlike the network (which is listened to at the CONTEXT level in [browser/netlog.ts]), the
 * "console" event is emitted by the PAGE, so it's attached per page: [browser/explore.ts]
 * wires it when wiring each tab (including new popups). It's cleared on `request`, along with
 * the network, when the learning episode is frozen into the trace.
 */

export interface ConsoleEntry {
  type: string;
  text: string;
  location?: string;
}

/** Cap to avoid growing without bound on chatty pages. */
const CAP = 1000;

let buffer: ConsoleEntry[] = [];

/** Wires the console recorder to a page (idempotent via a flag on the page itself). */
export function attachConsoleToPage(page: Page): void {
  const p = page as Page & { __bmConsoleWired?: boolean };
  if (p.__bmConsoleWired) return;
  p.__bmConsoleWired = true;
  page.on("console", (msg: ConsoleMessage) => {
    if (buffer.length >= CAP) return;
    const loc = msg.location();
    buffer.push({
      type: msg.type(),
      text: msg.text(),
      location: loc?.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : undefined,
    });
  });
}

/** Snapshot of the accumulated buffer. */
export function getConsoleLog(): ConsoleEntry[] {
  return buffer.slice();
}

/** Clears the buffer (called by `request` when freezing the trace). */
export function clearConsoleLog(): void {
  buffer = [];
}

/**
 * Chooses which console log to persist in the trace. Prefers the agent's only if it's a
 * non-empty array; otherwise falls back to the server-captured one. This avoids silently
 * dropping the server's capture when the agent passes `console: []` (a defined-but-empty
 * value would win over `??`), while still letting an agent override with real annotations.
 */
export function pickConsole(agentConsole: unknown, captured: ConsoleEntry[]): unknown {
  return Array.isArray(agentConsole) && agentConsole.length > 0 ? agentConsole : captured;
}
