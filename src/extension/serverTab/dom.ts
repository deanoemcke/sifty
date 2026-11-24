// Tiny element builder. Content only ever goes in as textContent — the tab
// shows saved-search names and log lines, so nothing is parsed as markup.

type ElementOptions = {
  text?: string;
  className?: string;
  section?: string;
};

export function createElement<Tag extends keyof HTMLElementTagNameMap>(
  tagName: Tag,
  options: ElementOptions = {},
  children: Node[] = []
): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tagName);
  if (options.text !== undefined) element.textContent = options.text;
  if (options.className) element.className = options.className;
  if (options.section) element.dataset.section = options.section;
  for (const child of children) element.append(child);
  return element;
}
