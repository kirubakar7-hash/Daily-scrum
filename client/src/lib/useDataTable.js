import { useEffect, useMemo, useState } from 'react';
import { useColumnFilters } from './useColumnFilters';

/* The single state engine behind every DataTable (components/DataTable). A page hands it its rows and its
 * column configuration — the one source of truth for what a column is called, what it shows, how it sorts,
 * and how it's filtered — and gets back everything the table needs to render: visible/ordered columns,
 * widths, the processed (filtered → searched → sorted) rows, and the handlers for every interaction.
 *
 * Column shape: { key (stable, unique), label, value(row) => raw value — used for display fallback, sort,
 * filter and search alike, so there is exactly one definition of "what this column means", format?(raw) =>
 * option label (only when the cell shows the value transformed, e.g. through Badge's humanize), order?:
 * string[] (enum-like columns — doubles as filter-list order AND sort rank), render?(row) => ReactNode
 * (cell content; falls back to value(row)), width?, minWidth? (default 80), align?, sortable? (default
 * true), filterable? (default true), searchable? (default true), defaultHidden? (starting visibility), alwaysVisible?
 * (can't be hidden), cellClassName? (td classes).
 *
 * Filtering reuses lib/useColumnFilters as-is — this hook only adds the layout (visible columns, order,
 * width — persisted per `tableId`) and the sort/search layer on top of what it already returns. */

const PREFS_PREFIX = 'dsm_datatable_';

