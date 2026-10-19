type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | null | undefined>;

/** Мини-хелпер для DOM: h('button', { class: 'btn', onclick: fn }, 'Текст'). Свойства on* — обработчики событий. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Поле формы с подписью. */
export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field', title: hint ?? '' }, h('span', { class: 'field-label' }, label), input);
}

export function numberInput(value: number, onChange: (v: number) => void, opts: { min?: number; max?: number; step?: number } = {}): HTMLInputElement {
  const el = h('input', { type: 'number', value: String(value), min: opts.min, max: opts.max, step: opts.step ?? 1 }) as HTMLInputElement;
  el.addEventListener('change', () => {
    const n = Number(el.value);
    if (Number.isFinite(n)) onChange(n);
  });
  return el;
}

export function textInput(value: string, onChange: (v: string) => void, placeholder = ''): HTMLInputElement {
  const el = h('input', { type: 'text', value, placeholder }) as HTMLInputElement;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function checkbox(value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const el = h('input', { type: 'checkbox', checked: value }) as HTMLInputElement;
  el.addEventListener('change', () => onChange(el.checked));
  return el;
}

export function select(value: string, options: Array<[string, string]>, onChange: (v: string) => void): HTMLSelectElement {
  const el = h('select', {}) as HTMLSelectElement;
  for (const [v, label] of options) el.append(h('option', { value: v, selected: v === value }, label));
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}
