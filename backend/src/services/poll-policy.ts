const TRANSIENT_POLL_STATUSES = new Set([408, 409, 425, 429])

export function isRetryablePollStatus(status: number): boolean {
  return status >= 500 || TRANSIENT_POLL_STATUSES.has(status)
}
