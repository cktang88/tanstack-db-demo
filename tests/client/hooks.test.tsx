import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { useDebouncedParam } from '../../src/lib/hooks'

describe('useDebouncedParam', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = (initial?: string) => {
    const commit = vi.fn()
    const hook = renderHook(({ url }: { url?: string }) => useDebouncedParam(url, commit, 250), {
      initialProps: { url: initial },
    })
    return { commit, hook }
  }

  it('commits trimmed text after the delay', () => {
    const { commit, hook } = setup()
    act(() => hook.result.current[1]('acme '))
    expect(commit).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(commit).toHaveBeenCalledWith('acme')
  })

  it('follows the URL when it changes elsewhere (Back)', () => {
    const { commit, hook } = setup('acme')
    expect(hook.result.current[0]).toBe('acme')
    hook.rerender({ url: 'globex' })
    expect(hook.result.current[0]).toBe('globex')
    hook.rerender({ url: undefined })
    expect(hook.result.current[0]).toBe('')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(commit).not.toHaveBeenCalled()
  })

  it("doesn't clobber typing when its own earlier write lands", () => {
    const { commit, hook } = setup()
    act(() => hook.result.current[1]('ab'))
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(commit).toHaveBeenLastCalledWith('ab')
    act(() => hook.result.current[1]('abc'))
    hook.rerender({ url: 'ab' }) // the URL catches up with the first commit
    expect(hook.result.current[0]).toBe('abc')
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(commit).toHaveBeenLastCalledWith('abc')
  })
})
