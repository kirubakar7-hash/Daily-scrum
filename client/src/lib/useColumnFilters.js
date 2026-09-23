import { useCallback, useMemo, useState } from 'react';

/* State + matching for Excel-style column filters (the popover itself is components/ColumnFilter.jsx).
 *
 * `columns` must be a module-level constant: [{ key, label, value(row) => string, format?(raw) => string,
 * order?: string[] }]. `value` is what the column's cell displays (so the list mirrors the column); `format`
 * turns it into the option label when the cell shows it transformed (e.g. through Badge's humanize);
 * `order` gives enum-like columns a meaningful order instead of alphabetical.
 *
 * Each column's filter holds the raw values to SHOW; [] is Excel's "Select All", i.e. unfiltered. As in
 * Excel, a column's list only offers values present in the rows that pass every OTHER column's filter.
 * Filters live in memory: they survive a data reload (a still-ticked value that left the rows entirely
 * stays listed, flagged with `staleLabel`) and reset on a full page refresh. */

const BLANK_LABEL = '(Blanks)';

// Filter values are always compared as text, so a numeric column (a count of 0, say) filters like any other
// instead of 0 being mistaken for a blank cell.
const cellKey = (column, row) => String(column.value(row) ?? '');

function optionLabel(column, value) {
  if (value === '') return BLANK_LABEL;
  return column.format ? column.format(value) : value;
}

// Built from the loaded rows (like Excel's own column filter), not the org's master lists — a value with
// no rows in this table would only ever filter down to nothing. Empty cells get a "(Blanks)" entry,
// otherwise unticking one Process would silently hide every row that has no Process at all.
function columnOptions(rows, column) {
  const values = [...new Set(rows.map((r) => cellKey(column, r)))];
  const present = values.filter(Boolean);
  if (column.order) {
    const rank = (v) => { const i = column.order.indexOf(v); return i < 0 ? column.order.length : i; };
    present.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  } else {
    present.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  if (values.includes('')) present.push('');
  return present.map((v) => ({ value: v, label: optionLabel(column, v) }));
}

// A value that's ticked but whose last row just left the table (say, that task was completed) must still be
// listed, ticked and untickable. Otherwise the column looks unfiltered while it hides everything. A ticked
// value merely hidden by another column's filter is still in the rows, so it isn't listed (Excel doesn't);
// the popover keeps it in the selection rather than silently dropping it.
function withSelectedValues(options, selected, column, staleLabel, rows) {
  const listed = new Set(options.map((o) => o.value));
  const inRows = new Set(rows.map((r) => cellKey(column, r)));
  const gone = selected.filter((v) => !listed.has(v) && !inRows.has(v));
  if (gone.length === 0) return options;
  return [...options, ...gone.map((v) => ({ value: v, label: optionLabel(column, v), stale: staleLabel }))];
}

// AND across columns, optionally ignoring one column's own filter (for that column's option list).
function rowsPassing(rows, columns, filters, exceptKey) {
  const active = columns.filter((c) => c.key !== exceptKey && filters[c.key].length > 0).map((c) => [c, new Set(filters[c.key])]);
  return active.length ? rows.filter((r) => active.every(([c, allowed]) => allowed.has(cellKey(c, r)))) : rows;
}

const emptyFilters = (columns) => Object.fromEntries(columns.map((c) => [c.key, []]));

export function useColumnFilters(rows, columns, { staleLabel = 'no longer listed' } = {}) {
  const [filters, setFilters] = useState(() => emptyFilters(columns));
  const [openFilter, setOpenFilter] = useState(null); // { key, anchorEl } — one column menu open at a time

  const filtered = useMemo(() => rowsPassing(rows, columns, filters, null), [rows, columns, filters]);

  const openColumn = openFilter && columns.find((c) => c.key === openFilter.key);
  const openOptions = useMemo(() => {
    if (!openColumn) return null;
    const listed = columnOptions(rowsPassing(rows, columns, filters, openColumn.key), openColumn);
    return withSelectedValues(listed, filters[openColumn.key], openColumn, staleLabel, rows);
  }, [rows, columns, filters, openColumn, staleLabel]);

  const closeFilter = useCallback(() => setOpenFilter(null), []);
  const toggleFilter = useCallback((key, anchorEl) => {
    setOpenFilter((prev) => (prev?.key === key ? null : { key, anchorEl }));
  }, []);
  const clearAll = useCallback(() => setFilters(emptyFilters(columns)), [columns]);

  const popoverProps = openColumn ? {
    column: openColumn,
    currentValue: filters[openColumn.key],
    options: openOptions,
    anchorEl: openFilter.anchorEl,
    onApply: (value) => { setFilters((f) => ({ ...f, [openColumn.key]: value })); closeFilter(); },
    onClear: () => { setFilters((f) => ({ ...f, [openColumn.key]: [] })); closeFilter(); },
    onClose: closeFilter,
  } : null;

  return {
    filters,
    filtered,
    anyActive: columns.some((c) => filters[c.key].length > 0),
    isFiltered: (key) => filters[key].length > 0,
    isOpen: (key) => openFilter?.key === key,
    toggleFilter,
    clearAll,
    popoverProps,
  };
}
