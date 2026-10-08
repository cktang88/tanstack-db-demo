import { useLiveQuery } from '@tanstack/react-db'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { COUNTRIES, CUSTOMER_STATUSES, PLANS, type Customer } from '../../shared/domain'
import { titleCase } from '../lib/format'
import { usersCollection } from '../db/collections'
import { decodeCustomerForm, type CustomerFormValues } from '../lib/validation'

interface Props {
  initial?: Partial<Customer>
  submitLabel: string
  onSubmit: (values: CustomerFormValues) => Promise<unknown>
  onDone?: () => void
  /**
   * Only owners/admins may (re)assign the account owner: the server forces
   * ownerId = self on create and rejects reassignment by members.
   */
  canAssignOwner?: boolean
}

// `attempt` keys the <form>: React resets uncontrolled forms after every action,
// and a reset <select> falls back to the option selected when it was first
// mounted (text inputs pick up the new defaultValue, selects don't). Remounting
// with the submitted values as defaults keeps plan/status/country/owner intact.
type State = { errors: Record<string, string>; values: Record<string, string>; attempt: number }

function SubmitButton({ label }: { label: string }) {
  // React 19 useFormStatus reads the parent <form>'s pending state
  const { pending } = useFormStatus()
  return (
    <button className="btn-primary" disabled={pending}>
      {pending ? 'Saving…' : label}
    </button>
  )
}

export function CustomerForm({ initial, submitLabel, onSubmit, onDone, canAssignOwner = true }: Props) {
  const { data: users } = useLiveQuery({ query: (q) => q.from({ u: usersCollection }).orderBy(({ u }) => u.name) })
  const [state, action] = useActionState<State, FormData>(
    async (prev, form) => {
      // trim before validating ("Acme " would fail the schema's Trimmed check)
      const raw: Record<string, string> = {}
      for (const [k, val] of form) if (typeof val === 'string') raw[k] = val.trim()
      const attempt = prev.attempt + 1
      const result = decodeCustomerForm(raw)
      if (!result.ok) return { errors: result.errors, values: raw, attempt }
      try {
        await onSubmit(result.value)
        onDone?.()
        return { errors: {}, values: {}, attempt }
      } catch (e) {
        return { errors: { form: (e as Error).message }, values: raw, attempt }
      }
    },
    { errors: {}, values: {}, attempt: 0 },
  )
  const v = (k: keyof Customer) => state.values[k] ?? (initial?.[k] != null ? String(initial[k]) : '')
  const err = (k: string) => state.errors[k] && <p className="mt-1 text-xs text-red-600">{state.errors[k]}</p>

  return (
    <form key={state.attempt} action={action} className="grid grid-cols-2 gap-3" noValidate>
      <label className="col-span-2">
        <span className="label">Company</span>
        <input name="company" className="input" defaultValue={v('company')} />
        {err('company')}
      </label>
      <label>
        <span className="label">Contact name</span>
        <input name="name" className="input" defaultValue={v('name')} />
        {err('name')}
      </label>
      <label>
        <span className="label">Email</span>
        <input name="email" type="email" className="input" defaultValue={v('email')} />
        {err('email')}
      </label>
      <label>
        <span className="label">Plan</span>
        <select name="plan" className="input" defaultValue={v('plan') || 'starter'}>
          {PLANS.map((p) => (
            <option key={p} value={p}>
              {titleCase(p)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Status</span>
        <select name="status" className="input" defaultValue={v('status') || 'trial'}>
          {CUSTOMER_STATUSES.map((p) => (
            <option key={p} value={p}>
              {titleCase(p)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Seats</span>
        <input name="seats" type="number" min={1} className="input" defaultValue={v('seats') || '1'} />
        {err('seats')}
      </label>
      <label>
        <span className="label">Country</span>
        <select name="country" className="input" defaultValue={v('country') || 'US'}>
          {COUNTRIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      {/* a disabled <select> isn't submitted: send the fixed value via a hidden input */}
      {!canAssignOwner && <input type="hidden" name="ownerId" value={v('ownerId')} />}
      <label className="col-span-2">
        <span className="label">Account owner</span>
        <select
          name={canAssignOwner ? 'ownerId' : undefined}
          className="input"
          defaultValue={v('ownerId')}
          disabled={!canAssignOwner}
        >
          <option value="">Unassigned</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      {state.errors.form && <p className="col-span-2 text-sm text-red-600">{state.errors.form}</p>}
      <div className="col-span-2 flex justify-end gap-2 pt-2">
        <SubmitButton label={submitLabel} />
      </div>
    </form>
  )
}
