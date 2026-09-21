// Fudrouter Go API client
const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8011';

export interface Provider {
  id: string;
  name: string;
  description?: string;
  authModes?: string[];
}

export interface Connection {
  id: string;
  provider: string;
  authType: string;
  name: string;
  email?: string;
  priority: number;
  isActive: boolean;
  base_url?: string;
  hasApiKey?: boolean;
  createdAt?: string;
  updatedAt?: string;
  data?: Record<string, unknown>;
}

export interface UsageStats {
  totalRequests: number;
  ok: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  generatedAt: string;
}

export interface UsageRow {
  id: number;
  timestamp: string;
  provider: string;
  model: string;
  connectionId: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  status: string;
}

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  machineId?: string;
  isActive: boolean;
  createdAt?: string;
}

export interface Settings {
  requireLogin?: boolean;
  password?: string;
  hasPassword?: boolean;
  fallbackStrategy?: string;
  [key: string]: unknown;
}

export interface OAuthProvider {
  id: string;
  name: string;
  flow: string;
  refreshable: boolean;
}

export interface CatalogModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

class ApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.token = localStorage.getItem('fudrouter_token');
  }

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem('fudrouter_token', token);
    } else {
      localStorage.removeItem('fudrouter_token');
    }
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text}`);
    }

    return res.json();
  }

  // Health & Version
  health() {
    return this.request<{ ok: boolean; status: string; version: string }>('/api/health');
  }

  version() {
    return this.request<{ currentVersion: string; runtime: string }>('/api/version');
  }

  // Auth
  authStatus() {
    return this.request<{ requireLogin: boolean; authenticated: boolean; hasPassword: boolean; displayName: string }>('/api/auth/status');
  }

  login(password: string) {
    return this.request<{ ok: boolean; authenticated: boolean }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  }

  logout() {
    return this.request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  }

  init(password: string) {
    return this.request<{ ok: boolean }>('/api/init', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  }

  // Settings
  getSettings() {
    return this.request<Settings>('/api/settings');
  }

  patchSettings(patch: Record<string, unknown>) {
    return this.request<Settings>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  // API Keys
  listKeys() {
    return this.request<{ keys: ApiKey[] }>('/api/keys');
  }

  createKey(name: string) {
    return this.request<{ id: string; key: string; name: string }>('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  deleteKey(id: string) {
    return this.request<{ ok: boolean }>(`/api/keys/${id}`, { method: 'DELETE' });
  }

  // Connections
  listConnections() {
    return this.request<{ connections: Connection[]; count: number }>('/api/connections');
  }

  createConnection(conn: Partial<Connection>) {
    return this.request<{ id: string; connection: Connection }>('/api/connections', {
      method: 'POST',
      body: JSON.stringify(conn),
    });
  }

  updateConnection(id: string, conn: Partial<Connection>) {
    return this.request<{ connection: Connection }>(`/api/connections/${id}`, {
      method: 'PUT',
      body: JSON.stringify(conn),
    });
  }

  deleteConnection(id: string) {
    return this.request<{ ok: boolean }>(`/api/connections/${id}`, { method: 'DELETE' });
  }

  testConnection(id: string) {
    return this.request<{ status: string; message: string; http?: number }>(`/api/connections/${id}/test`, {
      method: 'POST',
    });
  }

  // Providers
  listProviders() {
    return this.request<{ providers: Provider[] }>('/api/providers');
  }

  getProvider(id: string) {
    return this.request<Provider>(`/api/providers/${id}`);
  }

  listProviderModels(id: string) {
    return this.request<{ models: CatalogModel[] }>(`/api/providers/${id}/models`);
  }

  // Models
  listModels() {
    return this.request<{ data: CatalogModel[] }>('/v1/models');
  }

  // Usage
  usageStats() {
    return this.request<UsageStats>('/api/usage/stats');
  }

  usageHistory(limit = 100) {
    return this.request<{ history: UsageRow[]; count: number }>(`/api/usage/history?limit=${limit}`);
  }

  // OAuth
  oauthProviders() {
    return this.request<{ providers: OAuthProvider[] }>('/api/oauth/providers');
  }

  oauthStart(provider: string, redirectUri?: string) {
    return this.request<{ ok: boolean; sessionId: string; authUrl: string; status: string }>(
      `/api/oauth/${provider}/start`,
      { method: 'POST', body: JSON.stringify({ redirectUri }) }
    );
  }

  oauthStatus(provider: string, sessionId: string) {
    return this.request<{ ok: boolean; status: string; result?: Record<string, unknown> }>(
      `/api/oauth/${provider}/status?sessionId=${sessionId}`
    );
  }

  oauthRefreshAll() {
    return this.request<{ ok: boolean; refreshed: number }>('/api/oauth/refresh', { method: 'POST' });
  }

  // Catalog sync
  catalogSync() {
    return this.request<{ ok: boolean; providers: number; models: number }>('/api/models/catalog-sync', {
      method: 'POST',
    });
  }

  // MITM
  mitmStatus() {
    return this.request<{ caPath: string; caExists: boolean; listening: Record<string, boolean> }>('/api/mitm/status');
  }

  // Tunnel
  tunnelStatus() {
    return this.request<{ enabled: boolean; hostname: string; target: string }>('/api/tunnel/status');
  }
}

export const api = new ApiClient(API_BASE);
