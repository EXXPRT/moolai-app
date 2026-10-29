// The web demo's own page around the desktop renderer: the intro and its bot check, the demo bar with its banners,
// the sample worksheet, the "Try saying" card and the debug overlay. main.ts imports this before its capability
// check, so it keeps to syntax an older browser still parses (no regex lookbehind) and needs only the plain DOM.
import type { DemoConfig, VoiceControllerOptions } from "./types.js";

type Child = Node | string | false | null | undefined;
type Activity = Parameters<NonNullable<VoiceControllerOptions["onActivity"]>>[0];

const GITHUB = "https://github.com/EXXPRT/moolai-app";
const TURNSTILE = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const LEAD = "This is a live web version of Moolai: Moo listens, saves what you say as notes, connects them to two sample study sessions, and answers out loud. Nothing is saved; refresh to start over.";
const CONSENT = "When you start, your voice goes to OpenAI for transcription and for Moo's voice, and your words go to NVIDIA Nemotron on Nebius Token Factory, TypeSafe Jev and Tavily to organize notes and answer. Please don't share anything private.";
const BROWSER = "Best in Chrome or Edge on a laptop; headphones help. Typing only? Moo answers on screen, without voice.";
const BROWSER_SILENT = "Best in Chrome or Edge on a laptop. Moo's voice is unavailable right now, so Moo answers on screen.";
const FIXTURE = "You can still explore Moolai in fixture mode: the same app with simulated replies, typing only. Nothing you type leaves this page.";
const MODELS = ["Intent & connections · Jev 1.13 (TypeSafe)", "Notes · Nemotron 3.5 Lightning", "Answers · Nemotron 3 Ultra", "Worksheet · GLM 5.3 Flash"];
const VOICE_MODEL = "Voice · OpenAI (AI-generated)";
/** Lines that match the seeded sessions (dilution, then osmosis) and the sample worksheet. The doubt comes before the
 * first "Moo, …": Moo offers help only outside a conversation, and "Yes, please." opens the one the later lines use. */
const TRY: { say: string[]; shows: string }[] = [
  { say: ["Osmosis is water moving across a membrane toward the side with more solute."], shows: "A thought: saved, then organized into a note" },
  { say: ["I'm stuck on trial B on this worksheet. I don't get how to use c1, V1 and c2 to find the final volume.", "Yes, please."], shows: "A doubt: Moo offers to help, then reads the sample worksheet" },
  { say: ["Moo, what do my notes say about how dilution and osmosis are connected?"], shows: "A question: Moo answers from the sample notes and links the ones it used" },
  { say: ["Moo, search the web for why red blood cells burst in pure water."], shows: "A web search" },
  { say: ["Moo, finish conversation."], shows: "Ends the conversation" },
];

/** An element whose text is always set as text, never parsed as HTML. `on…` props are listeners. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string | boolean | undefined | ((event: Event) => void)> = {},
  ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (typeof value === "function") node.addEventListener(name.slice(2), value);
    else if (value === true) node.setAttribute(name, "");
    else if (typeof value === "string") node.setAttribute(name, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}
const brand = () => h("div", { class: "brand" }, h("span", { class: "mark", "aria-hidden": "true" }, "m"),
  h("div", {}, h("h1", {}, "Moolai"), h("p", {}, "Web demo")));

/** GET /api/demo/config's reason in plain words (demo_gateway.py); "unreachable" is the page's own. */
function reasonText(reason: string | undefined) {
  switch (reason) {
    case "unreachable": return "The live demo can't be reached right now.";
    case "disabled": case "off": return "The live demo is switched off right now.";
    case "ended": return "The live demo has ended.";
    case "budget_exhausted": return "Today's live budget for this demo is used up.";
    case "not_production": return "This preview deployment doesn't make live calls.";
    default: return "The live demo is unavailable right now.";
  }
}

/** A whole-page message for when the demo cannot run at all. */
export function renderMessage(root: HTMLElement, message: string) {
  root.append(h("div", { class: "demo-message" }, h("section", { class: "demo-card" }, brand(),
    h("p", { class: "demo-status is-error", role: "alert" }, message))));
}

export interface Intro {
  /** Shows how to start: the consent line, the bot check and the start buttons when live, fixture mode otherwise.
   * Returns the bot check's container. */
  offer(config: DemoConfig, start: (voice: boolean) => void): HTMLElement;
  ready(enabled: boolean): void;
  status(text: string, error?: boolean): void;
  /** No way to start: the buttons go and the message stays. */
  fail(message: string): void;
  /** The live demo can't start here (the bot check, or a refused session): offers fixture mode as well. */
  fallback(start: () => void): void;
  /** The visitor started: the intro goes, and the app and its demo bar show. */
  close(): void;
}

