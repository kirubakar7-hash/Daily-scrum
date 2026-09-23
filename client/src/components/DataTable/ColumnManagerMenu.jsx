import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { GripVertical, RotateCcw, X } from 'lucide-react';
import { usePopoverPanel } from '../../lib/usePopoverPanel';

const PANEL_WIDTH = 240;

/** Show/hide and drag-to-reorder every column, plus "Reset to default" for the whole layout (order,
 *  visibility and widths). Same portal/positioning plumbing as the column filter popover, so it behaves
 *  identically (follows its trigger, traps Tab, closes on outside click/Escape). Column filters are
 *  untouched by anything here — hiding a column is a display preference, not a change of data scope. */
export function ColumnManagerMenu({ orderedColumns, hiddenKeys, onToggleVisible, onReorder, onReset, anchorEl, onClose }) {
  const [dragKey, setDragKey] = useState(null);
  const [overKey, setOverKey] = useState(null);
  const stableOnClose = useCallback(() => onClose(), [onClose]);
  const { pos, panelRef, closeToAnchor } = usePopoverPanel(anchorEl, stableOnClose, { width: PANEL_WIDTH });

  function onDrop(key) {
    if (dragKey && dragKey !== key) onReorder(dragKey, key);
    setDragKey(null);
    setOverKey(null);
  }

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Manage columns"
      tabIndex={-1}
      style={{ position: 'fixed', ...pos }}
      className="z-10 bg-white rounded-xl border border-grey-200 shadow-xl shadow-grey-900/15 flex flex-col overflow-y-auto focus:outline-none animate-scale-in"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-grey-100 shrink-0">
        <span className="text-xs font-semibold text-grey-700">Columns</span>
        <button type="button" onClick={() => closeToAnchor(onClose)} aria-label="Close column settings" className="text-grey-400 hover:text-grey-700 transition-colors press-scale">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-16 max-h-72 overflow-y-auto py-1">
        {orderedColumns.map((col) => (
          <div
            key={col.key}
            draggable
            onDragStart={(e) => { setDragKey(col.key); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { e.preventDefault(); if (overKey !== col.key) setOverKey(col.key); }}
            onDragLeave={() => setOverKey((k) => (k === col.key ? null : k))}
            onDrop={(e) => { e.preventDefault(); onDrop(col.key); }}
            onDragEnd={() => { setDragKey(null); setOverKey(null); }}
            className={`flex items-center gap-1.5 px-2 py-1.5 text-xs text-grey-700 ${overKey === col.key && dragKey && dragKey !== col.key ? 'bg-brand-50' : ''} ${dragKey === col.key ? 'opacity-40' : ''}`}
          >
            <GripVertical className="w-3.5 h-3.5 text-grey-300 shrink-0 cursor-grab active:cursor-grabbing" aria-hidden="true" />
            <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
              <input
                type="checkbox"
                checked={!hiddenKeys.includes(col.key)}
                disabled={col.alwaysVisible}
                onChange={() => onToggleVisible(col.key)}
                className="cursor-pointer shrink-0 disabled:cursor-not-allowed"
              />
              <span className="truncate">{col.label}</span>
            </label>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-grey-100 shrink-0">
        <button
          type="button"
          onClick={() => closeToAnchor(onReset)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-grey-500 hover:text-grey-800 transition-colors press-scale"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Reset to default
        </button>
      </div>
    </div>,
    document.body
  );
}
