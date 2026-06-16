/**
 * Shared NLP types used across the intent parser, context builder,
 * and WhatsApp message dispatcher.
 */

export type Action =
  | 'sale'
  | 'purchase'
  | 'stock_check'
  | 'add_item'
  | 'report'
  | 'customer_add'
  | 'supplier_add'
  | 'expense'
  | 'marketing'
  | 'receipt'
  | 'subscription'
  | 'unknown'

export type Period = 'today' | 'yesterday' | 'week' | 'month'

export interface ParsedLineItem {
  item: string | null
  itemNormalized: string | null
  matchedItemId: string | null
  qty: number | null
  unit: string | null
  unitPrice: number | null
  totalPrice: number | null
  anomaly: boolean
  anomalyReason: string | null
}

export interface ParsedIntent {
  action: Action
  items: ParsedLineItem[]
  confidence: number
  resolution: 'commit' | 'confirm_default' | 'clarify' | 'reject'
  clarificationQuestion: string | null
  supplierName: string | null
  customerPhone: string | null
  customerName: string | null
  expenseName: string | null
  period: Period | null
  notes: string | null
}

export interface InventoryItem {
  id: string
  name: string
  nameNormalized: string
  aliases: string[]
  unit: string
  qtyInStock: number
  lowStockThreshold: number
  typicalBuyPrice: number | null
  typicalSellPrice: number | null
}

export interface Interaction {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  action?: string
}

export interface UserContext {
  tenantId: string
  userPhone: string
  tenant: {
    businessName: string
    businessType: string | null
    ownerName: string
    currency: string
    country: string
  }
  items: InventoryItem[]
  recentInteractions: Interaction[]
  onboardingStep: number
  onboardingComplete: boolean
  preferences: Record<string, unknown>
}
