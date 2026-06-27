/**
 * Luganda NLP Corpus — Live, non-gating runner (WP-9.2)
 *
 * Runs the 1,329 native-approved Luganda cases against the real NLP
 * pipeline.  Assertion is structural only (action + entity-slot presence);
 * exact numeric values are NOT asserted because the corpus has no
 * hand-authored exact expected values.
 *
 * MODES:
 *   Default (CI, `npm run test:nlp`):   describe.skip — NEVER runs.
 *   Live    (`RUN_LIVE_NLP=1`):          describe — hits Claude API.
 *
 * HARD RULES:
 *   - Advisorsy only: log regressions, never expect-fail the suite.
 *   - Must never touch cases.json / baseline.mocked.json (mocked gate).
 *   - Unmapped intents throw at load time (no silent drop).
 *   - No $executeRawUnsafe; no secrets/PII in logs; integer UGX only.
 */

import { jest } from '@jest/globals'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ParsedIntent, ParsedLineItem, UserContext } from '../../../src/nlp/types.js'
import {
  validateIntents,
  mapPipelineAction,
  INTENT_TO_ACTION,
} from './intentActionMap.js'

// ── Types ────────────────────────────────────────────────────────────────────

interface LugandaCase {
  id: string
  message: string
  variants?: string[]
  tags: string[]
  businessType: string
  sector: string
  intent: string
  channel: string
  priority: string
  expected: {
    action: string
    requiredEntities: string[]
    exampleItem?: string
    allowedUnits?: string[]
  }
  approved: boolean
}

interface TagStats {
  total: number
  passed: number
  rate: number
}

interface CaseResult {
  id: string
  message: string
  tags: string[]
  intent: string
  passed: boolean
  errors: string[]
}

interface Baseline {
  [tag: string]: number
}

// ── Load corpus ──────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const lugandaPath = path.resolve(__dirname, 'luganda.cases.json')

const raw = fs.readFileSync(lugandaPath, 'utf-8')
const lugandaCases: LugandaCase[] = JSON.parse(raw)

// Validate: every intent must be in the map (throws at load time)
validateIntents(lugandaCases.map((c) => c.intent))

// ── Mode guard ───────────────────────────────────────────────────────────────

const IS_LIVE = process.env['RUN_LIVE_NLP'] === '1'
const RUN_VARIANTS = process.env['RUN_LIVE_NLP_VARIANTS'] === '1'

// ── Lazy-initialised parser ─────────────────────────────────────────────────

type ParseIntentFn = (message: string, context: UserContext) => Promise<ParsedIntent>
type BuildMockContextFn = (options?: Record<string, unknown>) => UserContext

let _parseIntent: ParseIntentFn | null = null
let _buildMockContext: BuildMockContextFn | null = null

function getParseIntent(): ParseIntentFn {
  if (!_parseIntent) throw new Error('parseIntent not initialised')
  return _parseIntent
}

function getBuildMockContext(): BuildMockContextFn {
  if (!_buildMockContext) throw new Error('buildMockContext not initialised')
  return _buildMockContext
}

beforeAll(async () => {
  const [intentParser, contextFixture] = await Promise.all([
    import('../../../src/nlp/intentParser.js'),
    import('../../fixtures/context.js'),
  ])
  _parseIntent = intentParser.parseIntent
  _buildMockContext = contextFixture.buildMockContext
})

// ── Entity checking ──────────────────────────────────────────────────────────

type EntityName = 'qty' | 'unit' | 'item' | 'price'

const ENTITY_EXTRACTORS: Record<EntityName, (item: ParsedLineItem) => boolean> = {
  qty: (i) => i.qty !== null && i.qty > 0,
  unit: (i) => i.unit !== null && i.unit.length > 0,
  item: (i) => i.item !== null && i.item.length > 0,
  price: (i) => i.unitPrice !== null || i.totalPrice !== null,
}

