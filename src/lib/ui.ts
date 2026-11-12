// A hyperscript small enough to read in one sitting.
//
// No framework and no template strings holding markup: every value that reaches the page goes in
// as a text node, so a server's error message, a tool description or a resource title cannot bring
// markup with it. This page renders text from strangers by design, and it also renders a payment
// address, so the one thing it must never do is let one of those rewrite the other.

/** Anything `el` accepts as a child. Nested arrays are flattened; null, undefined and false render nothing. */
export type Child = Node | string | number | boolean | null | undefined | readonly Child[];

export interface Props {
  class?: string | undefined;
  style?: Partial<CSSStyleDeclaration> | undefined;
  dataset?: Record<string, string> | undefined;
  onClick?: ((event: MouseEvent) => void) | undefined;
  onInput?: ((event: Event) => void) | undefined;
  onChange?: ((event: Event) => void) | undefined;
  onFocus?: ((event: FocusEvent) => void) | undefined;
  onBlur?: ((event: FocusEvent) => void) | undefined;
  onKeydown?: ((event: KeyboardEvent) => void) | undefined;
  /** Any other attribute. `true` renders as a bare attribute; null, undefined and false omit it. */
  [attribute: string]: unknown;
}

function applyProps(node: Element, props: Props | null | undefined): void {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.setAttribute("class", String(value));
    else if (key === "style" && typeof value === "object" && node instanceof HTMLElement)
      Object.assign(node.style, value);
    else if (key === "dataset" && typeof value === "object" && node instanceof HTMLElement)
      Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
}

function append(node: Node, children: readonly Child[]): void {
  for (const child of children.flat(8) as Child[]) {
    if (child === null || child === undefined || child === false || child === true) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** An HTML element with its properties and children applied. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyProps(node, props);
  append(node, children);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An SVG element. It needs the SVG namespace: one made with createElement renders nothing. */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  applyProps(node, props);
  append(node, children);
  return node;
}

export function mount<T extends Element>(node: T, ...children: Child[]): T {
  node.replaceChildren();
  append(node, children);
  return node;
}

/** The element with this id, which the page shell is expected to provide. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`the page has no #${id}`);
  return node as T;
}

/**
 * debounce exists for one specific bug. An input that re-renders its own view on `change` fires
 * that render on BLUR, which is exactly when somebody is moving the pointer to a button: the
 * button they are aiming at is replaced between mousedown and click, and their first click does
 * nothing. Re-rendering while they type instead happens long before the pointer moves.
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms = 200): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Motion is applied at exactly one altitude: a change of screen.
 *
 * A view transition around every render would animate a debounced keystroke. So the page renders
 * synchronously, and only the two changes a person reads as "the screen changed" (a route, a step)
 * go through here. Reduced motion is honoured by not starting the transition at all.
 */
export function withViewTransition(update: () => void): void {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduced || typeof document.startViewTransition !== "function") {
    update();
    return;
  }
  // A second transition started before the first finished rejects the first one's promises with
  // "Transition was skipped" (an AbortError). That is the browser doing what it should when two
  // navigations overlap, not a fault, and an unhandled rejection is what the browser test harness
  // counts as a page error.
  const transition = document.startViewTransition(update);
  const ignore = () => {};
  transition.ready.catch(ignore);
  transition.finished.catch(ignore);
  transition.updateCallbackDone.catch(ignore);
}

export function tag(state: string, text?: Child): HTMLSpanElement {
  return el("span", { class: `tag ${state}` }, text ?? state);
}

export function card(title: Child | Child[] | null, ...body: Child[]): HTMLDivElement {
  const head =
    title === null
      ? null
      : el("div", { class: "cardhead" }, ...(Array.isArray(title) ? title : [el("span", { class: "h" }, title)]));
  return el("div", { class: "card" }, head, ...body);
}

export function note(kind: string, ...body: Child[]): HTMLDivElement {
  return el("div", { class: `note ${kind}` }, ...body);
}

export function pre(value: unknown): HTMLPreElement {
  return el("pre", {}, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export interface Step {
  label: string;
  state?: "done" | "on" | "";
}

/**
 * The rail across the top of the playground. It is the one place that says where in the handshake
 * you are, which matters because the difference between "signed" and "sent" is the difference
 * between safe and not.
 */
export function steps(list: readonly Step[]): HTMLDivElement {
  const out: Child[] = [];
  list.forEach((step, index) => {
    if (index) out.push(el("div", { class: "step-line" }));
    out.push(
      el(
        "div",
        { class: `step ${step.state ?? ""}` },
        el("div", { class: "bead" }, step.state === "done" ? "✓" : String(index + 1)),
        el("span", {}, step.label),
      ),
    );
  });
  return el("div", { class: "steps" }, ...out);
}

/**
 * What a button says while it is doing the thing. A button that keeps its old label after a press
 * is a button somebody presses again, and on this page the second press is a second payment
 * request. The spinner disappears under prefers-reduced-motion, where the label does the work.
 */
export function busyLabel(text: string): Child[] {
  return [el("span", { class: "spinner", "aria-hidden": "true" }), el("span", {}, text)];
}
