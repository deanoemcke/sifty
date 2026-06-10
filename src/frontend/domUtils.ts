export function getElement<T extends HTMLElement>(id: string): T {
  const elem = document.getElementById(id);
  if (!elem) throw new Error(`Element #${id} not found`);
  return elem as T;
}

export function requireChild<T extends Element>(parent: Element, selector: string): T {
  const el = parent.querySelector<T>(selector);
  if (!el) throw new Error(`Element "${selector}" not found`);
  return el;
}
