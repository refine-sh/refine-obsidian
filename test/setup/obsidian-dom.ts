// Obsidian augments every window it opens with DOM helpers that jsdom does not
// provide. The plugin builds its interface through them, so the jsdom suites
// install the same surface before any source module runs.

interface ElementInfo {
  readonly cls?: string | string[];
  readonly text?: string | DocumentFragment;
  readonly attr?: Record<string, string | number | boolean | null>;
  readonly title?: string;
  readonly parent?: Node;
  readonly value?: string;
  readonly type?: string;
  readonly prepend?: boolean;
  readonly placeholder?: string;
  readonly href?: string;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export function installObsidianDom(target: Window & typeof globalThis): void {
  const nodePrototype = target.Node.prototype as Node & Record<string, unknown>;
  const elementPrototype = target.HTMLElement.prototype as HTMLElement &
    Record<string, unknown>;

  defineAccessor(nodePrototype, "doc", function doc(this: Node): Document {
    return this.ownerDocument ?? (this as unknown as Document);
  });
  defineAccessor(nodePrototype, "win", function win(this: Node): Window {
    return (this.ownerDocument ?? (this as unknown as Document)).defaultView ?? target;
  });

  define(nodePrototype, "createEl", function createEl(
    this: Node,
    tag: string,
    info?: ElementInfo | string,
    callback?: (element: HTMLElement) => void,
  ): HTMLElement {
    return build(documentOf(this), tag, info, callback, this) as HTMLElement;
  });
  define(nodePrototype, "createDiv", function createDiv(
    this: Node,
    info?: ElementInfo | string,
    callback?: (element: HTMLElement) => void,
  ): HTMLElement {
    return build(documentOf(this), "div", info, callback, this) as HTMLElement;
  });
  define(nodePrototype, "createSpan", function createSpan(
    this: Node,
    info?: ElementInfo | string,
    callback?: (element: HTMLElement) => void,
  ): HTMLElement {
    return build(documentOf(this), "span", info, callback, this) as HTMLElement;
  });
  define(nodePrototype, "createSvg", function createSvg(
    this: Node,
    tag: string,
    info?: ElementInfo | string,
    callback?: (element: SVGElement) => void,
  ): SVGElement {
    return build(documentOf(this), tag, info, callback, this, SVG_NAMESPACE) as SVGElement;
  });

  define(elementPrototype, "setCssProps", function setCssProps(
    this: HTMLElement,
    props: Record<string, string>,
  ): void {
    for (const [property, value] of Object.entries(props)) {
      this.style.setProperty(property, value);
    }
  });
  define(elementPrototype, "setCssStyles", function setCssStyles(
    this: HTMLElement,
    styles: Partial<CSSStyleDeclaration>,
  ): void {
    Object.assign(this.style, styles);
  });

  const globals = target as unknown as Record<string, unknown>;
  globals["createEl"] = (
    tag: string,
    info?: ElementInfo | string,
    callback?: (element: HTMLElement) => void,
  ): HTMLElement => build(target.document, tag, info, callback) as HTMLElement;
  globals["createDiv"] = (
    info?: ElementInfo | string,
    callback?: (element: HTMLElement) => void,
  ): HTMLElement => build(target.document, "div", info, callback) as HTMLElement;
  globals["createSpan"] = (
    info?: ElementInfo | string,
    callback?: (element: HTMLElement) => void,
  ): HTMLElement => build(target.document, "span", info, callback) as HTMLElement;
  globals["createFragment"] = (
    callback?: (fragment: DocumentFragment) => void,
  ): DocumentFragment => {
    const fragment = target.document.createDocumentFragment();
    callback?.(fragment);
    return fragment;
  };
}

function build(
  ownerDocument: Document,
  tag: string,
  info: ElementInfo | string | undefined,
  callback: ((element: never) => void) | undefined,
  host?: Node,
  namespace?: string,
): Element {
  const element = namespace === undefined
    ? ownerDocument.createElement(tag)
    : ownerDocument.createElementNS(namespace, tag);
  const options: ElementInfo = typeof info === "string" ? { cls: info } : info ?? {};

  if (options.cls !== undefined) {
    const classes = Array.isArray(options.cls) ? options.cls : options.cls.split(" ");
    element.classList.add(...classes.filter((entry) => entry.length > 0));
  }
  if (options.text !== undefined) {
    if (typeof options.text === "string") {
      element.textContent = options.text;
    } else {
      element.appendChild(options.text);
    }
  }
  for (const [name, value] of Object.entries(options.attr ?? {})) {
    if (value === null) {
      element.removeAttribute(name);
    } else {
      element.setAttribute(name, String(value));
    }
  }
  if (options.title !== undefined) {
    element.setAttribute("title", options.title);
  }
  for (const property of ["value", "type", "placeholder", "href"] as const) {
    if (options[property] !== undefined) {
      (element as unknown as Record<string, string>)[property] = options[property];
    }
  }

  const parent = options.parent ?? host;
  if (parent) {
    if (options.prepend === true) {
      parent.insertBefore(element, parent.firstChild);
    } else {
      parent.appendChild(element);
    }
  }
  callback?.(element as never);
  return element;
}

function documentOf(node: Node): Document {
  return node.ownerDocument ?? (node as unknown as Document);
}

function define(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    enumerable: false,
    value,
  });
}

function defineAccessor(target: object, name: string, get: () => unknown): void {
  Object.defineProperty(target, name, { configurable: true, enumerable: false, get });
}

if (typeof window !== "undefined") {
  installObsidianDom(window);
}
