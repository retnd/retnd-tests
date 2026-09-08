import type { Page } from "@playwright/test";

/**
 * A computed-contrast reading of everything a page has actually painted.
 *
 * rclone-manager#618 was not a wrong colour anybody wrote down. Nothing in
 * the app declared `color-scheme`, so every browser assumed light for its
 * own controls whatever `data-theme` said, and any `input`, `select`,
 * `textarea` or `button` without an explicit colour took the user agent's
 * default of black. In dark mode that is black on a dark surface. The
 * defect therefore has no selector: it belongs to whichever control
 * somebody last styled without naming a colour, and a list of known-bad
 * selectors would have been written the day after each one shipped.
 *
 * So this reads what the browser resolved rather than what the source
 * says. For every element that paints its own text, and for every native
 * control whether or not it has text in it yet, it composites the
 * foreground over the effective background and computes the WCAG contrast
 * ratio between the two.
 *
 * # Why the colours go through a canvas
 *
 * `getComputedStyle().color` hands back whatever notation the author used,
 * and this design system is written in `oklch()`. A regex that understands
 * `rgb()` and nothing else returns null on every token in the palette, and
 * a sweep that then falls back to black reports 1.1:1 on healthy text and
 * misses the real thing. Painting the string into a 1x1 canvas asks the
 * same engine that rendered the page what the colour is, which is the only
 * answer that cannot drift from what is on screen.
 *
 * # What the floor means
 *
 * UNREADABLE is not a claim of WCAG AA. It is the line under which text is
 * not text any more, and it is placed by measurement: see its own comment.
 */
export interface Reading {
  /** tag, classes and a snippet of the text, enough to find it by hand. */
  what: string;
  /** As the browser computed it, in whatever notation the author wrote. */
  color: string;
  /** The composited backdrop, always as `rgb()`. */
  background: string;
  ratio: number;
  /** WCAG relative luminance of each, so a case can ask which of the two is
   *  the lighter without a second colour parser out in Node. */
  luminance: { text: number; background: number };
}

/**
 * The contrast floor, in WCAG ratio terms.
 *
 * The named failure is far below it. Black on the dark-mode surface, which
 * is what the SSH wizard's buttons drew, measures 1.24:1 on its Close
 * button and 1.10:1 on the disabled one beside it.
 *
 * Everything the design system ships today is above it. The worst pairing
 * a healthy page produces is --text-3 on the active nav link's
 * --accent-quiet at 2.89:1, and --text-3 on --surface-2 at 2.93:1. Those
 * are real but much smaller complaints than this one, and they belong to
 * whoever moves those tokens rather than here.
 *
 * That leaves this at 2.5: comfortably under every muted pairing in the
 * product and comfortably over the failure. It deliberately does NOT sit
 * at WCAG's 3:1 large-text minimum, because the product is under that in
 * two muted places today and a sweep that goes red on a defect it was not
 * written for teaches people to relax it.
 *
 * One thing this floor does NOT catch, and it matters: white on the
 * dark-mode accent, which is the other half of #618, measures 2.67:1. That
 * is above this line, so it is caught by a case of its own with a floor of
 * its own rather than by the sweep. A whole-tree floor is placed by the
 * worst thing the product legitimately ships; a single named control can
 * be held to AA.
 */
export const UNREADABLE = 2.5;

/**
 * Reads every painted foreground/background pair under `root`.
 *
 * `root` is a selector rather than a Locator because the whole walk has to
 * happen in one page evaluation: a per-element round trip over a page with
 * 240 of them is slow enough to matter and, worse, reads a tree that may
 * have re-rendered between elements.
 */
