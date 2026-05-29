import { PrismaClient } from '../generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

function createPrismaClient() {
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
