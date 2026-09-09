/**
 * Vendor identity for this distribution.
 *
 * Single source of truth for the product name and support contact shown in the
 * app, on printed receipts and in generated documents. Merchant-facing details
 * (business name, address, phone) are tenant settings and live in the database —
 * they are configured per store and never hardcoded here.
 */

export const BRAND = {
  /** Product name shown in the UI, window title and about screen. */
  productName: 'QualityTech POS',
  /** Short form for tight spaces (receipt footer, badges). */
  shortName: 'QualityTech',
  /** Legal entity behind the distribution. */
  company: 'QualityTech',
  supportEmail: 'qualitytechproject@gmail.com',
  /** E.164 for links, national format for display. */
  supportPhone: '+573147157869',
  supportPhoneDisplay: '+57 314 715 7869',
  website: '',
} as const;

/** `wa.me` deep link for support, using the E.164 number without its leading plus. */
export const SUPPORT_WHATSAPP_URL = `https://wa.me/${BRAND.supportPhone.replace(/[^0-9]/g, '')}`;

/** `mailto:` link for support. */
export const SUPPORT_EMAIL_URL = `mailto:${BRAND.supportEmail}`;

/** Footer line printed on customer receipts. */
export const RECEIPT_BRANDING_NAME = `Powered by ${BRAND.shortName}`;

/**
 * This distribution ships without vendor-hosted services. No usage pings and no
 * cloud sync leave the device; the POS is fully offline-first. Flip these and
 * point the endpoints at your own infrastructure to re-enable them.
 */
export const TELEMETRY_ENABLED = false;
export const CLOUD_SERVICES_ENABLED = false;

/** Nombre mDNS anunciado en la red local: se resuelve como <MDNS_HOST>.local */
export const MDNS_HOST = BRAND.shortName.toLowerCase().replace(/[^a-z0-9-]/g, '');
