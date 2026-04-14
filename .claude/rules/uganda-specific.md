# Rule: Uganda-specific Business Logic

## Currency
- All amounts stored as INTEGER (UGX, no decimal)
- Never use parseFloat() on money values
- Display format: "UGX 70,000" or "70k" in WhatsApp messages
- Input normalization: see nlp-parser.md

## Phone numbers
```typescript
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.startsWith('256')) return '+' + digits
  if (digits.startsWith('0')) return '+256' + digits.slice(1)
  if (digits.length === 9) return '+256' + digits
  return '+' + digits
}

export function isMTN(phone: string): boolean {
  const normalized = normalizePhone(phone)
  return /^\+256(77|78)/.test(normalized)
}

export function isAirtel(phone: string): boolean {
  const normalized = normalizePhone(phone)
  return /^\+256(75|70)/.test(normalized)
}
```

## WhatsApp message formatting
- Max 300 characters for conversational replies
- Use ─── dividers not tables (WhatsApp renders monospace poorly)
- Use ✅ ⚠️ 📦 📊 ☀️ 🙏 sparingly — one per message max
- Never use markdown bold/italic in WhatsApp (renders as asterisks)
- Receipt format: plain text, 32 chars wide for 58mm thermal

## Thermal receipt (58mm = 32 chars per line)
```typescript
export function formatReceipt(sale: Sale, business: Business): string {
  const line = (left: string, right: string) => {
    const space = 32 - left.length - right.length
    return left + ' '.repeat(Math.max(1, space)) + right
  }
  
  return [
    '================================',
    '         BINGWA AI              ',
    business.name.padStart(16 + business.name.length / 2).slice(0, 32),
    `Tel: ${business.phone}`,
    '================================',
    `Date: ${formatDate(sale.createdAt)}`,
    '--------------------------------',
    ...sale.items.map(i => line(i.name.slice(0, 16), formatUGX(i.total))),
    '--------------------------------',
    line('TOTAL', formatUGX(sale.totalPrice)),
    '================================',
    '   Powered by Bingwa AI   ',
    '================================'
  ].join('\n')
}
```

## Scheduled jobs (Africa/Kampala timezone)
- Morning report: 07:00 EAT (UTC+3)
- Evening summary: 20:00 EAT
- Weekly report: Sunday 08:00 EAT
- Subscription reminders: 3 days before expiry, day of expiry

## Language detection
Support mixed messages:
- "nimeuza sukari 3 kwa 6000" → sale (Swahili)
- "nakigula sukari" → purchase (Luganda)
- "sold 2 gumboots at 70k" → sale (English)
- "sold maize fla 5 bags 4 UGX 15k each" → sale (mixed)

Always pass raw message to Claude — let NLP handle language.
Do not attempt language detection before Claude call.

## Common item aliases (seed these at onboarding)
```
sugar → sukari, shuga
maize flour → unga, posho, flour
cooking oil → mafuta, oli
soap → sabuni, sopo
salt → chumvi, munyu
rice → mchele, rayisi
beans → maharagwe, obunde
```
