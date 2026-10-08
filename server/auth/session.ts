import { randomBytes } from 'node:crypto'
import type { Me, Permission, Role, User } from '../../shared/domain.ts'
import type { DB } from '../db/schema.ts'
import { verifyPassword } from './password.ts'

export const SESSION_COOKIE = 'sid'
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000

const userSelect = `id, name, email, role, title, avatar_color AS "avatarColor", active, created_at AS "createdAt"`
const toUser = (r: any): User => ({ ...r, active: !!r.active })

/** Verify credentials; returns the user (without hash) or undefined. */
export function authenticate(db: DB, email: string, password: string): User | undefined {
  const row = db.prepare(`SELECT ${userSelect}, password_hash AS hash FROM users WHERE email = ? COLLATE NOCASE`).get(email) as
    | (User & { hash: string })
    | undefined
  if (!row || !row.active || !verifyPassword(password, row.hash)) return undefined
  const { hash: _hash, ...user } = row
  return toUser(user)
}

export function createSession(db: DB, userId: number, userAgent?: string) {
  const id = randomBytes(24).toString('base64url')
  const now = new Date()
  db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    userId,
    now.toISOString(),
    new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    userAgent ?? null,
  )
  return id
}

export function deleteSession(db: DB, id: string) {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
}

/** Resolve a session token to the caller's identity, permissions (from role_permissions) and teams. */
export function resolveSession(db: DB, token: string): Me | undefined {
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.title, u.avatar_color AS "avatarColor", u.active, u.created_at AS "createdAt"
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.active = 1`,
    )
    .get(token, new Date().toISOString())
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
