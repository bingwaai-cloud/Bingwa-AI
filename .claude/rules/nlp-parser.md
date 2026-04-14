# Skill: NLP Intent Parser

## Purpose
Build and maintain the Bingwa AI intent parsing engine.
This skill defines exactly how to implement NLP for Ugandan business messages.

## Core principle
Never guess. Use price history. Ask once. Record everything.

## Implementation pattern

### File location
`backend/src/nlp/intentParser.ts`

### Function signature
```typescript
export async function parseIntent(
  message: string,
  context: UserContext
): Promise<ParsedIntent>

export interface ParsedIntent {
  action: Action
  item: string | null
  itemNormalized: string | null
  qty: number | null
  unit: string | null
  unitPrice: number | null  // always in UGX integer
  totalPrice: number | null // always in UGX integer
  confidence: number        // 0 to 1
  needsClarification: boolean
  clarificationQuestion: string | null
  supplierName: string | null
  customerPhone: string | null
  customerName: string | null
  expenseName: string | null
  period: Period | null
  anomaly: boolean
  anomalyReason: string | null
  notes: string | null
}
```

### Price normalization — implement this first
```typescript
export function normalizeCurrency(input: string): number | null {
  // Remove spaces and normalize case
  const clean = input.toLowerCase().replace(/\s/g, '')
  
  // Patterns to handle:
  // 70k, 70K → 70000
  // 1.5m, 1.5M → 1500000
  // 70,000 → 70000
  // shs70k, ugx70k → 70000
  // 70000 → 70000
  
  const stripped = clean.replace(/^(shs|ugx|ug)/, '')
  
  if (stripped.endsWith('m')) {
    return Math.round(parseFloat(stripped) * 1000000)
  }
  if (stripped.endsWith('k')) {
    return Math.round(parseFloat(stripped) * 1000)
  }
  
  const num = parseFloat(stripped.replace(/,/g, ''))
  return isNaN(num) ? null : Math.round(num)
}
```

### Context injection format
Build the system prompt from UserContext:
1. Business profile (name, type, owner)
2. Current inventory (item: qty unit | typical price)
3. Price history last 30 days (min, max, avg per item)
4. Today's sales total and count
5. Upcoming expenses
6. Last 5 interactions

### Ambiguity resolution order
1. Check price history for item
2. If history exists: compare stated amount against history
3. If stated amount ≈ typical unit price → treat as unit price
4. If stated amount ≈ typical total for that qty → treat as total
5. If diverges > 40% from history → flag anomaly, ask confirmation
6. If no history and ambiguous → ask clarification

### Item matching
```typescript
export function matchItem(
  input: string,
  inventory: Item[]
): Item | null {
  const normalized = input.toLowerCase().trim()
  
  // Exact match first
  let match = inventory.find(i => i.nameNormalized === normalized)
  if (match) return match
  
  // Alias match
  match = inventory.find(i => 
    i.aliases?.some(a => a.toLowerCase() === normalized)
  )
  if (match) return match
  
  // Partial match (contains)
  match = inventory.find(i => 
    i.nameNormalized.includes(normalized) || 
    normalized.includes(i.nameNormalized)
  )
  return match || null
}
```

### Claude API call pattern
```typescript
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 500,
  system: buildSystemPrompt(context),
  messages: [{ role: 'user', content: normalizedMessage }]
})

// Response MUST be valid JSON — if not, retry once then return unknown
const parsed = safeParseJSON(response.content[0].text)
```

### Error handling
- API timeout → return {action: 'unknown', confidence: 0, needsClarification: true}
- Invalid JSON response → retry once, then fallback
- Never let NLP failure crash the WhatsApp response loop
- Always send user a message, even if parsing failed

## Test this skill by running
`npm run test:nlp`

Tests located at: `backend/tests/nlp/intentParser.test.ts`
Must pass all 20 test cases in docs/nlp-spec.md before merging.
