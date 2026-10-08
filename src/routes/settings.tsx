import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useActionState } from 'react'
import { Card, PageHeader, Segmented } from '../components/ui'
import { api } from '../lib/api'
import { useCan } from '../lib/auth'
import { relative } from '../lib/format'
import { useRevokeSession } from '../lib/mutations'
import { sessionsQuery } from '../lib/queries'
import { useSettings } from '../lib/settings'
import { toast } from '../lib/toast'

interface Chaos {
  latencyMs: number
  failRate: number
}

export function SettingsPage() {
  const [settings, setSettings] = useSettings()
  const { can } = useCan()
  return (
    <>
      <PageHeader title="Settings" description="Workspace preferences and developer tools." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Appearance">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm">Theme</span>
              <Segmented
                label="Theme"
                value={settings.theme}
                options={[
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
                onChange={(theme) => setSettings({ theme })}
              />
            </div>
            <label className="flex items-center justify-between text-sm">
              Wide layout
              <input type="checkbox" checked={settings.compact} onChange={(e) => setSettings({ compact: e.target.checked })} />
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

/** Simulated network conditions — lets you see optimistic updates + rollbacks in action. */
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
  const qc = useQueryClient()
  const reset = useMutation({
    mutationFn: () => api.post('/dev/reset', {}),
    onSuccess: async () => {
      await qc.resetQueries()
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
  const { data: sessions = [] } = useQuery(sessionsQuery())
  const revoke = useRevokeSession()
  return (
    <Card title="Your sessions">
      <ul className="space-y-2 text-sm" data-testid="sessions">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              {s.userAgent?.slice(0, 40) ?? 'unknown client'}{' '}
              <span className="text-xs text-zinc-500">· signed in {relative(s.createdAt)}</span>
            </span>
            <button className="btn-ghost text-xs" onClick={() => revoke.mutate(s.id)}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
