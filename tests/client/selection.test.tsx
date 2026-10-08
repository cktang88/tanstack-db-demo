import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vite-plus/test'
import { createSelectionStore, selectedIds, useSelection } from '../../src/lib/selection'

describe('selection store', () => {
  it('belongs to one user', () => {
    const store = createSelectionStore()
    store.set(1, { '3': true, '7': true })
    expect(store.get(1)).toEqual({ '3': true, '7': true })
    expect(selectedIds(store.get(1))).toEqual([3, 7])
    // another user starts empty, and writing as them replaces the previous user's selection
    expect(store.get(2)).toEqual({})
    store.set(2, { '9': true })
    expect(store.get(1)).toEqual({})
  })

  it('survives unmounting (paging away, leaving the page) and notifies subscribers', () => {
    const store = createSelectionStore()
    const first = renderHook(() => useSelection(store, 1))
    act(() => first.result.current[1]({ '5': true }))
    expect(first.result.current[0]).toEqual({ '5': true })
    first.unmount()
    const again = renderHook(() => useSelection(store, 1))
    expect(again.result.current[0]).toEqual({ '5': true })
    act(() => again.result.current[1]({}))
    expect(again.result.current[0]).toEqual({})
  })
})
