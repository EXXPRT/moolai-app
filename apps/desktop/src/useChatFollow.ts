import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const preference = "moolai.chat-follow-latest.v1";
const nearBottom = (pane: HTMLElement) => pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 32;

/** Following is optional. Reading older messages pauses it until the user returns. */
export function useChatFollow(pane: RefObject<HTMLDivElement | null>, contentVersion: string) {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem(preference) === "true"; } catch { return false; }
  });
  const [paused, setPaused] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const mode = useRef({ enabled, paused: false });

  function measure() {
    const element = pane.current;
    if (element) setAtBottom(nearBottom(element));
  }
  function jump() {
    mode.current.paused = false; setPaused(false);
    const element = pane.current;
    if (element) { element.scrollTop = element.scrollHeight; measure(); }
  }
  function setFollow(value: boolean) {
    mode.current.enabled = value; setEnabled(value);
    try { localStorage.setItem(preference, String(value)); } catch { /* Browsing works without preference storage. */ }
    if (value) jump();
  }
  function pause() {
    if (!mode.current.enabled) return;
    mode.current.paused = true; setPaused(true);
  }

  useEffect(() => {
    const element = pane.current;
    if (!element) return;
    const onScroll = () => {
      const bottom = nearBottom(element);
      setAtBottom(bottom);
      if (mode.current.enabled) { mode.current.paused = !bottom; setPaused(!bottom); }
    };
    // Mark upward intent before a new model event can move the viewport again.
    const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) pause(); };
    const onKey = (event: KeyboardEvent) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pause(); };
    const resize = new ResizeObserver(() => {
      if (mode.current.enabled && !mode.current.paused) element.scrollTop = element.scrollHeight;
      measure();
    });
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("keydown", onKey);
    resize.observe(element);
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("keydown", onKey);
      resize.disconnect();
    };
  }, [pane]);
  useLayoutEffect(() => {
    if (mode.current.enabled && !mode.current.paused) jump();
    else measure();
  }, [contentVersion]);

  return { enabled, paused, atBottom, setFollow, jump };
}
