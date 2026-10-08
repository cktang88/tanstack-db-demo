import {
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  type ColumnVisibilityState,
} from '@tanstack/react-table'
import { useState, type ReactNode } from 'react'
import { PAGE_SIZES } from '../lib/search'
import { number } from '../lib/format'
import { cx, Spinner } from './ui'

// Server-driven table: the backend sorts, filters and paginates. TanStack
// Table only owns header/selection/visibility behaviour (manual* modes).
export const serverTableFeatures = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  columnVisibilityFeature,
})
export type ServerFeatures = typeof serverTableFeatures

interface Props<T extends { id: number }> {
  columns: ColumnDef<ServerFeatures, T, any>[]
  data: T[]
  rowCount: number
  pagination: PaginationState
  onPaginationChange: (p: PaginationState) => void
  sorting: SortingState
  onSortingChange: (s: SortingState) => void
  isFetching?: boolean
  isPlaceholder?: boolean
  rowSelection?: RowSelectionState
  onRowSelectionChange?: (s: RowSelectionState) => void
  toolbar?: ReactNode
  bulkActions?: (selectedIds: number[], clear: () => void) => ReactNode
  onRowHover?: (row: T) => void
  testId?: string
  rowClassName?: (row: T) => string | undefined
}

export function DataTable<T extends { id: number }>(props: Props<T>) {
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({})
  const [localSelection, setLocalSelection] = useState<RowSelectionState>({})
  const rowSelection = props.rowSelection ?? localSelection
  const setRowSelection = props.onRowSelectionChange ?? setLocalSelection

  const table = useTable({
    features: serverTableFeatures,
    columns: props.columns,
    data: props.data,
    rowCount: props.rowCount,
    getRowId: (r) => String(r.id),
    manualPagination: true,
    manualSorting: true,
    enableRowSelection: true,
    state: { pagination: props.pagination, sorting: props.sorting, rowSelection, columnVisibility },
    onPaginationChange: (u) => props.onPaginationChange(typeof u === 'function' ? u(props.pagination) : u),
    onSortingChange: (u) => props.onSortingChange(typeof u === 'function' ? u(props.sorting) : u),
    onRowSelectionChange: (u) => setRowSelection(typeof u === 'function' ? u(rowSelection) : u),
    onColumnVisibilityChange: setColumnVisibility,
  })

  const selectedIds = Object.keys(rowSelection)
    .filter((k) => rowSelection[k])
    .map(Number)
  const { pageIndex, pageSize } = props.pagination
  const from = props.rowCount === 0 ? 0 : pageIndex * pageSize + 1
  const to = Math.min(props.rowCount, (pageIndex + 1) * pageSize)

  return (
    <div className="card overflow-hidden" data-testid={props.testId}>
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        {props.toolbar}
        <div className="ml-auto flex items-center gap-2">
          {props.isFetching && <Spinner className="text-brand-500" />}
          <details className="relative">
            <summary className="btn-secondary cursor-pointer list-none">Columns</summary>
            <div className="card absolute right-0 z-20 mt-1 w-48 space-y-1 p-2 text-sm shadow-lg">
              {table.getAllLeafColumns().map((c) =>
                c.getCanHide() ? (
                  <label key={c.id} className="flex items-center gap-2">
                    <input type="checkbox" checked={c.getIsVisible()} onChange={c.getToggleVisibilityHandler()} />
                    {typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id}
                  </label>
                ) : null,
              )}
            </div>
          </details>
        </div>
      </div>

      {selectedIds.length > 0 && props.bulkActions && (
        <div
          className="flex items-center gap-3 border-b border-brand-100 bg-brand-50 px-4 py-2 text-sm dark:border-brand-500/20 dark:bg-brand-500/10"
          data-testid="bulk-bar"
        >
          <span className="font-medium">{selectedIds.length} selected</span>
          {props.bulkActions(selectedIds, () => setRowSelection({}))}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className={cx('w-full transition-opacity', props.isPlaceholder && 'opacity-60')}>
          <thead className="bg-zinc-50 dark:bg-zinc-900/60">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted()
                  return (
                    <th
                      key={h.id}
                      className="th"
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    >
                      {h.isPlaceholder ? null : h.column.getCanSort() ? (
                        <button
                          className="inline-flex items-center gap-1 uppercase hover:text-zinc-900 dark:hover:text-white"
                          onClick={h.column.getToggleSortingHandler()}
                        >
                          <table.FlexRender header={h} />
                          <span className="text-[10px]">{sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '↕'}</span>
                        </button>
                      ) : (
                        <table.FlexRender header={h} />
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                data-testid="row"
                onMouseEnter={() => props.onRowHover?.(row.original)}
                className={cx(
                  'hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
                  row.getIsSelected() && 'bg-brand-50/60 dark:bg-brand-500/10',
                  props.rowClassName?.(row.original),
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="td">
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
            {props.data.length === 0 && (
              <tr>
                <td colSpan={99} className="td py-10 text-center text-zinc-500">
                  No results.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 px-4 py-3 text-sm dark:border-zinc-800">
        <span className="text-zinc-500" data-testid="page-info">
          {number(from)}–{number(to)} of {number(props.rowCount)}
        </span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-zinc-500">
            Rows
            <select
              className="input w-20"
              value={pageSize}
              onChange={(e) => table.setPageSize(Number(e.target.value))}
              aria-label="Rows per page"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button
            className="btn-secondary"
            onClick={() => table.firstPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="First page"
          >
            «
          </button>
          <button
            className="btn-secondary"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="Previous page"
          >
            ‹
          </button>
          <span className="px-2 tabular-nums" data-testid="page-number">
            Page {pageIndex + 1} / {Math.max(1, table.getPageCount())}
          </span>
          <button
            className="btn-secondary"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Next page"
          >
            ›
          </button>
          <button
            className="btn-secondary"
            onClick={() => table.lastPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Last page"
          >
            »
          </button>
        </div>
      </div>
    </div>
  )
}

/** Checkbox selection column shared by tables. */
export function selectColumn<T extends Record<string, any>>(): ColumnDef<ServerFeatures, T, unknown> {
  return {
    id: 'select',
    enableSorting: false,
    enableHiding: false,
    header: ({ table }) => (
      <input
        type="checkbox"
        aria-label="Select all rows on page"
        checked={table.getIsAllPageRowsSelected()}
        ref={(el) => {
          if (el) el.indeterminate = table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()
        }}
        onChange={table.getToggleAllPageRowsSelectedHandler()}
      />
    ),
    cell: ({ row }) => (
      <input type="checkbox" aria-label="Select row" checked={row.getIsSelected()} onChange={row.getToggleSelectedHandler()} />
    ),
  }
}
