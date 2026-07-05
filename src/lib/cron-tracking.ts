import { db } from './db'

// Records one CronRun row per full invocation of a cron handler (not per
// sub-task) — coarse but enough to answer "did it run, when, did it fail"
// from the backoffice instead of digging through Railway logs.
export async function trackCronRun<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = new Date()
  try {
    const result = await fn()
    await db.cronRun.create({
      data: {
        name, status: 'success', startedAt, finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
        meta: result === undefined ? undefined : (result as object),
      },
    }).catch(e => console.error('[cron-tracking] failed to record success:', e))
    return result
  } catch (e) {
    await db.cronRun.create({
      data: {
        name, status: 'error', startedAt, finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
        error: e instanceof Error ? e.message : String(e),
      },
    }).catch(err => console.error('[cron-tracking] failed to record error:', err))
    throw e
  }
}
