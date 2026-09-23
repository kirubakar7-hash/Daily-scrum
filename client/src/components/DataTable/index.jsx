import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3Cog, GripVertical, Search, XCircle } from 'lucide-react';
import { useDataTable } from '../../lib/useDataTable';
import { EmptyState, IllustrationEmptyList, IllustrationSearch, Input, Skeleton } from '../ui';
import { ColumnFilterPopover, FilterFunnel } from '../ColumnFilter';
import { ColumnManagerMenu } from './ColumnManagerMenu';

/* The one reusable table for the whole app. A page supplies `data` + `columns` (the single source of
 * truth — see lib/useDataTable.js for the column shape) and gets show/hide, drag-to-reorder, resize,
 * Excel-style per-column filtering, sorting, a global search box, loading/empty states and horizontal
 * scrolling for free. `toolbarExtra`/`renderRowActions` are the only page-specific hooks — everything
 * else about how a table looks and behaves lives here, once.
 *
 * Two ways to use it:
 *   <DataTable data={rows} columns={cols} />                     — the table owns its own state
 *   const table = useDataTable(rows, cols, opts);
 *   <DataTableView table={table} />                               — the page owns the state (e.g. to
 *                                                                    read `table.rows` for a CSV export
 *                                                                    of exactly what's on screen) */

const DEFAULT_WIDTH = 150;
const MIN_WIDTH = 80;
const ALIGN_CLASS = { left: 'text-left', center: 'text-center', right: 'text-right' };

function alignClass(align) {
  return ALIGN_CLASS[align] || ALIGN_CLASS.left;
}

const KEY_RESIZE_STEP = 16;

/** Right-edge resize grip. `resizingRef` is shared with the header cells so a resize gesture can never also
 *  start the header's native column drag (the handle sits inside a draggable <th>). Arrow keys resize too. */
