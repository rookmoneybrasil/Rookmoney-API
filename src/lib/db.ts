import { PrismaClient } from '../generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { runDataMigrations } from './data-migrations'

function createPrismaClient() {
  // Fix 1: scope SSL/TLS to DB connection only (Railway uses self-signed certs).
  // This replaces the global NODE_TLS_REJECT_UNAUTHORIZED=0 env var which was
  // disabling certificate verification for ALL outgoing requests (Stripe, Resend, etc.).
  const isProduction = process.env.NODE_ENV === 'production'
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
    ...(isProduction ? { ssl: { rejectUnauthorized: false } } : {}),
  })
  return new PrismaClient({ adapter })
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

export const db =
  process.env.NODE_ENV === 'production'
    ? (globalForPrisma.prisma ?? (globalForPrisma.prisma = createPrismaClient()))
    : createPrismaClient()

runDataMigrations(db).catch((err) => console.error('[data-migration] startup error:', err))