export function renderIntro(root: HTMLElement): Intro {
  const offer = h("div", { class: "demo-offer" });
  const line = h("p", { class: "demo-status", role: "status" }, "Checking the live demo…");
  const page = h("div", { class: "demo-intro" }, h("section", { class: "demo-card", "aria-label": "Moolai web demo" },
    brand(), h("p", { class: "demo-lead" }, LEAD), offer, line));
  root.append(page);
  let buttons: HTMLButtonElement[] = [], fixture: HTMLButtonElement | undefined;
  const status = (text: string, error = false) => {
    line.textContent = text;
    line.classList.toggle("is-error", error);
  };
  const button = (label: string, primary: boolean, onClick: () => void) =>
    h("button", { type: "button", class: primary ? "primary" : undefined, disabled: true, onclick: onClick }, label);
  return {
    offer(config, start) {
      const check = h("div", { class: "demo-check" });
      if (config.live) {
        buttons = [config.voice && button("Start with voice", true, () => start(true)),
          button("Start with typing", !config.voice, () => start(false))].filter((item): item is HTMLButtonElement => !!item);
        offer.append(h("p", { class: "demo-consent" }, CONSENT), h("p", { class: "hint" }, config.voice ? BROWSER : BROWSER_SILENT), check);
      } else {
        buttons = [button("Explore in fixture mode", true, () => start(false))];
        offer.append(h("p", { class: "demo-reason" }, `${reasonText(config.reason)} ${FIXTURE}`));
      }
      offer.append(h("div", { class: "demo-actions" }, ...buttons));
      return check;
    },
    ready(enabled) { for (const item of buttons) item.disabled = !enabled; },
    status,
    fail(message) {
      offer.replaceChildren();
      buttons = [];
      fixture = undefined;
      status(message, true);
    },
    fallback(start) {
      if (!fixture) {
        const button: HTMLButtonElement = h("button", { type: "button", onclick: () => {
          for (const item of [...buttons, button]) item.disabled = true;
          start();
        } }, "Explore in fixture mode");
        fixture = button;
        offer.append(h("p", { class: "demo-reason" }, FIXTURE), h("div", { class: "demo-actions" }, button));
      }
      // Offered again after a later failure, it works again.
      fixture.disabled = false;
    },
    close() {
      page.remove();
      document.body.classList.remove("demo-intro");
    },
  };
}

/** A panel the demo bar opens and closes; its own button is the bar's toggle. The body's `<id>-open` class says it is
 * open, which demo.css uses to dock the "Try saying" card. */
function panel(id: string, title: string, className: string, content: Child[], onClose?: () => void) {
  const toggle = h("button", { type: "button", "aria-expanded": "false", "aria-controls": id }, title);
  const el = h("aside", { id, class: `demo-panel ${className}`, "aria-label": title, hidden: true },
    h("header", {}, h("strong", {}, title),
      h("button", { type: "button", class: "icon-button", "aria-label": `Close ${title}`, onclick: () => show(false) }, "×")),
    ...content);
  const show = (open: boolean) => {
    const wasOpen = !el.hidden;
    el.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle(`${id}-open`, open);
    if (wasOpen && !open) onClose?.();
  };
  toggle.addEventListener("click", () => show(el.hidden !== false));
  return { el, toggle, show };
}

export interface DemoChrome {
  /** A banner under the demo bar that stays until the page is reloaded, or until dismissed. Repeats are shown once. */
  banner(text: string, dismissable?: boolean): void;
  openWorksheet(): void;
}

/** Where demo.css docks the "Try saying" card beside the renderer, which keeps 900 px or more. */
const TRY_DOCKS = "(min-width: 1260px)";

