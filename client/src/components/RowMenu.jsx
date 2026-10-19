import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./ui.jsx";

// Three-dot actions menu for a table row.
//   label   accessible name, e.g. "Actions for Acme"
//   items   [{ label, onClick, danger?, disabled?, title?, hidden? }]
// The list is rendered in a portal (position: fixed) so the table's scroll container never clips it.
// Keyboard: Enter/Space/ArrowDown opens, arrows/Home/End move, Escape closes and returns focus, Tab closes.
export default function RowMenu({ label, items, busy = false }) {
  const visible = items.filter((i) => !i.hidden);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const id = useId();

  const close = useCallback((refocus = false) => {
    setOpen(false);
    setPos(null);
    if (refocus) btnRef.current?.focus();
  }, []);

  // Place the menu under the button, right edges aligned; flip above when there is no room below.
  useLayoutEffect(() => {
    if (!open || !btnRef.current || !menuRef.current) return;
    const b = btnRef.current.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    const gap = 4;
    const below = window.innerHeight - b.bottom - gap;
    const top = below >= m.height || b.top < m.height ? b.bottom + gap : b.top - m.height - gap;
    const left = Math.max(8, Math.min(b.right - m.width, window.innerWidth - m.width - 8));
    setPos({ top: Math.max(8, top), left });
  }, [open, visible.length]);

  // Focus the first enabled item once placed.
  useEffect(() => {
    if (!open || !pos) return;
    const first = menuRef.current?.querySelector('[role="menuitem"]:not([aria-disabled="true"])');
    (first || menuRef.current)?.focus(); // every item disabled: focus the menu itself so Escape/Tab still close it
  }, [open, !!pos]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      close();
    };
    const onScroll = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  // A row that disappears or whose actions all vanish must not leave an orphan menu behind.
  useEffect(() => {
    if (open && visible.length === 0) close();
  }, [open, visible.length, close]);

  function onButtonKey(e) {
    if (e.key === "ArrowDown" && !open) {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKey(e) {
    const els = [...menuRef.current.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')];
    const i = els.indexOf(document.activeElement);
    let next = null;
    if (e.key === "ArrowDown") next = els[(i + 1) % els.length];
    else if (e.key === "ArrowUp") next = els[(i - 1 + els.length) % els.length];
    else if (e.key === "Home") next = els[0];
    else if (e.key === "End") next = els[els.length - 1];
    else if (e.key === "Escape") {
      e.preventDefault();
      return close(true);
    } else if (e.key === "Tab") return close();
    if (next) {
      e.preventDefault();
      next.focus();
    }
  }

  function pick(item) {
    if (item.disabled) return;
    close(true);
    item.onClick();
  }

  if (visible.length === 0) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="icon-btn row-menu-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={onButtonKey}
      >
        <Icon name="more" size={18} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={id}
            role="menu"
            aria-label={label}
            className="row-menu"
            tabIndex={-1}
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
            onKeyDown={onMenuKey}
          >
            {visible.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`row-menu-item${item.danger ? " is-danger" : ""}`}
                aria-disabled={item.disabled ? "true" : undefined}
                title={item.title}
                onClick={() => pick(item)}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
