/**
 * Wrapper for the bm_* exploration tool handlers.
 *
 * Its key contract: when the wrapped fn() throws, return an MCP result with
 * `isError: true` and the message — WITHOUT propagating the exception, so a single tool
 * failure (a bad selector, a timeout) never crashes the whole MCP server. On success it
 * serializes the result to pretty JSON. Kept in its own module so it's unit-testable
 * (it wraps every bm_* tool, so this guarantee matters).
 */

export interface TextResult {
  // Index signature required to satisfy the MCP SDK's CallToolResult shape.
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function bmHandler<T>(fn: () => Promise<T>): () => Promise<TextResult> {
  return async () => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await fn(), null, 2) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `browser error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  };
}
