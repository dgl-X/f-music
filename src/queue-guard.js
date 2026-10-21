// Shared for the entire job; exclusive for recovery. Independent jobs stay parallel.
export function guardQueue(db, queue, exclusive, callback) {
  return db.withQueueLock ? db.withQueueLock(queue, exclusive, callback) : callback();
}
