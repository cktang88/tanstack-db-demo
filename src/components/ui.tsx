import { useEffect, useRef, type ReactNode } from 'react'
import { dismiss, useToasts } from '../lib/toast'
import { initials, titleCase } from '../lib/format'

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <title>{`${title} · Saasly`}</title>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

const TONES: Record<string, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400',
  amber: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-400',
  red: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-400',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-400',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-400',
  zinc: 'bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300',
}

const STATUS_TONE: Record<string, keyof typeof TONES> = {
  active: 'green',
  paid: 'green',
  done: 'green',
  completed: 'green',
  trial: 'blue',
  open: 'blue',
  in_progress: 'blue',
  planning: 'violet',
  review: 'violet',
  overdue: 'red',
  churned: 'red',
  urgent: 'red',
  high: 'amber',
  on_hold: 'amber',
  void: 'zinc',
  todo: 'zinc',
  low: 'zinc',
  medium: 'blue',
  free: 'zinc',
  starter: 'blue',
  pro: 'violet',
  enterprise: 'amber',
  owner: 'amber',
  admin: 'violet',
  member: 'blue',
  viewer: 'zinc',
}

export function Badge({ value, tone }: { value: string; tone?: keyof typeof TONES }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONES[tone ?? STATUS_TONE[value] ?? 'zinc'],
      )}
    >
      {titleCase(value)}
    </span>
  )
}

export function Avatar({ name, color, size = 28 }: { name: string; color?: string; size?: number }) {
  return (
    <span
      title={name}
      className="inline-flex shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
      style={{ width: size, height: size, background: color ?? '#6366f1' }}
    >
      {initials(name)}
    </span>
  )
}

export function Stat({ label, value, hint, testId }: { label: string; value: ReactNode; hint?: ReactNode; testId?: string }) {
  return (
    <div className="card p-4" data-testid={testId}>
      <div className="text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</div>}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cx('inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent', className)}
    />
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-zinc-200/70 dark:bg-zinc-800', className)} />
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-zinc-500">{children}</div>
}

/** Native <dialog> based modal. */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
    >
      {open && (
        <div className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{title}</h2>
            <button className="btn-ghost px-2" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  )
}

export function Toaster() {
  const toasts = useToasts()
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={cx(
            'pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-lg',
            t.kind === 'error'
              ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100'
              : 'border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900',
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-medium">{t.title}</div>
              {t.description && <div className="mt-0.5 text-xs opacity-80">{t.description}</div>}
            </div>
            <button className="text-xs opacity-60 hover:opacity-100" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (v: T) => void
  label?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-700"
    >
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-md px-2.5 py-1 text-xs font-medium',
            o.value === value
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
              : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Multi-select rendered as toggle chips. */
export function ChipFilter<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly T[]
  value: readonly T[]
  onChange: (v: T[]) => void
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-1">
      <legend className="sr-only">{label}</legend>
      <span className="mr-1 text-xs font-medium text-zinc-500">{label}:</span>
      {options.map((o) => {
        const on = value.includes(o)
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== o) : [...value, o])}
            className={cx(
              'rounded-full border px-2 py-0.5 text-xs',
              on
                ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-100'
                : 'border-zinc-200 text-zinc-600 hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-300',
            )}
          >
            {titleCase(o)}
          </button>
        )
      })}
    </fieldset>
  )
}
