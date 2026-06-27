/**
 * NLP Regression Corpus Runner
 *
 * Runs all cases from corpus/cases.json against the full intent-parsing
 * pipeline (parseIntent -> normalizeParsedIntent -> resolveIntent).
 *
 * MODES:
 *   Mocked (default, CI):          intercepts @anthropic-ai/sdk and returns
 *                                  each case's mockResponse. Deterministic.
 *   Live   (RUN_LIVE_NLP=1):       calls the real Claude API. Prints per-tag
 *                                  pass-rate report; never blocks CI.
 *
 * BASELINE GATING:
 *   Mocked:  baseline.mocked.json  - every tag = 1.0.  ANY drop fails CI.
 *   Live:    baseline.live.json    - fractional per-tag floors.  Never blocks.
 *
 * ITEM-MATCHER DECISION (option b):
 *   This corpus uses the sync-only path (matchItemSync). The pg_trgm fuzzy
 *   layer and tenant alias table (item_aliases) require a Postgres DB and are
 *   NOT exercised here.  Consequently, typo / shorthand / ambiguous tags
 *   validate the extraction shape and structural scoring only - they do NOT
 *   test end-to-end fuzzy resolution.  WP-6 integration tests cover that path.
 *
 * HARD RULES:
 *   - Never mark a failing case .skip to pass CI.  Flag it.
 *   - Every case MUST have a mockResponse.  Missing -> ERROR (not skip).
 *   - mockResponse is the raw LLM extraction output, NOT a copy of expected.
 */

import { jest } from '@jest/globals'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { InventoryItem, ParsedIntent, UserContext } from '../../src/nlp/types.js'

// ── Types ────────────────────────────────────────────────────────────────────

interface CorpusCase {
  id: string
  message: string
  tags: string[]
  context: { items?: InventoryItem[] }
  mockResponse: Record<string, unknown>
  expected: {
    action: string
    items: Array<{
      item: string | null
      qty: number | null
      unitPrice: number | null
      totalPrice: number | null
    }>
    resolution: string
  }
}

interface TagStats {
  total: number
  passed: number
  rate: number
}

interface Baseline {
  [tag: string]: number
}

interface CaseResult {
  id: string
  message: string
  tags: string[]
  passed: boolean
  errors: string[]
}

// ── Load corpus ──────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const corpusPath = path.resolve(__dirname, 'corpus', 'cases.json')

const raw = fs.readFileSync(corpusPath, 'utf-8')
const corpusCases: CorpusCase[] = JSON.parse(raw)

// Validate: every case MUST have a mockResponse
for (const c of corpusCases) {
  if (!c.mockResponse || typeof c.mockResponse !== 'object') {
    throw new Error(
      `Corpus case "${c.id}" is missing mockResponse. ` +
      `Every case must have a mockResponse - the raw LLM extraction output.`
    )
  }
}

// ── Mode detection ───────────────────────────────────────────────────────────

const IS_LIVE = process.env['RUN_LIVE_NLP'] === '1'

// ── Lazy-initialised parser (set in beforeAll, used in runCase) ──────────────

type ParseIntentFn = (message: string, context: UserContext) => Promise<ParsedIntent>
type BuildMockContextFn = (options?: { items?: InventoryItem[] }) => UserContext

let _parseIntent: ParseIntentFn | null = null
let _buildMockContext: BuildMockContextFn | null = null

function getParseIntent(): ParseIntentFn {
  if (!_parseIntent) throw new Error('parseIntent not initialised - run beforeAll first')
  return _parseIntent
}

function getBuildMockContext(): BuildMockContextFn {
  if (!_buildMockContext) throw new Error('buildMockContext not initialised - run beforeAll first')
  return _buildMockContext
}

// Save original env values so we can restore them
const _savedApiKey = process.env['ANTHROPIC_API_KEY']
const _savedModel = process.env['NLP_MODEL']