function ResizeHandle({ columnKey, label, onResize, resizingRef }) {
  function onPointerDown(e) {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.closest('th');
    if (!th) return;
    resizingRef.current = true;
    const startWidth = th.offsetWidth;
    const startX = e.clientX;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    let frame = 0;
    function onMove(ev) {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => onResize(columnKey, startWidth + (ev.clientX - startX)));
    }
    function onUp() {
      cancelAnimationFrame(frame);
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }
  function onKeyDown(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const th = e.currentTarget.closest('th');
    if (th) onResize(columnKey, th.offsetWidth + (e.key === 'ArrowRight' ? KEY_RESIZE_STEP : -KEY_RESIZE_STEP));
  }
  return (
    <div
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column (left and right arrow keys)`}
      title="Drag to resize"
      className="absolute top-0 right-0 h-full w-2 cursor-col-resize touch-none group/resize focus:outline-none focus-visible:bg-brand-100"
    >
      <div className="mx-auto h-full w-px bg-transparent group-hover/resize:bg-brand-300 group-active/resize:bg-brand-500" />
    </div>
  );
}

function CellValue({ value }) {
  if (value === null || value === undefined || value === '') return <span className="text-grey-300">—</span>;
  return value;
}

export function DataTableView({
  table,
  loadingRows = 5,
  emptyIcon,
  emptyTitle = 'Nothing here yet',
  emptyBody,
  noMatchTitle = 'No rows match these filters',
  noMatchBody = 'Adjust a filter, or use "Clear filters" above.',
  searchPlaceholder = 'Search…',
  showSearch = true,
  showColumnManager = true,
  toolbarExtra,
  getRowId = (r) => r.id,
  rowClassName,
  renderRowActions,
  rowActionsLabel = 'Actions',
  className = '',
}) {
  const [managerAnchor, setManagerAnchor] = useState(null);
  const [dragKey, setDragKey] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null);
  const resizingRef = useRef(false);

  function onHeaderDrop(key) {
    if (dragKey && dragKey !== key) table.reorder(dragKey, key);
    setDragKey(null);
    setDragOverKey(null);
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {showSearch && (
          <div className="relative w-full sm:w-56">
            <Search className="w-3.5 h-3.5 text-grey-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <Input
              value={table.search}
              onChange={(e) => table.setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="pl-8 py-1.5! text-xs!"
              aria-label={searchPlaceholder}
            />
          </div>
        )}
        <span className="text-xs text-grey-400">{table.matchedCount} of {table.totalCount} {table.matchedCount === 1 ? 'row' : 'rows'}</span>
        {table.anyFilterActive && (
          <button onClick={table.clearFilters} className="inline-flex items-center gap-1 text-xs font-medium text-grey-500 hover:text-grey-700 transition-colors">
            <XCircle className="w-3.5 h-3.5" /> Clear filters
          </button>
        )}
        <div className="flex-1" />
        {toolbarExtra}
        {showColumnManager && (
          <button
            type="button"
            onClick={(e) => setManagerAnchor((a) => (a ? null : e.currentTarget))}
            aria-haspopup="dialog"
            aria-expanded={!!managerAnchor}
            title="Show, hide and reorder columns"
            className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg border transition-colors press-scale ${managerAnchor ? 'border-brand-300 text-brand-700 bg-brand-50' : 'border-grey-200 text-grey-600 hover:border-brand-300 hover:text-brand-700 hover:bg-brand-50'}`}
          >
            <Columns3Cog className="w-3.5 h-3.5" /> Columns
          </button>
        )}
      </div>

      {table.loading ? (
        <div className="space-y-2">
          {Array.from({ length: loadingRows }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : table.totalCount === 0 ? (
        <EmptyState icon={emptyIcon || <IllustrationEmptyList className="w-16 h-16 mx-auto" />} title={emptyTitle}>{emptyBody}</EmptyState>
      ) : (
        <>
        <div className="overflow-x-auto">
          <table className="w-full text-sm table-fixed">
            <thead>
              <tr className="text-left text-grey-500 border-b border-grey-200">
                {table.visibleColumns.map((col) => {
                  const width = table.widths[col.key] ?? col.width ?? DEFAULT_WIDTH;
                  const sorted = col.sortable !== false && table.sort?.key === col.key;
                  const SortIcon = sorted ? (table.sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
                  return (
                    <th
                      key={col.key}
                      style={{ width, minWidth: col.minWidth ?? MIN_WIDTH }}
                      draggable
                      onDragStart={(e) => {
                        if (resizingRef.current) { e.preventDefault(); return; }
                        setDragKey(col.key);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragOver={(e) => { e.preventDefault(); if (dragOverKey !== col.key) setDragOverKey(col.key); }}
                      onDragLeave={() => setDragOverKey((k) => (k === col.key ? null : k))}
                      onDrop={(e) => { e.preventDefault(); onHeaderDrop(col.key); }}
                      onDragEnd={() => { setDragKey(null); setDragOverKey(null); }}
                      className={`relative py-2 pl-1 pr-4 font-semibold whitespace-nowrap ${alignClass(col.align)} ${dragOverKey === col.key && dragKey && dragKey !== col.key ? 'bg-brand-50' : ''} ${dragKey === col.key ? 'opacity-40' : ''}`}
                    >
                      <div className="inline-flex items-center gap-1 group/th max-w-full">
                        <GripVertical className="w-3 h-3 text-grey-300 opacity-0 group-hover/th:opacity-100 cursor-grab active:cursor-grabbing shrink-0" aria-hidden="true" />
                        {col.sortable !== false ? (
                          <button type="button" onClick={() => table.toggleSort(col.key)} title={`Sort by ${col.label}`} className="inline-flex items-center gap-1 min-w-0 hover:text-grey-800 transition-colors press-scale">
                            <span className="truncate">{col.label}</span>
                            <SortIcon className={`w-3 h-3 shrink-0 ${sorted ? 'text-brand-600' : 'text-grey-300'}`} />
                          </button>
                        ) : (
                          <span className="truncate">{col.label}</span>
                        )}
                        {col.filterable !== false && (
                          <FilterFunnel
                            label={col.label}
                            active={table.isColumnFiltered(col.key)}
                            open={table.isFilterOpen(col.key)}
                            onToggle={(el) => table.toggleColumnFilter(col.key, el)}
                          />
                        )}
                      </div>
                      <ResizeHandle columnKey={col.key} label={col.label} onResize={table.resize} resizingRef={resizingRef} />
                    </th>
                  );
                })}
                {renderRowActions && <th className="py-2 pr-4 font-semibold whitespace-nowrap">{rowActionsLabel}</th>}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr
                  key={getRowId(row)}
                  className={`border-b border-grey-100 hover:bg-grey-50 transition-colors align-top animate-fade-in-up ${rowClassName ? rowClassName(row) : ''}`}
                  style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                >
                  {table.visibleColumns.map((col) => (
                    // overflow-hidden is load-bearing under table-fixed: without it, a nowrap cell whose
                    // text is wider than its column visually bleeds into the next cell instead of clipping.
                    <td key={col.key} className={`py-2.5 pr-4 overflow-hidden ${alignClass(col.align)} ${col.cellClassName || 'text-grey-700'}`}>
                      {col.render ? col.render(row) : <CellValue value={col.value(row)} />}
                    </td>
                  ))}
                  {renderRowActions && <td className="py-2.5 pr-4">{renderRowActions(row)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Outside the horizontal scroller, so it stays on screen even when the table is scrolled sideways. */}
        {table.matchedCount === 0 && (
          <EmptyState icon={<IllustrationSearch className="w-16 h-16 mx-auto" />} title={noMatchTitle}>{noMatchBody}</EmptyState>
        )}
        </>
      )}

      {table.filterPopoverProps && <ColumnFilterPopover key={table.filterPopoverProps.column.key} {...table.filterPopoverProps} />}
      {managerAnchor && (
        <ColumnManagerMenu
          orderedColumns={table.orderedColumns}
          hiddenKeys={table.hiddenKeys}
          onToggleVisible={table.toggleVisible}
          onReorder={table.reorder}
          onMove={table.moveColumn}
          onReset={table.resetColumns}
          anchorEl={managerAnchor}
          onClose={() => setManagerAnchor(null)}
        />
      )}
    </div>
  );
}

const NO_ROWS = [];

export default function DataTable({ data, columns, tableId, staleLabel, ...view }) {
  const table = useDataTable(data ?? NO_ROWS, columns, { tableId, staleLabel, loading: data === null });
  return <DataTableView table={table} {...view} />;
}