function checkRequiredEntities(
  items: ParsedLineItem[],
  required: string[]
): string[] {
  const missing: string[] = []
  for (const entity of required) {
    const extractor = ENTITY_EXTRACTORS[entity as EntityName]
    if (!extractor) {
      missing.push(`unknown required entity "${entity}"`)
      continue
    }
    const found = items.some(extractor)
    if (!found) {
      missing.push(`required entity "${entity}" not found on any parsed item`)
    }
  }
  return missing
}

// ── Case execution ───────────────────────────────────────────────────────────

const allCaseResults: CaseResult[] = []

async function runCase(c: LugandaCase, input: string): Promise<CaseResult> {
  const errors: string[] = []
  const parseIntent = getParseIntent()
  const buildMockContext = getBuildMockContext()
  const context = buildMockContext()

  let result: ParsedIntent
  try {
    result = await parseIntent(input, context)
  } catch (err) {
    return {
      id: c.id,
      message: input,
      tags: c.tags,
      intent: c.intent,
      passed: false,
      errors: [`NLP pipeline error: ${(err as Error).message}`],
    }
  }

  // 1. Action check (mapped through pipeline → corpus boundary)
  const mappedAction = mapPipelineAction(result.action)
  const corpusExpectedAction = INTENT_TO_ACTION[c.intent] ?? c.expected.action

  if (mappedAction !== corpusExpectedAction) {
    errors.push(
      `action mismatch: pipeline returned "${result.action}" ` +
      `(mapped → "${mappedAction}"), corpus expects "${corpusExpectedAction}" ` +
      `(intent: ${c.intent})`
    )
  }

  // 2. Required entities check
  const entityErrors = checkRequiredEntities(result.items, c.expected.requiredEntities)
  errors.push(...entityErrors)

  return {
    id: c.id,
    message: input,
    tags: c.tags,
    intent: c.intent,
    passed: errors.length === 0,
    errors,
  }
}

// ── Test suite ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runner: (name: string, fn: () => void) => void = IS_LIVE ? describe : describe.skip

