export type ApiMeta = {
  total?: number;
  page?: number;
  perPage?: number;
  lowStockCount?: number;
};

export type ApiError = {
  code: string;
  message: string;
  field?: string;
};

export type AuthUser = {
  id: string;
  phone: string;
  name: string | null;
  role: "owner" | "manager" | "cashier" | string;
  totpEnabled?: boolean;
};

export type AuthTenant = {
  id: string;
  businessName: string;
  ownerPhone: string;
};

export type AuthSession = {
  tenant: AuthTenant;
  user: AuthUser;
};

export type LoginResponse = AuthSession & {
  twoFactorRequired?: true;
};

export type SignupRequest = {
  businessName: string;
  ownerName: string;
  ownerPhone: string;
  password: string;
};

export type TwoFactorSetupResponse = {
  provisioningUri: string;
};

export type TwoFactorVerifyResponse = Partial<AuthSession> & {
  totpEnabled?: true;
  recoveryCodes?: string[];
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

function isTwoFactorRequired(error: ApiError): boolean {
  return error.message.toLowerCase().includes("two-factor") || error.code === "TWO_FACTOR_REQUIRED";
}

async function refreshSession(): Promise<boolean> {
  const response = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { Accept: "application/json", "x-gezi-source": "web" },
    credentials: "include"
  });
  return response.ok;
}

export async function apiRequest<T>(path: `/api/v1/${string}`, options: ApiRequestOptions = {}): Promise<ApiSuccess<T>> {
  return apiRequestInternal<T>(path, options, true);
}

async function apiRequestInternal<T>(path: `/api/v1/${string}`, options: ApiRequestOptions, allowRefresh: boolean): Promise<ApiSuccess<T>> {
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
    const error = new ApiClientError(envelope.error, response.status);
    if (response.status === 401 && allowRefresh && !isTwoFactorRequired(envelope.error) && path !== "/api/v1/auth/refresh") {
      const refreshed = await refreshSession();
      if (refreshed) return apiRequestInternal<T>(path, options, false);
    }
    throw error;
  }

  return envelope;
}

export async function signup(input: SignupRequest): Promise<AuthSession> {
  return (await apiRequest<AuthSession>("/api/v1/auth/signup", { method: "POST", body: input })).data;
}

export async function login(phone: string, password: string): Promise<LoginResponse> {
  return (await apiRequest<LoginResponse>("/api/v1/auth/login", { method: "POST", body: { phone, password } })).data;
}

export async function getSession(): Promise<AuthSession> {
  return (await apiRequest<AuthSession>("/api/v1/auth/session")).data;
}

export async function verifyTwoFactor(code: string): Promise<TwoFactorVerifyResponse> {
  return (await apiRequest<TwoFactorVerifyResponse>("/api/v1/auth/2fa/verify", { method: "POST", body: { code } })).data;
}

export async function verifyRecoveryCode(recoveryCode: string): Promise<TwoFactorVerifyResponse> {
  return (await apiRequest<TwoFactorVerifyResponse>("/api/v1/auth/2fa/recovery", { method: "POST", body: { recoveryCode } })).data;
}

export async function setupTwoFactor(): Promise<TwoFactorSetupResponse> {
  return (await apiRequest<TwoFactorSetupResponse>("/api/v1/auth/2fa/setup", { method: "POST" })).data;
}

export async function verifyTwoFactorSetup(code: string): Promise<TwoFactorVerifyResponse> {
  return (await apiRequest<TwoFactorVerifyResponse>("/api/v1/auth/2fa/verify", { method: "POST", body: { code } })).data;
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

export type ExpenseRecord = {
  id: string;
  name: string;
  amountUgx: number;
  frequency: string;
  dueDay: number | null;
  lastPaidAt: string | null;
  nextDueAt: string | null;
  notes: string | null;
  createdAt: string;
  createdDay?: string;
};

export type InventoryItem = {
  id: string;
  name: string;
  unit: string;
  qtyInStock: number;
  lowStockThreshold: number;
  typicalSellPrice?: number | null;
  typicalBuyPrice?: number | null;
  createdAt: string;
  updatedAt?: string;
  lastSoldAt?: string | null;
};

export type CustomerRecord = {
  id: string;
  phone: string | null;
  name: string | null;
  notes: string | null;
  visitCount: number;
  totalPurchases: number;
  lastVisitedAt: string | null;
  optedInMarketing: boolean;
  createdAt: string;
  updatedAt: string;
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
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  groupBy?: "day" | "week" | "month";
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

export async function getSale(id: string): Promise<SaleRecord> {
  return (await apiRequest<SaleRecord>(`/api/v1/sales/${id}` as `/api/v1/${string}`)).data;
}

export async function listPurchases(params: ListParams = {}): Promise<ApiSuccess<PurchaseRecord[]>> {
  return apiRequest<PurchaseRecord[]>(`/api/v1/purchases${queryString(params)}` as `/api/v1/${string}`);
}

export async function listExpenses(params: Pick<ListParams, "from" | "to" | "page" | "perPage"> = {}): Promise<ApiSuccess<ExpenseRecord[]>> {
  return apiRequest<ExpenseRecord[]>(`/api/v1/expenses${queryString(params)}` as `/api/v1/${string}`);
}

export async function listLowStockItems(): Promise<InventoryItem[]> {
  return (await apiRequest<InventoryItem[]>("/api/v1/inventory/low-stock")).data;
}

export async function listInventory(params: Pick<ListParams, "page" | "perPage" | "search" | "sortBy" | "sortOrder"> = {}): Promise<ApiSuccess<InventoryItem[]>> {
  return apiRequest<InventoryItem[]>(`/api/v1/inventory${queryString(params)}` as `/api/v1/${string}`);
}

export async function listCustomers(params: Pick<ListParams, "page" | "perPage" | "search"> = {}): Promise<ApiSuccess<CustomerRecord[]>> {
  return apiRequest<CustomerRecord[]>(`/api/v1/customers${queryString(params)}` as `/api/v1/${string}`);
}

export async function getCustomer(id: string): Promise<CustomerRecord> {
  return (await apiRequest<CustomerRecord>(`/api/v1/customers/${id}` as `/api/v1/${string}`)).data;
}

export async function listCustomerPurchases(id: string, params: Pick<ListParams, "from" | "to" | "page" | "perPage"> = {}): Promise<ApiSuccess<SaleRecord[]>> {
  return apiRequest<SaleRecord[]>(`/api/v1/customers/${id}/purchases${queryString(params)}` as `/api/v1/${string}`);
}

export type SummaryBucket = {
  periodStart: string;
  totalUgx: number;
  count: number;
};

export type SummaryResponse = {
  groupBy: "day" | "week" | "month";
  from: string;
  to: string;
  buckets: SummaryBucket[];
  totalUgx: number;
  count: number;
};

export async function getSalesSummary(params: Pick<ListParams, "from" | "to" | "groupBy">): Promise<SummaryResponse> {
  return (await apiRequest<SummaryResponse>(`/api/v1/sales/summary${queryString(params)}` as `/api/v1/${string}`)).data;
}

export async function getPurchasesSummary(params: Pick<ListParams, "from" | "to" | "groupBy">): Promise<SummaryResponse> {
  return (await apiRequest<SummaryResponse>(`/api/v1/purchases/summary${queryString(params)}` as `/api/v1/${string}`)).data;
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


