export type PaletteItem = { id: string; type: string; title: string; subtitle?: string; href: string };
export type ShellData = {
  workspaces: { id: string; name: string }[];
  workspaceId: string | null;
  projects: { id: string; name: string }[];
  projectId: string | null;
  environments: { id: string; name: string; slug: string }[];
  environmentId: string | null;
};
export type SessionResp = { user: { id: string; name: string; email: string; role?: string | null } | null };
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  if (!res.ok) throw new Error(path + ": " + res.status);
  return res.json() as Promise<T>;
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
export function apiAction<T>(path: string, action: string, form: Record<string, string> = {}): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return req<T>(path + "?/" + action, { method: "POST", body: fd });
}
export function getSession(): Promise<SessionResp> {
  return req<SessionResp>("/api/auth/get-session").catch(() => ({ user: null }));
}
