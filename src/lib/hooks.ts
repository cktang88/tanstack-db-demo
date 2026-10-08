import { useEffect, useEffectEvent, useState } from 'react'

/**
 * A text box bound to a URL search param, written back after `delay` ms of
 * inactivity. It follows the URL when the param changes from elsewhere
 * (Back/Forward, links) without clobbering what the user is still typing.
 */
export function useDebouncedParam(urlValue: string | undefined, commit: (value: string | undefined) => void, delay = 250) {
  const [text, setText] = useState(urlValue ?? '')
  const [seen, setSeen] = useState(urlValue)
  const [committed, setCommitted] = useState(urlValue)
  if (seen !== urlValue) {
    setSeen(urlValue)
    // not our own write landing: adopt the URL's value
    if (urlValue !== committed) {
      setCommitted(urlValue)
      setText(urlValue ?? '')
    }
  }
  const onCommit = useEffectEvent(commit)
  useEffect(() => {
    const value = text.trim() || undefined
    if (value === urlValue) return
    const t = setTimeout(() => {
      setCommitted(value)
      onCommit(value)
    }, delay)
    return () => clearTimeout(t)
  }, [text, urlValue, delay])
  return [text, setText] as const
}