export async function contrastReadings(page: Page, root = "body"): Promise<Reading[]> {
  return page.evaluate((rootSelector) => {
    const scope = document.querySelector(rootSelector);
    if (!scope) throw new Error("contrast sweep found no " + rootSelector);

    // One canvas for the whole sweep. Chromium resolves oklch(), color(),
    // color-mix(), currentColor-derived rgb() and the UA's own keywords
    // through the same path it painted the page with.
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("contrast sweep could not get a 2d context");

    type RGBA = { r: number; g: number; b: number; a: number };
    const cache = new Map<string, RGBA | null>();
    const toRGBA = (value: string): RGBA | null => {
      const hit = cache.get(value);
      if (hit !== undefined) return hit;
      ctx.clearRect(0, 0, 1, 1);
      // A colour the engine cannot parse leaves fillStyle untouched, so
      // seed it with something no token is and notice if it survives.
      ctx.fillStyle = "#010203";
      ctx.fillStyle = value;
      if (ctx.fillStyle === "#010203" && value.trim() !== "#010203") {
        cache.set(value, null);
        return null;
      }
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      // Canvas premultiplies, so undo it before compositing again below.
      const a = d[3] / 255;
      const out: RGBA =
        a === 0
          ? { r: 0, g: 0, b: 0, a: 0 }
          : { r: d[0] / a, g: d[1] / a, b: d[2] / a, a };
      cache.set(value, out);
      return out;
    };

    const over = (top: RGBA, bottom: RGBA): RGBA => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1
    });

    const luminance = (c: RGBA): number => {
      const channel = (v: number) => {
        const s = Math.min(255, Math.max(0, v)) / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    };

    const contrast = (fg: RGBA, bg: RGBA): number => {
      const a = luminance(fg);
      const b = luminance(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };

    // What is actually behind this element: every translucent layer from
    // the element outwards, composited onto the first opaque one, and onto
    // white if nothing on the way to <html> is opaque, which is what a
    // browser paints over.
    const backdrop = (el: Element): RGBA => {
      const layers: RGBA[] = [];
      let node: Element | null = el;
      while (node) {
        const layer = toRGBA(getComputedStyle(node).backgroundColor);
        if (layer && layer.a > 0) {
          layers.push(layer);
          if (layer.a >= 1) break;
        }
        node = node.parentElement;
      }
      let base: RGBA = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
      return base;
    };

    const painted = (el: Element): boolean => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      if (Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    // Text this element draws ITSELF, not what its children draw. Colour is
    // inherited, so charging a wrapper with its descendants' text would
    // report the same defect once per level of nesting and would pair text
    // with a background it is not on.
    const ownText = (el: Element): string =>
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();

    const SKIP = new Set(["script", "style", "svg", "path", "title", "head", "meta", "link", "br", "hr"]);
    const readings: {
      what: string;
      color: string;
      background: string;
      ratio: number;
      luminance: { text: number; background: number };
    }[] = [];

    const all: Element[] = [scope, ...Array.from(scope.querySelectorAll("*"))];
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) continue;
      // A native control counts even while it is empty: the colour it
      // resolves is the colour whatever gets typed into it will be, and an
      // empty field is exactly where #618 hid.
      const control = tag === "input" || tag === "select" || tag === "textarea";
      const text = ownText(el);
      if (!control && text === "") continue;
      if (!painted(el)) continue;

      const style = getComputedStyle(el);
      const bg = backdrop(el);
      const raw = toRGBA(style.color);
      if (!raw) continue;
      const fg = over(raw, bg);

      const classes = String((el as HTMLElement).className || "")
        .trim()
        .slice(0, 48);
      const label = control ? "<" + tag + ">" : text.slice(0, 48);
      readings.push({
        what: tag + (classes ? "." + classes.replace(/\s+/g, ".") : "") + " " + JSON.stringify(label),
        color: style.color,
        background:
          "rgb(" + Math.round(bg.r) + ", " + Math.round(bg.g) + ", " + Math.round(bg.b) + ")",
        ratio: Math.round(contrast(fg, bg) * 100) / 100,
        luminance: { text: luminance(fg), background: luminance(bg) }
      });
    }
    return readings;
  }, root);
}

/** The readings under the floor, worst first. */
export function unreadable(readings: Reading[], floor = UNREADABLE): Reading[] {
  return readings.filter((r) => r.ratio < floor).sort((a, b) => a.ratio - b.ratio);
}

/** What a failure prints. A ratio on its own says nothing an operator can
 *  act on, so every line carries the element, both resolved colours and
 *  the number. */
export function report(readings: Reading[]): string {
  return readings
    .map((r) => "  " + r.ratio.toFixed(2) + ":1  " + r.what + "  " + r.color + " on " + r.background)
    .join("\n");
}

/** The sweep's own control: paints a deliberate black-on-black control into
 *  the page, so a run can prove the sweep still sees a violation before it
 *  reports that there are none. Returns a function that removes it again.
 *
 *  This exists because every case in this file passes when the sweep is
 *  broken in the obvious way. A regex that does not understand `oklch()`,
 *  a backdrop walk that stops at the wrong node, a selector that matches
 *  nothing: all three report zero violations, which is the same thing a
 *  healthy page reports. */
export async function plantUnreadableControl(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
    const el = document.createElement("button");
    el.id = "contrast-sweep-control";
    el.textContent = "planted by the contrast sweep";
    el.style.background = bg;
    el.style.color = bg;
    document.body.appendChild(el);
  });
}

export async function removeUnreadableControl(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById("contrast-sweep-control")?.remove();
  });
}
