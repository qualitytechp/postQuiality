import { Banknote, Landmark } from 'lucide-react';

// `card` is the stored identifier, kept as-is because it is written into
// historical payments and into cash closures that are immutable by design.
// What it means to the merchant — and what every screen shows — is a bank
// transfer, which is why the label and icon say so.
export const PAYMENT_METHODS = Object.freeze([
  { key: 'cash' as const, labelKey: 'pos.methodCash', icon: Banknote },
  { key: 'card' as const, labelKey: 'pos.methodCard', icon: Landmark },
]);

export interface CustomPaymentMethod {
  id: number;
  name: string;
  is_active: boolean;
  sort_order: number;
  usage_count?: number;
}