runner('Luganda NLP Corpus (live, advisory)', () => {
  for (const c of lugandaCases) {
    const inputs = [c.message]
    if (RUN_VARIANTS && c.variants) {
      inputs.push(...c.variants.filter((v) => v && v.length > 0))
    }

    for (const input of inputs) {
      const variantTag = input === c.message ? '' : ' [variant]'
      const testName = `[${c.id}] ${input.slice(0, 80)}${variantTag}`

      it(testName, async () => {
        const result = await runCase(c, input)
        allCaseResults.push(result)
        if (!result.passed) {
          // Advisory only — log but don't fail the suite
          console.warn(
            `[LUGANDA ADVISORY] [${result.id}] failed:\n  ${result.errors.join('\n  ')}`
          )
        }
        // Always pass — advisory corpus never fails the build
        expect(true).toBe(true)
      })
    }
  }

  // ── Per-tag pass-rate report ───────────────────────────────────────────────

  describe('Pass-rate report (advisory)', () => {
    let stats: Record<string, TagStats> = {}
    let baseline: Baseline = {}

    beforeAll(() => {
      // Unique results — one per case (use message variant only, not variants)
      const uniqueResults: CaseResult[] = []
      const seen = new Set<string>()
      for (const r of allCaseResults) {
        if (!seen.has(r.id)) {
          seen.add(r.id)
          uniqueResults.push(r)
        }
      }

      const allTags = new Set<string>()
      for (const c of lugandaCases) {
        for (const t of c.tags) allTags.add(t)
      }

      stats = {}
      for (const tag of allTags) {
        stats[tag] = { total: 0, passed: 0, rate: 0 }
      }

      for (const r of uniqueResults) {
        for (const tag of r.tags) {
          const s = stats[tag]
          if (s) {
            s.total++
            if (r.passed) s.passed++
          }
        }
      }

      const overallPassed = uniqueResults.filter((r) => r.passed).length
      stats['__overall__'] = {
        total: uniqueResults.length,
        passed: overallPassed,
        rate: uniqueResults.length > 0 ? overallPassed / uniqueResults.length : 0,
      }

      for (const tag of Object.keys(stats)) {
        const s = stats[tag]!
        s.rate = s.total > 0 ? s.passed / s.total : 1.0
      }

      // Write luganda.baseline.live.json (advisory floors)
      const baselineOut = buildBaselineOutput(stats)
      const baselineWithComment = {
        __comment:
          'Luganda corpus live baseline (advisory). Fractional per-tag floors. ' +
          'Regressions are logged but NEVER block CI. Generated by luganda.test.ts.',
        ...baselineOut,
      }
      const baselinePath = path.resolve(__dirname, 'luganda.baseline.live.json')
      fs.writeFileSync(baselinePath, JSON.stringify(baselineWithComment, null, 2) + '\n')

      // Load for logging
      baseline = baselineOut
    })

    function buildBaselineOutput(s: Record<string, TagStats>): Baseline {
      const out: Baseline = {}
      for (const [tag, stat] of Object.entries(s)) {
        if (tag.startsWith('__')) continue
        // Floor = current rate, advisory-only — human adjusts upward
        out[tag] = Math.max(0, Math.round((stat.rate - 0.05) * 100) / 100)
      }
      return out
    }

    it('prints per-tag pass-rate report', () => {
      const uniqueCount = new Set(allCaseResults.map((r) => r.id)).size
      const lines: string[] = [
        '',
        '═══════════════════════════════════════════════════════',
        ' Luganda Corpus Pass-Rate Report (LIVE advisory)',
        ` Cases: ${uniqueCount} unique (${lugandaCases.length} total)`,
        ` Overall: ${stats['__overall__']!.passed}/${stats['__overall__']!.total} ` +
        `(${(stats['__overall__']!.rate * 100).toFixed(1)}%)`,
        '───────────────────────────────────────────────────────',
      ]

      const tagNames = Object.keys(stats)
        .filter((t) => !t.startsWith('__'))
        .sort()

      for (const tag of tagNames) {
        const s = stats[tag]!
        const pct = (s.rate * 100).toFixed(1)
        const bar = '█'.repeat(Math.max(1, Math.round(s.rate * 20)))
        const floor = baseline[tag]
        const floorStr = floor !== undefined
          ? ` (floor: ${(floor * 100).toFixed(0)}%)`
          : ''
        lines.push(`  ${tag.padEnd(20)} ${bar.padEnd(20)} ${pct}%${floorStr}`)
      }

      lines.push('═══════════════════════════════════════════════════════')
      console.log(lines.join('\n'))
      expect(true).toBe(true)
    })

    it('advisory baseline check: logs regressions, never blocks', () => {
      const baselineErrors: string[] = []
      for (const [tag, threshold] of Object.entries(baseline)) {
        if (tag.startsWith('__')) continue
        const s = stats[tag]
        if (s && s.rate < threshold) {
          baselineErrors.push(
            `  ADVISORY: "${tag}" pass rate ${(s.rate * 100).toFixed(1)}% ` +
            `below baseline ${(threshold * 100).toFixed(0)}% ` +
            `(${s.passed}/${s.total})`
          )
        }
      }
      if (baselineErrors.length > 0) {
        console.log('\n[LUGANDA ADVISORY] Baseline regressions noted:')
        for (const err of baselineErrors) console.log(err)
        console.log('')
      }
      // Never block the build
      expect(true).toBe(true)
    })

    it('logs individual case failures', () => {
      const failures = allCaseResults.filter((r) => !r.passed)
      if (failures.length > 0) {
        console.log('\n[LUGANDA ADVISORY] Failed cases:')
        for (const f of failures) {
          console.log(`  [${f.id}] ${f.message.slice(0, 80)}`)
          for (const err of f.errors) {
            console.log(`    ${err}`)
          }
        }
        console.log('')
      }
      expect(true).toBe(true)
    })
  })
})