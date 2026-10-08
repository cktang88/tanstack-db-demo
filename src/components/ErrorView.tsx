import { useQueryErrorResetBoundary } from '@tanstack/react-query'
import { useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { HttpError } from '../lib/api'

export function ErrorView({ error: rawError, reset }: ErrorComponentProps) {
  const error = rawError instanceof Error ? rawError : new Error(String(rawError))
  const router = useRouter()
  const { reset: resetQueries } = useQueryErrorResetBoundary()
  const notFound = error instanceof HttpError && error.status === 404
  return (
    <div className="card mx-auto mt-10 max-w-md p-6 text-center" role="alert">
      <div className="text-lg font-semibold">{notFound ? 'Not found' : 'Something went wrong'}</div>
      <p className="mt-2 text-sm text-zinc-500">{error.message}</p>
      <button
        className="btn-secondary mt-4"
        onClick={() => {
          resetQueries()
          reset()
          void router.invalidate()
        }}
      >
        Try again
      </button>
    </div>
  )
}
