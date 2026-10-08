import { createHash, randomBytes } from 'node:crypto'
import type { Me, Permission, Role, User } from '../../shared/domain.ts'
import type { DB } from '../db/schema.ts'
import { hashPassword, verifyPassword } from './password.ts'

export const SESSION_COOKIE = 'sid'
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000

const userSelect = `id, name, email, role, title, avatar_color AS "avatarColor", active, created_at AS "createdAt"`
const toUser = (r: any): User => ({ ...r, active: !!r.active })

/** Verified against when the user is unknown or inactive, so every login attempt costs one scrypt (no timing oracle). */
let dummyHash: string | undefined
const DUMMY_HASH = () => (dummyHash ??= hashPassword(randomBytes(16).toString('hex')))

/** Verify credentials; returns the user (without hash) or undefined. */
export function authenticate(db: DB, email: string, password: string): User | undefined {
  const row = db.prepare(`SELECT ${userSelect}, password_hash AS hash FROM users WHERE email = ? COLLATE NOCASE`).get(email) as
    | (User & { hash: string })
    | undefined
  const ok = verifyPassword(password, row?.hash ?? DUMMY_HASH())
  if (!row || !row.active || !ok) return undefined
  const { hash: _hash, ...user } = row
  return toUser(user)
}

/**
 * Session tokens are bearer secrets: only their SHA-256 is stored (sessions.id),
 * so a leaked database or backup cannot be replayed. The raw token exists only
 * in the client's cookie / Authorization header.
 */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Create a session and return its raw token (returned to the client once, never stored). */
export function createSession(db: DB, userId: number, userAgent?: string) {
  const token = randomBytes(24).toString('base64url')
  const now = new Date()
  db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)`).run(
    hashToken(token),
    userId,
    now.toISOString(),
    new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    userAgent ?? null,
  )
  return token
}

/** Delete the session for a raw token; returns its row id + owner (for the change feed), if it existed. */
export function deleteSession(db: DB, token: string) {
  return db.prepare(`DELETE FROM sessions WHERE id = ? RETURNING rowid AS id, user_id AS userId`).get(hashToken(token)) as
    | { id: number; userId: number }
    | undefined
}

/** Resolve a session token to the caller's identity, permissions (from role_permissions) and teams. */
export function resolveSession(db: DB, token: string): Me | undefined {
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.title, u.avatar_color AS "avatarColor", u.active, u.created_at AS "createdAt"
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.active = 1`,
    )
    .get(hashToken(token), new Date().toISOString())
  if (!row) return undefined
  return loadMe(db, toUser(row))
}

export function loadMe(db: DB, user: User): Me {
  const permissions = (
    db
      .prepare(`SELECT permission_id AS p FROM role_permissions WHERE role_id = ? ORDER BY permission_id`)
      .all(user.role) as Array<{ p: Permission }>
  ).map((r) => r.p)
  const teamIds = (
    db.prepare(`SELECT team_id AS t FROM team_members WHERE user_id = ? ORDER BY team_id`).all(user.id) as Array<{ t: number }>
  ).map((r) => r.t)
  return { user, permissions, teamIds }
}

export const isPrivilegedRole = (role: Role) => role === 'owner' || role === 'admin'
