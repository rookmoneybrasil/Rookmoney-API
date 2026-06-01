import { PrismaClient } from '../generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { runDataMigrations } from './data-migrations'

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
  return new PrismaClient({ adapter })
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

export const db =
  process.env.NODE_ENV === 'production'
    ? (globalForPrisma.prisma ?? (globalForPrisma.prisma = createPrismaClient()))
    : createPrismaClient()

// Run data migrations on first import (once per server process).
// Uses an in-memory flag + DataMigration table to ensure each migration
// runs exactly once, even across deploys.
runDataMigrations(db).catch((err) => console.error('[data-migration] startup error:', err))
