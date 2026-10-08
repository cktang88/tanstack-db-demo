import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'

export interface Throttled<A extends unknown[]> {
  (...args: A): void
  /** a trailing call is waiting for the window to close */
  pending: () => boolean
  /** run the waiting trailing call now */
  flush: () => void
  cancel: () => void
}

/**
 * Leading + trailing throttle: the first call runs at once, later calls inside
 * the `wait` window collapse into one trailing call with the latest arguments.
 */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, wait: number): Throttled<A> {
  let last = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined
  let queued: A | undefined
  const run = (args: A) => {
    last = Date.now()
    queued = undefined
    fn(...args)
  }
  const fire = () => {
    timer = undefined
    if (queued) run(queued)
  }
  const throttled = ((...args: A) => {
    const remaining = wait - (Date.now() - last)
    if (remaining <= 0 && !timer) return run(args)
    queued = args
    timer ??= setTimeout(fire, Math.max(0, remaining))
  }) as Throttled<A>
  throttled.pending = () => queued !== undefined
  throttled.flush = () => {
    clearTimeout(timer)
    fire()
  }
  throttled.cancel = () => {
    clearTimeout(timer)
    timer = undefined
    queued = undefined
  }
  return throttled
}

/**
 * A stable throttled callback that always calls the latest `fn`. A trailing
 * call still waiting when the component unmounts is flushed, not dropped.
 */
export function useThrottledCallback<A extends unknown[]>(fn: (...args: A) => void, wait: number) {
  const latest = useRef(fn)
  useLayoutEffect(() => {
    latest.current = fn
  })
  const throttled = useMemo(() => throttle<A>((...args) => latest.current(...args), wait), [wait])
  useEffect(() => () => throttled.flush(), [throttled])
  return throttled
}
