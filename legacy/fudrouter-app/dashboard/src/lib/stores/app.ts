import { writable, derived } from 'svelte/store';
import { api, type Connection, type Provider, type UsageStats, type ApiKey, type Settings } from '../lib/api/client';

function createStore<T>(initial: T) {
  const { subscribe, set, update } = writable<T>(initial);
  return { subscribe, set, update };
}

export const providers = createStore<Provider[]>([]);
export const connections = createStore<Connection[]>([]);
export const usageStats = createStore<UsageStats | null>(null);
export const usageHistory = createStore<UsageRow[]>([]);
export const apiKeys = createStore<ApiKey[]>([]);
export const settings = createStore<Settings>({});
export const isAuthenticated = createStore(false);
export const isLoading = createStore(false);
export const error = createStore<string | null>(null);
export const activeProvider = createStore<string | null>(null);
export const activeView = createStore<'dashboard' | 'connections' | 'providers' | 'models' | 'settings' | 'logs' | 'keys' | 'combos'>('dashboard');

export async function loadProviders() {
  try {
    const res = await api.listProviders();
    providers.set(res.providers);
  } catch (e) {
    error.set(String(e));
  }
}

export async function loadConnections() {
  try {
    const res = await api.listConnections();
    connections.set(res.connections);
  } catch (e) {
    error.set(String(e));
  }
}

export async function loadUsageStats() {
  try {
    const res = await api.usageStats();
    usageStats.set(res);
  } catch (e) {
    error.set(String(e));
  }
}

export async function loadApiKeys() {
  try {
    const res = await api.listKeys();
    apiKeys.set(res.keys);
  } catch (e) {
    error.set(String(e));
  }
}

export async function loadSettings() {
  try {
    const res = await api.getSettings();
    settings.set(res);
  } catch (e) {
    error.set(String(e));
  }
}

export async function checkAuth() {
  try {
    const res = await api.authStatus();
    isAuthenticated.set(res.authenticated);
    return res.authenticated;
  } catch {
    isAuthenticated.set(false);
    return false;
  }
}

export async function login(password: string) {
  isLoading.set(true);
  error.set(null);
  try {
    await api.login(password);
    isAuthenticated.set(true);
    await loadAll();
    return true;
  } catch (e) {
    error.set(String(e));
    return false;
  } finally {
    isLoading.set(false);
  }
}

export async function logout() {
  await api.logout();
  isAuthenticated.set(false);
}

export async function loadAll() {
  isLoading.set(true);
  error.set(null);
  await Promise.all([
    loadProviders(),
    loadConnections(),
    loadUsageStats(),
    loadApiKeys(),
    loadSettings(),
  ]);
  isLoading.set(false);
}

export async function createConnection(conn: Partial<Connection>) {
  const res = await api.createConnection(conn);
  await loadConnections();
  return res;
}

export async function updateConnection(id: string, conn: Partial<Connection>) {
  const res = await api.updateConnection(id, conn);
  await loadConnections();
  return res;
}

export async function deleteConnection(id: string) {
  await api.deleteConnection(id);
  await loadConnections();
}

export async function testConnection(id: string) {
  return api.testConnection(id);
}

export async function createKey(name: string) {
  const res = await api.createKey(name);
  await loadApiKeys();
  return res;
}

export async function deleteKey(id: string) {
  await api.deleteKey(id);
  await loadApiKeys();
}

export async function refreshOAuth() {
  return api.oauthRefreshAll();
}

export async function syncCatalog() {
  return api.catalogSync();
}