beforeAll(async () => {
  if (!IS_LIVE) {
    // Build the mock response lookup BEFORE mocking the module
    const mockMap = new Map<string, object>()
    for (const c of corpusCases) {
      mockMap.set(c.message, c.mockResponse)
    }

    // Use unstable_mockModule for ESM dynamic import compatibility.
    // jest.mock() is hoisted and does NOT work with dynamic import() in ESM.
    jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        messages: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          create: jest.fn().mockImplementation(async (params: any) => {
            const messages = params?.['messages'] as Array<{ role: string; content: string }> | undefined
            const userMessage: string = messages?.[0]?.content ?? ''
            const resp = mockMap.get(userMessage)
            if (!resp) {
              throw new Error(
                `No mockResponse registered for message: "${userMessage.slice(0, 80)}..."`
              )
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(resp) }],
            }
          }),
        },
      })),
    }))
  }

  // Import AFTER mocking so the module sees the mock
  const [intentParser, contextFixture] = await Promise.all([
    import('../../src/nlp/intentParser.js'),
    import('../fixtures/context.js'),
  ])
  _parseIntent = intentParser.parseIntent
  _buildMockContext = contextFixture.buildMockContext

  if (!IS_LIVE) {
    // Override env vars so parseIntent proceeds past the early-return guard
    process.env['ANTHROPIC_API_KEY'] = 'mock-key-for-corpus'
    process.env['NLP_MODEL'] = 'claude-sonnet-4-20250514'
  }
})

afterAll(() => {
  if (!IS_LIVE) {
    // Restore original env values so other test suites aren't affected
    if (_savedApiKey !== undefined) {
      process.env['ANTHROPIC_API_KEY'] = _savedApiKey
    } else {
      delete process.env['ANTHROPIC_API_KEY']
    }
    if (_savedModel !== undefined) {
      process.env['NLP_MODEL'] = _savedModel
    } else {
      delete process.env['NLP_MODEL']
    }
  }
})

// ── Case execution helper ────────────────────────────────────────────────────

const allCaseResults: CaseResult[] = []

async function runCase(c: CorpusCase): Promise<CaseResult> {
  const errors: string[] = []
  const parseIntent = getParseIntent()
  const buildMockContext = getBuildMockContext()
  const context = buildMockContext({ items: c.context.items ?? [] })

  const result = await parseIntent(c.message, context)

  // Action
  if (result.action !== c.expected.action) {
    errors.push(
      `action: expected "${c.expected.action}", got "${result.action}"`
    )
  }

  // Resolution
  if (result.resolution !== c.expected.resolution) {
    errors.push(
      `resolution: expected "${c.expected.resolution}", got "${result.resolution}"`
    )
  }

  // Items
  if (result.items.length !== c.expected.items.length) {
    errors.push(
      `items.length: expected ${c.expected.items.length}, got ${result.items.length}`
    )
  } else {
    for (let i = 0; i < c.expected.items.length; i++) {
      const exp = c.expected.items[i]!
      const act = result.items[i]!
      const prefix = `items[${i}]`

      if (exp.item !== undefined) {
        // Compare itemNormalized (the canonical inventory name) rather than
        // item (the raw LLM extraction which may be in Swahili/Luganda/slang).
        const actNorm = act.itemNormalized?.toLowerCase() ?? null
        const expNorm = exp.item?.toLowerCase() ?? null
        if (actNorm !== expNorm && act.item?.toLowerCase() !== expNorm) {
          // Fallback: also check raw item name for cases where the LLM
          // returns the canonical name directly (e.g. "gumboots" -> "gumboots").
          errors.push(`${prefix}.item: expected normalized "${expNorm}", got "${actNorm}" (raw: "${act.item}")`)
        }
      }
      if (exp.qty !== undefined && act.qty !== exp.qty) {
        errors.push(`${prefix}.qty: expected ${exp.qty}, got ${act.qty}`)
      }
      if (exp.unitPrice !== undefined && act.unitPrice !== exp.unitPrice) {
        errors.push(
          `${prefix}.unitPrice: expected ${exp.unitPrice}, got ${act.unitPrice}`
        )
      }
      if (exp.totalPrice !== undefined && act.totalPrice !== exp.totalPrice) {
        errors.push(
          `${prefix}.totalPrice: expected ${exp.totalPrice}, got ${act.totalPrice}`
        )
      }
    }
  }

  const passed = errors.length === 0
  return { id: c.id, message: c.message, tags: c.tags, passed, errors }
}

// ── Test suites ──────────────────────────────────────────────────────────────

