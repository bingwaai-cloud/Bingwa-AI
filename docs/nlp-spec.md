# Bingwa AI — NLP Specification

## Purpose
This document defines exactly how the NLP engine must behave.
Claude Code must follow these rules precisely when building the intent parser.

## Input normalization (before Claude API call)

### Currency normalization
```
70k        → 70000
70,000     → 70000
shs70k     → 70000
UGX70,000  → 70000
70K        → 70000
7.5k       → 7500
1.2m       → 1200000
```

### Quantity normalization
```
2 pcs      → qty: 2
a dozen    → qty: 12
half       → qty: 0.5
pair       → qty: 1 (unit = pair)
box of 12  → qty: 12
```

### Phone normalization
```
0772456789   → +256772456789
772456789    → +256772456789
+256772...   → +256772456789 (already valid)
```

## Intent classification

### Actions
| User says | Action |
|---|---|
| sold, sell, sale, nimeuza | sale |
| bought, purchased, restock, niliununua | purchase |
| stock, how many, check, inventory | stock_check |
| summary, report, how did I do | report |
| add customer, save number, mteja | customer_add |
| add supplier, new supplier | supplier_add |
| rent, electricity, expense, gharama | expense |
| send message, broadcast, notify customers | marketing |
| print receipt, receipt | receipt |
| pay, subscribe, renew | subscription |

## Price ambiguity resolution

### Rule 1: Check history first
Before flagging ambiguity, check item price history.
If "sold 2 sugar at 6000":
- History shows sugar sells at 6,000–7,000 each → unit_price = 6000, total = 12000
- History shows sugar sells at 12,000–14,000 each → total = 6000, unit_price = 3000
- No history → apply Rule 2

### Rule 2: Mathematical plausibility
If no history, check if amount makes sense:
- Amount / qty = plausible unit price? → treat as total
- Amount = known market price per unit? → treat as unit price
- Cannot determine → ask once

### Rule 3: One clarification maximum
```
Bot: "Is that 6,000 each (total: 12,000) or 6,000 total (3,000 each)?"
```
User answers → record preference → never ask again for this item

### Rule 4: Anomaly flagging
If recorded price diverges from history by more than 40%:
```
Bot: "That's lower than usual — you normally sell sugar at 6,500.
     Confirm sale at 3,500? Reply YES or correct the price."
```

## Context injection format

Every Claude API call includes this system context:

```
BUSINESS CONTEXT:
Name: {business_name}
Type: {business_type}
Owner: {owner_name}
Date: {today}
Time: {current_time}

INVENTORY (current stock):
{item_name}: {qty} {unit} | typical price: {ugx} each

PRICE HISTORY (last 30 days):
{item}: sold at {min}–{max} UGX, avg {avg} UGX, {count} times

TODAY SO FAR:
Sales: UGX {total} ({count} transactions)
Purchases: UGX {total}
Low stock: {items}

EXPENSES DUE:
{expense_name}: UGX {amount} due in {days} days

LAST 5 INTERACTIONS:
{timestamp}: {user_message} → {action_taken}

TASK: Parse the user message below. Return ONLY valid JSON.
No explanation. No markdown. Pure JSON only.

JSON schema:
{
  "action": "sale|purchase|stock_check|report|customer_add|supplier_add|expense|marketing|receipt|subscription|unknown",
  "item": string | null,
  "item_normalized": string | null,
  "qty": number | null,
  "unit": string | null,
  "unit_price": number | null,
  "total": number | null,
  "confidence": number (0-1),
  "needs_clarification": boolean,
  "clarification_question": string | null,
  "supplier_name": string | null,
  "customer_phone": string | null,
  "customer_name": string | null,
  "expense_name": string | null,
  "period": "today|yesterday|this_week|this_month" | null,
  "anomaly": boolean,
  "anomaly_reason": string | null,
  "notes": string | null
}
```

## Test cases (run these to verify NLP is working)

```
Input: "sold 2 gumboots at 70k total"
Expected: {action:"sale", item:"gumboots", qty:2, unit_price:35000, total:70000, confidence:>0.9}

Input: "nimeuza sukari 3 kwa 6000"
Expected: {action:"sale", item:"sugar", qty:3, confidence:>0.7}

Input: "bought 20 bags sugar from Kasozi at 4500 each"
Expected: {action:"purchase", item:"sugar", qty:20, unit_price:4500, total:90000, supplier_name:"Kasozi"}

Input: "how much sugar do I have"
Expected: {action:"stock_check", item:"sugar", confidence:>0.9}

Input: "sold 5 soap"
Expected: {action:"sale", item:"soap", qty:5, needs_clarification:true} (no price given)

Input: "today summary"
Expected: {action:"report", period:"today"}

Input: "add customer 0772456789 Nakato"
Expected: {action:"customer_add", customer_phone:"+256772456789", customer_name:"Nakato"}

Input: "rent 800k"
Expected: {action:"expense", expense_name:"rent", total:800000}

Input: "send weekend offer to customers"
Expected: {action:"marketing"}

Input: "print receipt"
Expected: {action:"receipt"}
```

## WhatsApp response formatting

### Sale confirmation
```
✅ Sale recorded!
─────────────────
Item: Gumboots
Qty: 2 pairs
Unit: UGX 35,000
Total: UGX 70,000
Stock left: 22 pairs
─────────────────
Reply RECEIPT to print
```

### Low stock warning (appended to sale confirmation)
```
⚠️ Sugar is running low — only 3 bags left.
Want to reorder from Kasozi? Reply ORDER
```

### Clarification request
```
Quick check: Is that 6,000 each (total 12,000)
or 6,000 total (3,000 each)?
Reply EACH or TOTAL
```

### Morning report
```
☀️ Good morning, Rose!

Yesterday: UGX 340,000 (12 sales)
─────────────────
⚠️ Low stock:
• Sugar: 3 bags (reorder?)
• Maize flour: OUT OF STOCK

💡 Rent due in 4 days (UGX 800,000)

Have a blessed day! 🙏
```
