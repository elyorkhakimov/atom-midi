/** Minimal DOM helpers for the tool pages (no framework). */
export function $(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(el, rest);
  if (dataset) Object.assign(el.dataset, dataset);
  el.append(...children);
  return el;
}

export function pill(text: string, tone: 'ok' | 'warn' | 'bad' | '' = ''): HTMLSpanElement {
  return h('span', { className: `pill ${tone}`, textContent: text });
}

/** Append a line to a scrolling log, keeping at most `max` lines. */
export function appendLog(log: HTMLElement, line: string, max = 500): void {
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.append(line + '\n');
  while (log.childNodes.length > max) log.firstChild?.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

export function download(filename: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function deviceSummary(): string {
  return navigator.userAgent;
}
