import { BRAND, RECEIPT_BRANDING_NAME as SHARED_RECEIPT_BRANDING_NAME } from '../../../../shared/brand';

export const RECEIPT_BRANDING_NAME = SHARED_RECEIPT_BRANDING_NAME;

/** Second footer line: the website once there is one, the support number meanwhile. */
export const RECEIPT_BRANDING_URL = BRAND.website || BRAND.supportPhoneDisplay;
