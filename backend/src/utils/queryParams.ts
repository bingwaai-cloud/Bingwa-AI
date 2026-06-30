import { z } from 'zod'
import { AppError, ErrorCodes } from './AppError.js'

export const SortOrderSchema = z.enum(['asc', 'desc']).default('asc')
export const PaginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(20),
})

export const DateRangeQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_RANGE_DAYS = 90

export interface BoundedDateRange {
  from: Date
  to: Date
}

export function boundedDateRange(
  params: { from?: Date; to?: Date },
  defaultDays = 30,
  now = new Date()
): BoundedDateRange {
  const to = params.to ?? now
  const from = params.from ?? new Date(to.getTime() - (defaultDays - 1) * DAY_MS)

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid date range', 400)
  }

  const spanDays = Math.floor((to.getTime() - from.getTime()) / DAY_MS) + 1
  if (spanDays > MAX_RANGE_DAYS) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Date range cannot exceed 90 days', 400)
  }

  return { from, to }
}

export type SummaryGroupBy = 'day' | 'week' | 'month'

export const SummaryGroupBySchema = z.enum(['day', 'week', 'month']).default('day')
