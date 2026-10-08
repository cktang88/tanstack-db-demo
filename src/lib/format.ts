const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const usdCompact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})
const num = new Intl.NumberFormat('en-US')
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
// date-only strings ("2026-10-08") are parsed as UTC midnight: format them in UTC so
// they don't shift to the previous day for users west of Greenwich
const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/** Cents -> "$1,234" */
export const money = (cents: number) => usd.format(cents / 100)
/** Cents -> "$1.2K" */
export const moneyCompact = (cents: number) => usdCompact.format(cents / 100)
export const number = (n: number) => num.format(n)
export const date = (iso: string | null | undefined) =>
  !iso ? '—' : DATE_ONLY.test(iso) ? dayFmt.format(new Date(`${iso}T00:00:00Z`)) : dateFmt.format(new Date(iso))
/** Calendar date of `now` (default: today) in the user's time zone, as "YYYY-MM-DD" (e.g. <input type="date"> defaults). */
export const localToday = (now = new Date()) => now.toLocaleDateString('en-CA')
/** "2026-03" -> "Mar 26" */
export const month = (ym: string) => monthFmt.format(new Date(`${ym}-01T00:00:00Z`))
export const percent = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`

export function relative(iso: string, now = Date.now()) {
  const diff = (new Date(iso).getTime() - now) / 1000
  const abs = Math.abs(diff)
  if (abs < 60) return rtf.format(Math.round(diff), 'second')
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day')
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month')
  return rtf.format(Math.round(diff / (86400 * 365)), 'year')
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/** Read a text field from FormData ('' when missing or a File). */
export const field = (form: FormData, name: string) => {
  const v = form.get(name)
  return typeof v === 'string' ? v : ''
}