function loadPrefs(tableId) {
  if (!tableId) return null;
  try {
    const raw = localStorage.getItem(PREFS_PREFIX + tableId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function savePrefs(tableId, prefs) {
  if (!tableId) return;
  try {
    localStorage.setItem(PREFS_PREFIX + tableId, JSON.stringify(prefs));
  } catch {
    // Private-window/blocked storage: layout just won't persist across visits — nothing to recover from.
  }
}

function defaultPrefs(columns) {
  return { order: columns.map((c) => c.key), hidden: columns.filter((c) => c.defaultHidden).map((c) => c.key), widths: {} };
}

// A saved layout from an earlier version of this table's column config — or anything else that happens
// to be in storage under this key. Every field is validated, because a value that throws here would
// crash the page on every visit until the user cleared their storage: drop unknown and duplicate keys,
// append any new column at the end so it's never silently invisible, keep only positive numeric widths.
function reconcilePrefs(saved, columns) {
  const known = new Set(columns.map((c) => c.key));
  const savedOrder = Array.isArray(saved?.order) ? saved.order : [];
  const seen = new Set();
  const order = [];
  for (const k of [...savedOrder, ...columns.map((c) => c.key)]) {
    if (known.has(k) && !seen.has(k)) { seen.add(k); order.push(k); }
  }
  const hidden = Array.isArray(saved?.hidden) ? [...new Set(saved.hidden.filter((k) => known.has(k)))] : [];
  const rawWidths = saved?.widths && typeof saved.widths === 'object' && !Array.isArray(saved.widths) ? saved.widths : {};
  const widths = Object.fromEntries(Object.entries(rawWidths).filter(([k, w]) => known.has(k) && Number.isFinite(w) && w > 0));
  // Never restore a layout with every column hidden — the table would render as an empty frame.
  return { order, hidden: hidden.length >= order.length ? [] : hidden, widths };
}

function compareRows(a, b, column) {
  const va = column.value(a) ?? '';
  const vb = column.value(b) ?? '';
  if (column.order) {
    const rank = (v) => { const i = column.order.indexOf(v); return i < 0 ? column.order.length : i; };
    return rank(va) - rank(vb) || String(va).localeCompare(String(vb));
  }
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
}

export function useDataTable(rows, columns, { tableId, staleLabel, searchPlaceholderColumns, loading = false } = {}) {
  const [prefs, setPrefs] = useState(() => {
    const saved = loadPrefs(tableId);
    return saved ? reconcilePrefs(saved, columns) : defaultPrefs(columns);
  });
  // A column config that changed shape (columns added/removed) since prefs were last computed — reconcile
  // rather than trust a stale order/hidden list built from a different column set.
  const columnKeys = columns.map((c) => c.key).join('|');
  useEffect(() => {
    setPrefs((p) => {
      const known = new Set(columns.map((c) => c.key));
      if (p.order.length === columns.length && p.order.every((k) => known.has(k))) return p;
      return reconcilePrefs(p, columns);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnKeys]);
  useEffect(() => { savePrefs(tableId, prefs); }, [tableId, prefs]);

  const [sort, setSort] = useState(null); // { key, dir: 'asc' | 'desc' }
  const [search, setSearch] = useState('');

  const columnByKey = useMemo(() => Object.fromEntries(columns.map((c) => [c.key, c])), [columns]);
  const orderedColumns = useMemo(() => prefs.order.map((k) => columnByKey[k]).filter(Boolean), [prefs.order, columnByKey]);
  const visibleColumns = useMemo(() => orderedColumns.filter((c) => !prefs.hidden.includes(c.key)), [orderedColumns, prefs.hidden]);

  // Filtering is independent of show/hide — hiding a column is a display preference, not a data-scope
  // change, matching Excel (a hidden column's AutoFilter keeps working). "Clear all filters" always
  // reaches it even while hidden.
  const filterableColumns = useMemo(() => columns.filter((c) => c.filterable !== false), [columns]);
  const columnFilters = useColumnFilters(rows, filterableColumns, { staleLabel });

  const searchableColumns = useMemo(
    () => (searchPlaceholderColumns || visibleColumns).filter((c) => c.searchable !== false),
    [searchPlaceholderColumns, visibleColumns]
  );
  const searched = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return columnFilters.filtered;
    return columnFilters.filtered.filter((r) => searchableColumns.some((c) => String(c.value(r) ?? '').toLowerCase().includes(term)));
  }, [columnFilters.filtered, search, searchableColumns]);

  const sortedRows = useMemo(() => {
    if (!sort) return searched;
    const col = columnByKey[sort.key];
    if (!col) return searched;
    const copy = [...searched];
    copy.sort((a, b) => (sort.dir === 'asc' ? 1 : -1) * compareRows(a, b, col));
    return copy;
  }, [searched, sort, columnByKey]);

  function toggleSort(key) {
    // asc -> desc -> unsorted, so "Reset columns" has a real unsorted state to return to.
    setSort((s) => {
      if (s?.key !== key) return { key, dir: 'asc' };
      return s.dir === 'asc' ? { key, dir: 'desc' } : null;
    });
  }

  function toggleVisible(key) {
    setPrefs((p) => {
      if (p.hidden.includes(key)) return { ...p, hidden: p.hidden.filter((k) => k !== key) };
      if (columnByKey[key]?.alwaysVisible) return p;
      // The last visible column can't be hidden — the table would render as an empty frame.
      if (p.order.length - p.hidden.length <= 1) return p;
      return { ...p, hidden: [...p.hidden, key] };
    });
  }

  // One step left/right in the order — the keyboard and touch-screen way to reorder (native drag-and-drop
  // doesn't fire on most phones).
  function moveColumn(key, delta) {
    setPrefs((p) => {
      const from = p.order.indexOf(key);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= p.order.length) return p;
      const order = [...p.order];
      [order[from], order[to]] = [order[to], order[from]];
      return { ...p, order };
    });
  }

  function reorder(fromKey, toKey) {
    if (fromKey === toKey) return;
    setPrefs((p) => {
      const order = [...p.order];
      const from = order.indexOf(fromKey);
      const to = order.indexOf(toKey);
      if (from < 0 || to < 0) return p;
      order.splice(from, 1);
      order.splice(to, 0, fromKey);
      return { ...p, order };
    });
  }

  function resize(key, width) {
    const min = columnByKey[key]?.minWidth ?? 80;
    setPrefs((p) => ({ ...p, widths: { ...p.widths, [key]: Math.round(Math.max(width, min)) } }));
  }

  function resetColumns() {
    setPrefs(defaultPrefs(columns));
    setSort(null);
  }

  function clearFilters() {
    columnFilters.clearAll();
    setSearch('');
  }

  return {
    loading,
    columns,
    visibleColumns,
    orderedColumns,
    hiddenKeys: prefs.hidden,
    widths: prefs.widths,
    isCustomized: prefs.hidden.length > 0 || prefs.order.some((k, i) => k !== columns[i]?.key) || Object.keys(prefs.widths).length > 0,
    toggleVisible,
    moveColumn,
    reorder,
    resize,
    resetColumns,
    sort,
    toggleSort,
    search,
    setSearch,
    rows: sortedRows,
    totalCount: rows.length,
    matchedCount: sortedRows.length,
    clearFilters,
    anyFilterActive: columnFilters.anyActive || search.trim() !== '',
    isColumnFiltered: columnFilters.isFiltered,
    isFilterOpen: columnFilters.isOpen,
    toggleColumnFilter: columnFilters.toggleFilter,
    filterPopoverProps: columnFilters.popoverProps,
  };
}
