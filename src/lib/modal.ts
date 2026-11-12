// One dialog, for every question the page has to stop and ask.
//
// It replaces asking "which wallet should pay?" through `window.prompt`, with the wallets numbered
// and the answer typed as a digit. That is a real answer to a real problem (with two extensions
// installed, `window.ethereum` is whichever won the race to inject), but the wrong shape for it.
//
// Native `<dialog>` does the parts that are easy to get wrong by hand: the backdrop, the focus
// trap, Escape, and returning focus where it came from. What is left is the list and the promise.

import { type Child, el } from "./ui.ts";

export interface Choice<T> {
  value: T;
  label: string;
  sub?: string | undefined;
  /** A data: URL a wallet handed us. Anything else is ignored: this page fetches nothing. */
  iconUrl?: string | undefined;
  /** A mark this page draws itself. */
  icon?: (() => Child) | undefined;
  selected?: boolean;
}

/**
 * Resolves with the chosen item, or null if the person backed out. Backing out is a first class
 * answer: this dialog stands in front of connecting a wallet, so "not that one, and not any of
 * them" has to be reachable without picking something.
 */
export function chooseOne<T>({
  title,
  note,
  items,
  cancelLabel = "Cancel",
}: {
  title: string;
  note?: string;
  items: ReadonlyArray<Choice<T>>;
  cancelLabel?: string;
}): Promise<Choice<T> | null> {
  return new Promise((resolve) => {
    let answer: Choice<T> | null = null;

    const dialog = el("dialog", { class: "picker", "aria-label": title });
    const close = (choice: Choice<T> | null) => {
      answer = choice;
      dialog.close();
    };

    dialog.append(
      el(
        "div",
        { class: "picker-inner" },
        el("h2", {}, title),
        note ? el("p", { class: "help" }, note) : null,
        el(
          "div",
          { class: "pick-list" },
          ...items.map((item) =>
            el(
              "button",
              { class: `pick tall${item.selected ? " on" : ""}`, onClick: () => close(item) },
              iconFor(item),
              el(
                "span",
                { class: "pick-body" },
                el("span", { class: "pick-title" }, item.label),
                item.sub ? el("span", { class: "pick-meta" }, item.sub) : null,
              ),
            ),
          ),
        ),
        el("div", { class: "picker-foot" }, el("button", { class: "quiet", onClick: () => close(null) }, cancelLabel)),
      ),
    );

    // One listener for every way out: the button, Escape, and the backdrop. They all land here, so
    // none of them can leave the promise pending.
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(answer);
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) close(null);
    });

    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>(".pick")?.focus();
  });
}

/**
 * An icon is rendered only when it is drawn here or is a data URI. EIP-6963 says a wallet's icon is
 * one, and honouring an `https://` icon instead would let an extension learn when this page is open.
 */
function iconFor<T>(item: Choice<T>): HTMLElement {
  if (item.icon) return el("span", { class: "pick-icon drawn", "aria-hidden": "true" }, item.icon());
  if (item.iconUrl && /^data:image\//i.test(item.iconUrl)) {
    return el("img", { class: "pick-icon", src: item.iconUrl, alt: "", width: 24, height: 24 });
  }
  return el("span", { class: "pick-icon placeholder", "aria-hidden": "true" }, initialOf(item.label));
}

function initialOf(label: string): string {
  return label.trim().charAt(0).toUpperCase() || "?";
}
