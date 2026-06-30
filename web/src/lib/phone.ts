export type Carrier = "mtn" | "airtel" | null;

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("256") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 10) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  if (digits.length <= 9) return `+256${digits}`;
  return `+${digits}`;
}

export function detectCarrier(phone: string): Carrier {
  const normalized = normalizePhone(phone);
  if (/^\+256(77|78)\d{7}$/.test(normalized)) return "mtn";
  if (/^\+256(75|70)\d{7}$/.test(normalized)) return "airtel";
  return null;
}
