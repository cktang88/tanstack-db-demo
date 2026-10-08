import { Schema } from 'effect'
import { CustomerForm } from '../../shared/schemas'

// Client-side validation re-uses the exact Effect Schema the server enforces,
// exposed through the Standard Schema interface.
const customerForm = Schema.toStandardSchemaV1(CustomerForm)
export type CustomerFormValues = typeof CustomerForm.Type

export type Decoded<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> }

export function decodeCustomerForm(raw: Record<string, unknown>): Decoded<CustomerFormValues> {
  const result = customerForm['~standard'].validate(raw)
  if (result instanceof Promise) throw new Error('unexpected async schema')
  if (!result.issues) return { ok: true, value: result.value as CustomerFormValues }
  const errors: Record<string, string> = {}
  for (const issue of result.issues) {
    const seg = issue.path?.[0]
    const key = seg === undefined ? 'form' : typeof seg === 'object' ? String(seg.key) : String(seg)
    errors[key] ??= issue.message
  }
  return { ok: false, errors }
}
