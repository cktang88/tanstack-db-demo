import { field } from '../lib/format'
import { useQuery } from '@tanstack/react-query'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Badge } from '../components/ui'
import { demoUsersQuery, useLogin } from '../lib/auth'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <button className="btn-primary w-full" disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  )
}

export function LoginPage() {
  const login = useLogin()
  const { data: demo = [] } = useQuery(demoUsersQuery())
  const [error, action] = useActionState(async (_: string | null, form: FormData) => {
    try {
      await login.mutateAsync({ email: field(form, 'email'), password: field(form, 'password') })
      return null
    } catch (e) {
      return (e as Error).message
    }
  }, null)

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-6 dark:bg-zinc-950">
      <title>Sign in · Saasly</title>
      <div className="card w-full max-w-md p-6">
        <div className="mb-6 flex items-center gap-2 text-lg font-semibold">
          <span className="inline-flex size-7 items-center justify-center rounded-lg bg-brand-600 text-sm text-white">S</span>
          Sign in to Saasly
        </div>
        <form action={action} className="space-y-3">
          <label className="block">
            <span className="label">Email</span>
            <input name="email" type="email" className="input" autoComplete="username" defaultValue="owner@saasly.dev" />
          </label>
          <label className="block">
            <span className="label">Password</span>
            <input name="password" type="password" className="input" autoComplete="current-password" defaultValue="password" />
          </label>
          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
          <Submit />
        </form>
        <div className="mt-6">
          <div className="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">Demo accounts (password: password)</div>
          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {demo.map((u) => (
              <li key={u.email}>
                <button
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  onClick={() => login.mutate({ email: u.email, password: u.password })}
                  aria-label={`Sign in as ${u.role}`}
                >
                  <span>
                    <span className="font-medium">{u.name}</span> <span className="text-xs text-zinc-500">{u.email}</span>
                  </span>
                  <Badge value={u.role} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
