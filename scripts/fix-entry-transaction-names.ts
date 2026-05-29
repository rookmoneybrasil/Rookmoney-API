import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
  const db = new PrismaClient({ adapter })

  const entries = await db.personEntry.findMany({
    where:   { settledTransactionId: { not: null } },
    include: { person: { select: { name: true } } },
  })

  console.log(`Found ${entries.length} settled entries with transactions`)

  let updated = 0
  for (const entry of entries) {
    const newDescription = `${entry.description} (${entry.person.name})`
    await db.transaction.updateMany({
      where: { id: entry.settledTransactionId! },
      data:  { description: newDescription },
    })
    console.log(`  ✓ "${newDescription}"`)
    updated++
  }

  console.log(`\nDone — ${updated} transactions updated.`)
  await db.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
