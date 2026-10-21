export type SessionResp = { user: { id: string; name: string; email: string; role?: string | null } | null };
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  if (!res.ok) throw new Error(path + ": " + res.status);
  const data: unknown = await res.json();
  // Boundary guard: the server is untyped .mjs, so a shape change must fail
  // loudly here instead of rendering "[object Object]" downstream.
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(path + ": unexpected response shape");
  }
  return data as T;
}
export function apiGet<T>(path: string): Promise<T> {
  return req<T>(path);
}
export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return req<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
export function getSession(): Promise<SessionResp> {
  return req<SessionResp>("/api/auth/get-session").catch(() => ({ user: null }));
}
