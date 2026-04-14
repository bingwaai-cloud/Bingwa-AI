# Command: /test-nlp

Run the full NLP test suite against real Ugandan business phrases.

## What to do
1. Load all test cases from docs/nlp-spec.md
2. Run each through the intent parser
3. Compare output against expected JSON
4. Report pass/fail with confidence scores
5. Flag any test where confidence < 0.7

## Test categories to cover
- Sales (English, Swahili, Luganda, mixed)
- Purchases with supplier names
- Stock checks
- Price ambiguity (each vs total)
- Reports (today, yesterday, this week)
- Customer adding
- Expense recording
- Unknown/garbage input

## Pass criteria
- All 20 core test cases pass
- No false positives on unknown input
- Price normalization correct (70k = 70000)
- Confidence > 0.85 on clear messages
- Clarification triggered on ambiguous messages

## Run with
`npm run test:nlp`

## If tests fail
1. Check price normalization function first
2. Check context injection format
3. Check Claude API response parsing
4. Add failing case to lessons in CLAUDE.md
