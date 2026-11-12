// The marks the chains are known by, drawn rather than fetched.
//
// A network is a thing people recognise by its logo before they read its name, and a payment
// screen that names the wrong chain in text somebody skimmed is a payment on the wrong chain. So
// the switcher carries marks.
//
// Inline SVG, no image files and no CDN: this page fetches nothing to draw itself, and that rule
// does not get an exception for decoration. Each is a plain geometric rendering in the chain's own
// colours, close enough to be recognised at 16 pixels and not a copy of anyone's artwork.

import { el, svgEl } from "./ui.ts";

function mark(size: number, ...children: SVGElement[]): SVGSVGElement {
  return svgEl(
    "svg",
    { class: "netmark", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true" },
    ...children,
  );
}

// A gradient needs an id, and two of these on one screen with the same id is one gradient. The
// counter keeps them apart without needing to know where they are mounted.
let gradients = 0;

function solanaMark(size: number): SVGSVGElement {
  gradients += 1;
  const id = `solmark${gradients}`;
  const defs = svgEl(
    "defs",
    {},
    svgEl(
      "linearGradient",
      { id, x1: 3, y1: 18, x2: 21, y2: 6, gradientUnits: "userSpaceOnUse" },
      svgEl("stop", { offset: 0, "stop-color": "#9945FF" }),
      svgEl("stop", { offset: 1, "stop-color": "#14F195" }),
    ),
  );
  // Three slanted bars, which is the shape everyone reads as Solana.
  const bar = (y: number, leansRight: boolean) =>
    svgEl("path", {
      d: leansRight ? `M6.4 ${y}h13.2l-2.8 3H3.6z` : `M4.4 ${y}h13.2l2.8 3H7.2z`,
      fill: `url(#${id})`,
    });
  return mark(size, defs, bar(4.5, true), bar(10.5, false), bar(16.5, true));
}

function baseMark(size: number): SVGSVGElement {
  // A blue disc with a squared bite out of its right side.
  return mark(
    size,
    svgEl("circle", { cx: 12, cy: 12, r: 10, fill: "#0052FF" }),
    svgEl("path", { d: "M12 4.6A7.4 7.4 0 0 0 4.7 10.9H15v2.2H4.7A7.4 7.4 0 0 0 12 19.4z", fill: "#fff" }),
  );
}

function ethereumMark(size: number): SVGSVGElement {
  return mark(
    size,
    svgEl("path", { d: "M12 2.5 5.8 12.2 12 15.8l6.2-3.6z", fill: "#627EEA" }),
    svgEl("path", { d: "M12 17.2 5.8 13.6 12 21.5l6.2-7.9z", fill: "#8CA0F0" }),
  );
}

/** A chain with no mark of its own gets its initial in a neutral disc, which reads as "a network". */
function genericMark(label: string, size: number): SVGSVGElement {
  const initial = (label.trim()[0] ?? "?").toUpperCase();
  return mark(
    size,
    svgEl("circle", {
      cx: 12,
      cy: 12,
      r: 10,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.6,
      opacity: 0.45,
    }),
    svgEl(
      "text",
      { x: 12, y: 16.4, "text-anchor": "middle", "font-size": 11, "font-weight": 600, fill: "currentColor" },
      initial,
    ),
  );
}

const MARKS: Readonly<Record<string, (size: number) => SVGSVGElement>> = {
  "eip155:8453": baseMark,
  "eip155:84532": baseMark,
  "eip155:1": ethereumMark,
  "eip155:11155111": ethereumMark,
};

/**
 * The icon for a CAIP-2 network id: the chain's own where this knows it, the family's where it
 * knows that (every Solana cluster is Solana), and a lettered disc otherwise.
 */
export function networkMark(network: string, { size = 16, label = "" } = {}): SVGSVGElement {
  const draw = MARKS[network];
  if (draw) return draw(size);
  if (network.startsWith("solana:")) return solanaMark(size);
  if (network.startsWith("eip155:")) return ethereumMark(size);
  return genericMark(label || network, size);
}

/** The mark and the name together, which is how a network should be named anywhere it is chosen. */
export function networkChip(network: string, label: string, { size = 16 } = {}): HTMLSpanElement {
  return el("span", { class: "netchip" }, networkMark(network, { size, label }), el("span", {}, label));
}
