import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Filter, X } from 'lucide-react';
import { usePopoverPanel } from '../lib/usePopoverPanel';
import { Button, Input } from './ui';

/* Excel-style column filtering, shared by every data table that has it. The state and matching logic
 * lives in lib/useColumnFilters.js; positioning/focus-trap plumbing lives in lib/usePopoverPanel.js;
 * these are the two visual pieces. */

const POPOVER_WIDTH = 256;

/** The funnel button beside a column name. Solid blue while that column is filtered. */
export function FilterFunnel({ label, active, open, onToggle }) {
  return (
    <button
      type="button"
      onClick={(e) => onToggle(e.currentTarget)}
      aria-label={`Filter ${label}${active ? ' (active)' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={active ? `${label} is filtered` : `Filter ${label}`}
      className={`w-5 h-5 rounded flex items-center justify-center transition-colors press-scale ${active ? 'text-white bg-brand-600 hover:bg-brand-700' : open ? 'text-brand-600 bg-brand-50' : 'text-grey-300 hover:text-grey-600 hover:bg-grey-100'}`}
    >
      <Filter className="w-3 h-3" />
    </button>
  );
}

/** Excel-style per-column filter menu. Portaled to document.body and fixed-positioned under its header
 *  button, same reason Modal portals: this app's animate-* classes leave a lingering transform on
 *  ancestors, which would otherwise re-anchor `position: fixed` and clip it inside the table's
 *  overflow-x-auto wrapper. z-10 keeps it under the sticky top nav (z-20) and Modals (z-50), so on scroll
 *  it slides beneath the nav like an attached dropdown instead of painting over it.
 *
 *  Excel semantics: an unfiltered column opens with everything ticked. Typing in the search box pre-ticks
 *  every match in a separate selection ("Select All Search Results"), and Apply then shows exactly those.
 *  Edits stay local until Apply. */
export function ColumnFilterPopover({ column, currentValue, options, anchorEl, onApply, onClear, onClose }) {
  const [checked, setChecked] = useState(() => new Set(currentValue.length ? currentValue : options.map((o) => o.value)));
  const [searchChecked, setSearchChecked] = useState(() => new Set());
  const [query, setQuery] = useState('');
  // On a touch screen, autofocusing the search box pops the keyboard up over the checkboxes.
  const [finePointer] = useState(() => window.matchMedia?.('(pointer: fine)').matches ?? true);
  const stableOnClose = useCallback(() => onClose(), [onClose]);
  const { pos, panelRef: popoverRef, closeToAnchor } = usePopoverPanel(anchorEl, stableOnClose, { width: POPOVER_WIDTH });

  const matches = (term) => (o) => o.label.toLowerCase().includes(term);
  const searching = query.trim() !== '';
  const visibleOptions = searching ? options.filter(matches(query.trim().toLowerCase())) : options;
  const selection = searching ? searchChecked : checked;
  const setSelection = searching ? setSearchChecked : setChecked;
  const allVisibleChecked = visibleOptions.length > 0 && visibleOptions.every((o) => selection.has(o.value));
  const someVisibleChecked = visibleOptions.some((o) => selection.has(o.value));

  function onSearch(e) {
    const q = e.target.value;
    setQuery(q);
    setSearchChecked(new Set(options.filter(matches(q.trim().toLowerCase())).map((o) => o.value)));
  }

  function toggleOption(value) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }

  function toggleAll() {
    setSelection((prev) => {
      const next = new Set(prev);
      visibleOptions.forEach((o) => (allVisibleChecked ? next.delete(o.value) : next.add(o.value)));
      return next;
    });
  }

  function apply() {
    if (!someVisibleChecked) return;
    // Exactly the whole list ticked is Excel's unfiltered state — store it as [] so the column isn't flagged
    // as filtered. The selection can also hold a ticked value another column's filter is hiding from this
    // list (in `checked`, just not shown); then keep it all, so pressing Apply without changing anything
    // never quietly widens the filter.
    const values = [...selection];
    const wholeList = values.length === options.length && options.every((o) => selection.has(o.value));
    closeToAnchor(() => onApply(wholeList ? [] : values));
  }

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={`Filter ${column.label}`}
      tabIndex={-1}
      style={{ position: 'fixed', ...pos }}
      className="z-10 bg-white rounded-xl border border-grey-200 shadow-xl shadow-grey-900/15 flex flex-col overflow-y-auto focus:outline-none animate-scale-in"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-grey-100 shrink-0">
        <span className="text-xs font-semibold text-grey-700">Filter: {column.label}</span>
        <button type="button" onClick={() => closeToAnchor(onClose)} aria-label="Close filter" className="text-grey-400 hover:text-grey-700 transition-colors press-scale">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-2.5 pt-2.5 shrink-0">
        <Input
          autoFocus={finePointer}
          value={query}
          onChange={onSearch}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
          placeholder={`Search ${column.label}…`}
          aria-label={`Search ${column.label} values`}
          className="py-1.5! text-xs!"
        />
        <label className="flex items-center gap-2 text-xs font-semibold text-grey-700 px-1.5 py-1.5 mt-1.5 border-b border-grey-100 cursor-pointer">
          <input
            type="checkbox"
            checked={allVisibleChecked}
            ref={(el) => { if (el) el.indeterminate = someVisibleChecked && !allVisibleChecked; }}
            onChange={toggleAll}
            disabled={visibleOptions.length === 0}
            className="cursor-pointer"
          />
          {searching ? 'Select All Search Results' : 'Select All'}
        </label>
      </div>

      <div className="flex-1 min-h-16 max-h-60 overflow-y-auto px-2.5 py-1">
        {visibleOptions.length === 0 ? (
          <p className="text-xs text-grey-400 px-1.5 py-2">No matches.</p>
        ) : visibleOptions.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-xs text-grey-700 px-1.5 py-1.5 rounded-md hover:bg-grey-50 cursor-pointer">
            <input type="checkbox" checked={selection.has(o.value)} onChange={() => toggleOption(o.value)} className="cursor-pointer shrink-0" />
            <span className={`truncate ${o.value === '' ? 'italic text-grey-500' : ''}`}>{o.label}</span>
            {o.stale && <span className="ml-auto shrink-0 text-grey-400">{o.stale}</span>}
          </label>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-grey-100 shrink-0">
        <button type="button" onClick={() => closeToAnchor(onClear)} className="text-xs font-medium text-grey-500 hover:text-grey-800 transition-colors press-scale">
          Clear
        </button>
        <Button size="sm" onClick={apply} disabled={!someVisibleChecked}>Apply</Button>
      </div>
    </div>,
    document.body
  );
}
