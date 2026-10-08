import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from '@tanstack/react-db'
import { useActionState } from 'react'
import { Card, PageHeader, Segmented } from '../components/ui'
import { applyChange } from '../db/live'
import { usePrefs } from '../db/hooks'
import { pinsCollection, sessionsCollection } from '../db/collections'
import { useCan } from '../lib/auth'
import { relative } from '../lib/format'
import { api } from '../lib/api'
import { toast } from '../lib/toast'

interface Chaos {
  latencyMs: number
  failRate: number
}

export function SettingsPage() {
  const [prefs, setPrefs] = usePrefs()
  const { can } = useCan()
  return (
    <>
      <PageHeader
        title="Settings"
        description="Preferences live in a localStorage collection — open two tabs and watch them sync."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Appearance">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm">Theme</span>
              <Segmented
                label="Theme"
                value={prefs.theme}
                options={[
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
                onChange={(theme) => setPrefs({ theme })}
              />
            </div>
            <label className="flex items-center justify-between text-sm">
              Wide layout
              <input type="checkbox" checked={prefs.compact} onChange={(e) => setPrefs({ compact: e.target.checked })} />
            </label>
            <label className="flex items-center justify-between text-sm">
              Clear pinned accounts
              <button className="btn-secondary" onClick={() => pinsCollection.utils.clearStorage()}>
                Clear
              </button>
            </label>
          </div>
        </Card>
        <SessionsCard />
        {can('admin:dev') && <ChaosCard />}
        {can('admin:dev') && <ResetCard />}
      </div>
    </>
  )
}

// Non-entity server state (dev settings) stays on plain TanStack Query —
// DB and Query coexist, so adoption can be incremental.
function ChaosCard() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['dev', 'chaos'], queryFn: () => api.get<Chaos>('/dev/chaos') })
  const [, action, pending] = useActionState(async (_prev: Chaos | null, form: FormData) => {
    const next = await api.put<Chaos>('/dev/chaos', {
      latencyMs: Number(form.get('latencyMs')),
      failRate: Number(form.get('failRate')) / 100,
    })
    qc.setQueryData(['dev', 'chaos'], next)
    toast.success('Network conditions updated')
    return next
  }, null)
  if (!data) return null
  return (
    <Card title="Network simulation">
      <form action={action} className="space-y-4" key={`${data.latencyMs}-${data.failRate}`}>
        <label className="block text-sm">
          <span className="label">Artificial API latency (ms)</span>
          <input name="latencyMs" type="number" min={0} max={5000} step={50} defaultValue={data.latencyMs} className="input" />
        </label>
        <label className="block text-sm">
          <span className="label">Mutation failure rate (%)</span>
          <input
            name="failRate"
            type="number"
            min={0}
            max={100}
            defaultValue={Math.round(data.failRate * 100)}
            className="input"
          />
        </label>
        <button className="btn-primary" disabled={pending}>
          {pending ? 'Saving…' : 'Apply'}
        </button>
      </form>
    </Card>
  )
}

function ResetCard() {
  const reset = useMutation({
    mutationFn: () => api.post('/dev/reset', {}),
    onSuccess: async () => {
      await applyChange({ kind: 'reset' })
      toast.success('Database re-seeded')
    },
  })
  return (
    <Card title="Demo data">
      <p className="mb-3 text-sm text-zinc-500">Re-seed the SQLite database with deterministic demo data.</p>
      <button className="btn-danger" onClick={() => reset.mutate()} disabled={reset.isPending}>
        {reset.isPending ? 'Resetting…' : 'Reset database'}
      </button>
    </Card>
  )
}

function SessionsCard() {
  // the server scopes `sessions` to the caller (ownerField), so this is "my sessions"
  const { data: sessions } = useLiveQuery({
    query: (q) => q.from({ s: sessionsCollection }).orderBy(({ s }) => s.createdAt, 'desc'),
  })
  return (
    <Card title="Your sessions">
      <ul className="space-y-2 text-sm" data-testid="sessions">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              {s.userAgent?.slice(0, 40) ?? 'unknown client'}{' '}
              <span className="text-xs text-zinc-500">· signed in {relative(s.createdAt)}</span>
            </span>
            <button
              className="btn-ghost text-xs"
              onClick={() =>
                sessionsCollection
                  .delete(s.id)
                  .when('settled')
                  .catch((e: Error) => toast.error('Could not revoke session', e.message))
              }
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