describe('NLP Regression Corpus', () => {
  for (const c of corpusCases) {
    const testName = `[${c.id}] ${c.message}`

    if (IS_LIVE) {
      const hasKey = !!(process.env['ANTHROPIC_API_KEY'] && process.env['NLP_MODEL'])
      const testFn = hasKey ? it : it.skip
      testFn(testName, async () => {
        const result = await runCase(c)
        allCaseResults.push(result)
        if (!result.passed) {
          throw new Error(`[${result.id}] failed:\n  ${result.errors.join('\n  ')}`)
        }
      })
    } else {
      it(testName, async () => {
        const result = await runCase(c)
        allCaseResults.push(result)
        if (!result.passed) {
          throw new Error(`[${result.id}] failed:\n  ${result.errors.join('\n  ')}`)
        }
      })
    }
  }

  // ── Per-tag pass-rate report ─────────────────────────────────────────────

  describe('Pass-rate report', () => {
    let stats: Record<string, TagStats> = {}
    let baseline: Baseline = {}
    let baselineErrors: string[] = []

    beforeAll(() => {
      // Collect all unique tags
      const allTags = new Set<string>()
      for (const c of corpusCases) {
        for (const t of c.tags) allTags.add(t)
      }

      stats = {}
      for (const tag of allTags) {
        stats[tag] = { total: 0, passed: 0, rate: 0 }
      }

      for (const r of allCaseResults) {
        for (const tag of r.tags) {
          const s = stats[tag]
          if (s) {
            s.total++
            if (r.passed) s.passed++
          }
        }
      }

      const overallPassed = allCaseResults.filter((r) => r.passed).length
      stats['__overall__'] = {
        total: allCaseResults.length,
        passed: overallPassed,
        rate: allCaseResults.length > 0 ? overallPassed / allCaseResults.length : 0,
      }

      for (const tag of Object.keys(stats)) {
        const s = stats[tag]!
        s.rate = s.total > 0 ? s.passed / s.total : 1.0
      }

      // Load baseline
      const baselineFile = IS_LIVE ? 'baseline.live.json' : 'baseline.mocked.json'
      const baselinePath = path.resolve(__dirname, 'corpus', baselineFile)
      baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'))

      baselineErrors = []
      for (const [tag, threshold] of Object.entries(baseline)) {
        if (tag.startsWith('__')) continue
        const s = stats[tag]
        if (s && s.rate < threshold) {
          baselineErrors.push(
            `  FAIL: "${tag}" pass rate ${(s.rate * 100).toFixed(1)}% ` +
            `is below baseline ${(threshold * 100).toFixed(0)}% ` +
            `(${s.passed}/${s.total})`
          )
        }
      }
    })

    it('prints per-tag pass-rate report', () => {
      const lines: string[] = [
        '',
        '═══════════════════════════════════════════════',
        ` NLP Corpus Pass-Rate Report (${IS_LIVE ? 'LIVE' : 'MOCKED'} mode)`,
        ` Cases: ${allCaseResults.length} total`,
        ` Overall: ${stats['__overall__']!.passed}/${stats['__overall__']!.total} ` +
        `(${(stats['__overall__']!.rate * 100).toFixed(1)}%)`,
        '───────────────────────────────────────────────',
      ]

      const tagNames = Object.keys(stats)
        .filter((t) => t !== '__overall__')
        .sort()

      for (const tag of tagNames) {
        const s = stats[tag]!
        const pct = (s.rate * 100).toFixed(1)
        const bar = '█'.repeat(Math.round(s.rate * 20))
        const threshold = baseline[tag]
        const thresholdStr = threshold !== undefined
          ? ` (floor: ${(threshold * 100).toFixed(0)}%)`
          : ''
        lines.push(`  ${tag.padEnd(15)} ${bar.padEnd(20)} ${pct}%${thresholdStr}`)
      }

      lines.push('═══════════════════════════════════════════════')

      console.log(lines.join('\n'))
      expect(true).toBe(true)
    })

    it('baseline check: no tag below committed floor', () => {
      if (baselineErrors.length > 0) {
        console.log('\nBASELINE VIOLATIONS:')
        for (const err of baselineErrors) {
          console.log(err)
        }
        console.log('')
      }

      if (IS_LIVE) {
        if (baselineErrors.length > 0) {
          console.log('[INFO] Live baseline violations noted above - not blocking CI.')
        }
      } else {
        expect(baselineErrors).toHaveLength(0)
      }
    })

    it('prints individual case failures for debugging', () => {
      const failures = allCaseResults.filter((r) => !r.passed)
      if (failures.length > 0) {
        console.log('\nFAILED CASES:')
        for (const f of failures) {
          console.log(`  [${f.id}] ${f.message}`)
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