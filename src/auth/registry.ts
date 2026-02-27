import type { AuthAdapter } from '../types/auth';

const adapters = new Map<string, AuthAdapter>();

export function registerAdapter(adapter: AuthAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getAdapter(name: string): AuthAdapter | undefined {
  return adapters.get(name);
}

export function listAdapters(): string[] {
  return Array.from(adapters.keys());
}
