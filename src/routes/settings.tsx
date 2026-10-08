import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useActionState } from 'react'
import { Card, PageHeader, Segmented } from '../components/ui'
import { applyChange } from '../db/live'
import { usePrefs } from '../db/hooks'
import { pinsCollection } from '../db/collections'
import { api } from '../lib/api'
import { toast } from '../lib/toast'

interface Chaos {
  latencyMs: number
  failRate: number
}

export function SettingsPage() {
  const [prefs, setPrefs] = usePrefs()
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
        <ChaosCard />
        <ResetCard />
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
