/** Versioned JSON in localStorage. Never throws: private mode or blocked storage falls back to defaults. */
export function load<T extends object>(key: string, defaults: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return structuredClone(defaults);
    return { ...structuredClone(defaults), ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return structuredClone(defaults);
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}
