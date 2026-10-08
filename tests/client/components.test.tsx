import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vite-plus/test'
import { CustomerForm } from '../../src/components/CustomerForm'
import { DataTable, selectColumn } from '../../src/components/DataTable'
import { Toaster } from '../../src/components/ui'
import { toast } from '../../src/lib/toast'

function withQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['users', 'list'], { data: [], total: 0, page: 1, pageSize: 0, pageCount: 1 })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

type Row = { id: number; name: string }
const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `Row ${i + 1}` }))
const columns = [selectColumn<Row>(), { accessorKey: 'name', header: 'Name' }] as never

describe('DataTable', () => {
  it('renders rows, page info and drives pagination callbacks', async () => {
    const onPaginationChange = vi.fn()
    render(
      <DataTable<Row>
        columns={columns}
        data={rows}
        rowCount={42}
        pagination={{ pageIndex: 0, pageSize: 5 }}
        onPaginationChange={onPaginationChange}
        sorting={[]}
        onSortingChange={() => {}}
      />,
    )
    expect(screen.getAllByTestId('row')).toHaveLength(5)
    expect(screen.getByTestId('page-info').textContent).toBe('1–5 of 42')
    expect(screen.getByTestId('page-number').textContent).toBe('Page 1 / 9')
    expect(screen.getByLabelText('Previous page')).toHaveProperty('disabled', true)
    await userEvent.click(screen.getByLabelText('Next page'))
    expect(onPaginationChange).toHaveBeenCalledWith({ pageIndex: 1, pageSize: 5 })
    await userEvent.click(screen.getByLabelText('Last page'))
    expect(onPaginationChange).toHaveBeenLastCalledWith({ pageIndex: 8, pageSize: 5 })
  })

  it('emits sorting changes from header clicks', async () => {
    const onSortingChange = vi.fn()
    render(
      <DataTable<Row>
        columns={columns}
        data={rows}
        rowCount={5}
        pagination={{ pageIndex: 0, pageSize: 25 }}
        onPaginationChange={() => {}}
        sorting={[]}
        onSortingChange={onSortingChange}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /name/i }))
    expect(onSortingChange).toHaveBeenCalledWith([{ id: 'name', desc: false }])
  })

  it('shows bulk actions for selected rows', async () => {
    const bulk = vi.fn(() => <span>bulk!</span>)
    render(
      <DataTable<Row>
        columns={columns}
        data={rows}
        rowCount={5}
        pagination={{ pageIndex: 0, pageSize: 25 }}
        onPaginationChange={() => {}}
        sorting={[]}
        onSortingChange={() => {}}
        bulkActions={bulk}
      />,
    )
    expect(screen.queryByTestId('bulk-bar')).toBeNull()
    const boxes = screen.getAllByLabelText('Select row')
    await userEvent.click(boxes[0]!)
    await userEvent.click(boxes[2]!)
    expect(screen.getByTestId('bulk-bar').textContent).toContain('2 selected')
    expect(bulk).toHaveBeenLastCalledWith([1, 3], expect.any(Function))
  })
})

describe('CustomerForm (React 19 form actions)', () => {
  it('shows schema errors and does not submit', async () => {
    const onSubmit = vi.fn()
    render(withQuery(<CustomerForm submitLabel="Create" onSubmit={onSubmit} />))
    await userEvent.type(screen.getByLabelText('Company'), 'X')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect((await screen.findAllByText('Must be at least 2 characters')).length).toBeGreaterThan(0)
    expect(screen.getByText('Enter a valid email address')).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits decoded values', async () => {
    const onSubmit = vi.fn(async () => {})
    const onDone = vi.fn()
    render(withQuery(<CustomerForm submitLabel="Create" onSubmit={onSubmit} onDone={onDone} />))
    await userEvent.type(screen.getByLabelText('Company'), 'Acme Inc')
    await userEvent.type(screen.getByLabelText('Contact name'), 'Wile E')
    await userEvent.type(screen.getByLabelText('Email'), 'wile@acme.test')
    await userEvent.clear(screen.getByLabelText('Seats'))
    await userEvent.type(screen.getByLabelText('Seats'), '12')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(onSubmit).toHaveBeenCalledWith({
      company: 'Acme Inc',
      name: 'Wile E',
      email: 'wile@acme.test',
      plan: 'starter',
      status: 'trial',
      country: 'US',
      seats: 12,
      ownerId: null,
    })
  })

  it('surfaces server errors', async () => {
    render(
      withQuery(
        <CustomerForm
          submitLabel="Save"
          initial={{ company: 'Acme', name: 'Wile', email: 'w@a.co' }}
          onSubmit={() => Promise.reject(new Error('Boom'))}
        />,
      ),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Boom')).toBeTruthy()
  })
})

describe('toasts', () => {
  it('renders pushed toasts', async () => {
    render(<Toaster />)
    toast.error('Nope', 'details')
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Nope'))
  })
})
