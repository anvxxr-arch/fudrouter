export type CompareFrame = { model?: string; chunk?: string; error?: { message?: string } };

/**
 * Returns the attributed text delta for one compare frame, or null when the
 * frame carries no assistant text.
 *
 * Why the unwrap: the compare relay wraps every upstream SSE line verbatim,
 * so the delta sits one level down — frame.chunk still carries its own
 * `data:` prefix and the JSON body behind it. Reading `choices` off the
 * wrapper is the bug this function exists to prevent.
 */
export function compareChunk(payload: string): { model: string; delta: string } | null {
  let frame: CompareFrame;
  try {
    frame = JSON.parse(payload) as CompareFrame;
  } catch {
    return null;
  }
  if (frame === null || typeof frame !== "object") return null;
  const model = frame.model ?? "";
  if (!model) return null;
  const chunk = frame.chunk;
  if (typeof chunk !== "string") return null;
  const body = chunk.replace(/^data: ?/, "");
  if (body === "[DONE]") return null;
  let parsed: { choices?: { delta?: { content?: unknown } }[] };
  try {
    parsed = JSON.parse(body) as { choices?: { delta?: { content?: unknown } }[] };
  } catch {
    return null;
  }
  const delta = parsed?.choices?.[0]?.delta?.content;
  return typeof delta === "string" ? { model, delta } : null;
}
