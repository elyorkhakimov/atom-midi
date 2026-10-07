import { signal } from '@preact/signals';

export type Route =
  | { name: 'start' }
  | { name: 'setup' }
  | { name: 'menu' }
  | { name: 'settings' }
  | { name: 'calPads'; back: Route['name'] }
  | { name: 'calLatency'; back: Route['name'] }
  | { name: 'game'; id: string };

export const route = signal<Route>({ name: 'start' });

export function go(r: Route): void {
  route.value = r;
}
