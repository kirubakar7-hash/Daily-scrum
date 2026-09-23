import { useCallback, useEffect, useRef, useState } from 'react';

/* Shared plumbing for every portaled, anchor-following popover in the app (the column filter menu, the
 * DataTable column manager): position it under its trigger, keep it there as the page moves, trap Tab
 * inside it, close on outside click / Escape, and hand focus back to the trigger when a keyboard action
 * closes it. Each caller supplies its own content and choice of width. */

const POPOVER_MIN_HEIGHT = 280;

// Measured against the visual viewport (what's actually on screen, excluding a phone's open keyboard).
// Opens below the anchor, or above when that side has more room; never shorter than POPOVER_MIN_HEIGHT,
// sliding over the anchor if it must, so the panel can't collapse to nothing. `renderedHeight` (once
// known) lets that slide stop at the panel's real height, not its maximum.
function popoverPosition(anchorEl, width, renderedHeight) {
  const rect = anchorEl.getBoundingClientRect();
  const vv = window.visualViewport;
  const viewTop = vv ? vv.offsetTop : 0;
  const viewLeft = vv ? vv.offsetLeft : 0;
  const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const viewRight = vv ? vv.offsetLeft + vv.width : window.innerWidth;
  const viewHeight = viewBottom - viewTop;
  const w = Math.min(width, viewRight - viewLeft - 16);
  const left = Math.max(viewLeft + 8, Math.min(rect.left, viewRight - w - 8));
  const below = viewBottom - rect.bottom - 14;
  const above = rect.top - viewTop - 14;
  const openBelow = below >= POPOVER_MIN_HEIGHT || below >= above;
  const maxHeight = Math.min(420, viewHeight - 16, Math.max(openBelow ? below : above, POPOVER_MIN_HEIGHT));
  const height = renderedHeight ? Math.min(renderedHeight, maxHeight) : maxHeight;
  if (openBelow) {
    return { top: Math.max(viewTop + 8, Math.min(rect.bottom + 6, viewBottom - 8 - height)), left, width: w, maxHeight };
  }
  const bottom = window.innerHeight - viewBottom + 8;
  return { bottom: Math.max(bottom, Math.min(window.innerHeight - rect.top + 6, window.innerHeight - viewTop - 8 - height)), left, width: w, maxHeight };
}

/** `anchorEl` and `onClose` must be stable for the popover's lifetime (its own re-renders are fine —
 *  a new `onClose` identity on every parent render is not; wrap it in useCallback at the call site). */
export function usePopoverPanel(anchorEl, onClose, { width = 256 } = {}) {
  const [pos, setPos] = useState(() => popoverPosition(anchorEl, width));
  const panelRef = useRef(null);

  // Keyboard-driven closes hand focus back to the trigger. An outside click doesn't, since that click has
  // already put focus where the user wanted it.
  const closeToAnchor = useCallback((action) => { action(); anchorEl.focus(); }, [anchorEl]);

  useEffect(() => {
    function onPointerDown(e) {
      if (panelRef.current?.contains(e.target) || anchorEl.contains(e.target)) return;
      onClose();
    }
    function onKey(e) {
      if (e.key === 'Escape') { closeToAnchor(onClose); return; }
      // Portaled to the end of <body>, so without this Tab would walk straight off the page.
      if (e.key !== 'Tab' || !panelRef.current?.contains(document.activeElement)) return;
      const focusable = panelRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorEl, onClose, closeToAnchor]);

  // Re-measure every frame while open rather than only on scroll/resize: a notice appearing or vanishing
  // above the table shifts the anchor without firing either event. One rect read per frame, and a
  // re-render only when the position actually changes.
  useEffect(() => {
    let frame = 0;
    let last = JSON.stringify(popoverPosition(anchorEl, width));
    function track() {
      if (!anchorEl.isConnected) { onClose(); return; }
      const next = popoverPosition(anchorEl, width, panelRef.current?.offsetHeight);
      const key = JSON.stringify(next);
      if (key !== last) { last = key; setPos(next); }
      frame = requestAnimationFrame(track);
    }
    frame = requestAnimationFrame(track);
    return () => cancelAnimationFrame(frame);
  }, [anchorEl, onClose, width]);

  return { pos, panelRef, closeToAnchor };
}