/** The demo bar above the renderer, its banners, the worksheet drawer and the "Try saying" card. */
export function renderChrome(root: HTMLElement, options: { live: boolean; voice: boolean }): DemoChrome {
  // The worksheet drawer covers the card; closing it brings the card back if it was open, for the steps after the doubt.
  let reopenTry = false;
  const worksheet = panel("demo-worksheet", "Sample worksheet", "demo-drawer", [
    h("p", {}, "In this web demo, 'your screen' is this sample worksheet."),
    h("img", { src: "/sample-worksheet.png", loading: "lazy", alt: "Dilution worksheet: use c1 V1 = c2 V2 to find the final volume V2. Trial A: c1 2.50 mol/L, V1 40.0 mL, c2 0.50 mol/L. Trial B: c1 1.20 mol/L, V1 25.0 mL, c2 0.50 mol/L. Water to add = V2 - V1." })],
    () => { if (reopenTry) { reopenTry = false; tryCard.show(true); } });
  const tryCard = panel("demo-try", "Try saying", "demo-try", [
    h("ol", {}, ...TRY.map(item => h("li", {},
      ...item.say.flatMap((line, index) => [index ? " then " : "", h("q", {}, line)]), h("small", {}, item.shows)))),
    h("p", {}, "Or type them and press Send.")]);
  const models = options.live ? [...MODELS, ...(options.voice ? [VOICE_MODEL] : [])] : [];
  const banners = h("div", { class: "demo-banners" });
  const bar = h("div", { class: "demo-bar", role: "region", "aria-label": "About this demo" },
    options.live ? h("span", { class: "demo-mode" }, h("strong", {}, "Live demo"), " · nothing is saved, refresh to reset")
      : h("span", { class: "demo-mode" }, h("strong", {}, "Fixture mode")),
    models.length > 0 && h("ul", { class: "demo-models", "aria-label": "Models in this demo" }, ...models.map(model => h("li", {}, model))),
    h("div", { class: "demo-links" }, worksheet.toggle, tryCard.toggle,
      h("a", { href: GITHUB, target: "_blank", rel: "noopener" }, "GitHub")));
  root.append(bar, banners, worksheet.el, tryCard.el);
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    reopenTry = false;
    worksheet.show(false);
    tryCard.show(false);
  });
  // First visit: what to say is the first question. A wide window docks the card beside the app (demo.css); in a
  // narrower one it would cover the app's own controls, such as Search & filters, so it starts closed there.
  tryCard.show(matchMedia(TRY_DOCKS).matches);
  return {
    banner(text, dismissable = false) {
      if (Array.from(banners.children).some(item => item.firstChild?.textContent === text)) return;
      const item = h("div", { class: "demo-banner", role: "status" }, h("span", {}, text));
      if (dismissable) item.append(h("button", { type: "button", class: "text-button", onclick: () => item.remove() }, "Dismiss"));
      banners.append(item);
    },
    openWorksheet() {
      reopenTry ||= !tryCard.el.hidden;
      tryCard.show(false);
      worksheet.show(true);
    },
  };
}

/** Shown under 900 px wide (demo.css): the renderer's two panes need a laptop-sized window. */
export function renderNarrowNotice(root: HTMLElement) {
  const notice = h("div", { class: "demo-narrow" }, h("div", { class: "demo-card", role: "dialog", "aria-label": "Screen size" },
    h("p", {}, "Moolai's demo is built for a laptop or desktop browser."),
    h("button", { type: "button", class: "primary", onclick: () => notice.remove() }, "Continue")));
  root.append(notice);
}

/** ?debug=1: the voice pipeline's last onset, its queue and the level it measured. */
export function createDebugOverlay(root: HTMLElement): (activity: Activity) => void {
  const overlay = h("div", { class: "demo-debug", "aria-hidden": "true" }, "onset – · pending 0 · rms –");
  root.append(overlay);
  let onset = "–";
  return activity => {
    if (activity.onset) {
      const now = new Date();
      onset = `${now.toLocaleTimeString("en-GB")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
    }
    overlay.textContent = `onset ${onset} · pending ${activity.pending} · rms ${activity.rms === undefined ? "–" : activity.rms.toFixed(4)}`;
  };
}

export interface TurnstileOptions {
  sitekey: string;
  action: string;
  theme?: "light" | "dark" | "auto";
  callback(token: string): void;
  "expired-callback"?(): void;
  "error-callback"?(code: string): void;
}
export interface Turnstile {
  render(container: HTMLElement, options: TurnstileOptions): string | undefined;
  reset(widget?: string): void;
  remove(widget: string): void;
}
declare global {
  interface Window { turnstile?: Turnstile }
}

let turnstile: Promise<Turnstile> | undefined;
/** Cloudflare's script, added once. Explicit rendering lets the page set the action and read the token. */
export function loadTurnstile(): Promise<Turnstile> {
  if (!turnstile) turnstile = new Promise<Turnstile>((resolve, reject) => {
    const script = h("script", { src: TURNSTILE, async: true });
    script.addEventListener("load", () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not start")));
    script.addEventListener("error", () => reject(new Error("Turnstile could not be loaded")));
    document.head.append(script);
  });
  return turnstile;
}
