import { and, eq, isNull, max } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function nextEpisodeNumber(tx: Transaction, dramaId: number) {
  const row = tx.select({ number: max(schema.episodes.episodeNumber) })
    .from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, dramaId), isNull(schema.episodes.deletedAt)))
    .get()
  return (row?.number ?? 0) + 1
}
