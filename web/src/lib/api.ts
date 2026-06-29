export type ApiMeta = {
  total?: number;
  page?: number;
  perPage?: number;
};

export type ApiError = {
  code: string;
  message: string;
  field?: string;
};

export type ApiSuccess<T> = {
  success: true;
  data: T;
  meta?: ApiMeta;
};

export type ApiFailure = {
  success: false;
  error: ApiError;
};

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export class ApiClientError extends Error {
  readonly code: string;
  readonly field?: string;
  readonly status: number;

  constructor(error: ApiError, status: number) {
    super(error.message);
    this.name = "ApiClientError";
    this.code = error.code;
    this.field = error.field;
    this.status = status;
  }
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

type ApiRequestOptions = Omit<RequestInit, "body" | "credentials" | "headers"> & {
  body?: unknown;
  headers?: HeadersInit;
};

export async function apiRequest<T>(path: `/api/v1/${string}`, options: ApiRequestOptions = {}): Promise<ApiSuccess<T>> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  headers.set("x-gezi-source", "web");

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    body,
    headers,
    credentials: "include"
  });

  const envelope = (await response.json()) as ApiEnvelope<T>;

  if (!envelope.success) {
    throw new ApiClientError(envelope.error, response.status);
  }

  return envelope;
}

export type ProvenanceSource = "whatsapp" | "web" | "mobile" | "api" | "pos" | string;

export type SaleLineItem = {
  id: string;
  itemName: string;
  qty: number;
  unit: string;
  unitPrice: number;
  totalPrice: number;
  createdAt: string;
};

export type SaleRecord = {
  id: string;
  itemName: string;
  qty: number;
  unitPrice: number;
  totalPrice: number;
  source: ProvenanceSource;
  createdAt: string;
  lines: SaleLineItem[];
};

export type PurchaseRecord = {
  id: string;
  itemName: string;
  qty: number;
  unitPrice: number;
  totalPrice: number;
  source: ProvenanceSource;
  createdAt: string;
};

export type InventoryItem = {
  id: string;
  name: string;
  unit: string;
  qtyInStock: number;
  lowStockThreshold: number;
  createdAt: string;
};

export type DraftState = "parsed" | "pending_clarification" | "confirmed" | "committed" | "cancelled";

export type DraftRecord = {
  id: string;
  userPhone: string;
  action: string;
  payload: Record<string, unknown>;
  state: DraftState;
  clarificationQuestion: string | null;
  committedEntityId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type TodaySalesSummary = {
  totalRevenue: number;
  saleCount: number;
};

type ListParams = {
  from?: string;
  to?: string;
  page?: number;
  perPage?: number;
};

function queryString(params: ListParams): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) search.set(key, String(value));
  });
  const value = search.toString();
  return value ? `?${value}` : "";
}

export async function getTodaySalesSummary(): Promise<TodaySalesSummary> {
  return (await apiRequest<TodaySalesSummary>("/api/v1/sales/summary/today")).data;
}

export async function listSales(params: ListParams = {}): Promise<ApiSuccess<SaleRecord[]>> {
  return apiRequest<SaleRecord[]>(`/api/v1/sales${queryString(params)}` as `/api/v1/${string}`);
}

export async function listPurchases(params: ListParams = {}): Promise<ApiSuccess<PurchaseRecord[]>> {
  return apiRequest<PurchaseRecord[]>(`/api/v1/purchases${queryString(params)}` as `/api/v1/${string}`);
}

export async function listLowStockItems(): Promise<InventoryItem[]> {
  return (await apiRequest<InventoryItem[]>("/api/v1/inventory/low-stock")).data;
}

export async function listDrafts(params: Pick<ListParams, "page" | "perPage"> = {}): Promise<ApiSuccess<DraftRecord[]>> {
  return apiRequest<DraftRecord[]>(`/api/v1/drafts${queryString(params)}` as `/api/v1/${string}`);
}

export async function confirmDraft(
  id: string,
  body: { answer?: string; payload?: Record<string, unknown> } = {}
): Promise<unknown> {
  return (await apiRequest<unknown>(`/api/v1/drafts/${id}/confirm` as `/api/v1/${string}`, {
    method: "POST",
    body
  })).data;
}

export async function amendDraft(
  id: string,
  body: { payload: Record<string, unknown>; clarificationQuestion?: string | null }
): Promise<DraftRecord> {
  return (await apiRequest<DraftRecord>(`/api/v1/drafts/${id}/amend` as `/api/v1/${string}`, {
    method: "POST",
    body
  })).data;
}

export async function cancelDraft(id: string): Promise<DraftRecord> {
  return (await apiRequest<DraftRecord>(`/api/v1/drafts/${id}/cancel` as `/api/v1/${string}`, {
    method: "POST"
  })).data;
}
