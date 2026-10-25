/**
 * Safe Message Template Validation & Rendering Engine
 * 
 * Enforces strict whitelist of approved placeholders:
 * - {{otp}}
 * - {{app_name}}
 * - {{expiry_minutes}}
 * 
 * Rejects any disallowed placeholders, unescaped injections, or unsafe control bytes.
 */

import { calculateSmsSegments, SmsSegmentInfo } from './segment';
import { TemplateStatus, TemplateType } from '@/types';

export const VALID_TEMPLATE_STATUSES = ['DRAFT', 'APPROVED', 'ACTIVE', 'ARCHIVED'] as const;
export const VALID_TEMPLATE_TYPES = ['OTP', 'TRANSACTIONAL', 'MARKETING', 'NOTIFICATION'] as const;

export class TemplateValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'VALIDATION_ERROR',
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'TemplateValidationError';
  }
}

export class TemplateStateError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'ILLEGAL_STATE_TRANSITION',
    public readonly statusCode: number = 409
  ) {
    super(message);
    this.name = 'TemplateStateError';
  }
}

export function isValidTemplateStatus(val: unknown): val is TemplateStatus {
  return typeof val === 'string' && VALID_TEMPLATE_STATUSES.includes(val as TemplateStatus);
}

export function isValidTemplateType(val: unknown): val is TemplateType {
  return typeof val === 'string' && VALID_TEMPLATE_TYPES.includes(val as TemplateType);
}

export function assertValidTemplateStatus(val: unknown): TemplateStatus {
  if (!isValidTemplateStatus(val)) {
    throw new TemplateValidationError(
      `Invalid template status: "${String(val)}". Allowed values: ${VALID_TEMPLATE_STATUSES.join(', ')}`,
      'INVALID_STATUS',
      400
    );
  }
  return val;
}

export function assertValidTemplateType(val: unknown): TemplateType {
  if (!isValidTemplateType(val)) {
    throw new TemplateValidationError(
      `Invalid template type: "${String(val)}". Allowed values: ${VALID_TEMPLATE_TYPES.join(', ')}`,
      'INVALID_TYPE',
      400
    );
  }
  return val;
}

export const PERMITTED_VERSION_TRANSITIONS: Record<TemplateStatus, TemplateStatus[]> = {
  DRAFT: ['APPROVED', 'ARCHIVED'],
  APPROVED: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['APPROVED', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'], // only via explicit restoration flow
};

export function validateVersionTransition(current: TemplateStatus, target: TemplateStatus): void {
  if (current === target) return;
  const allowed = PERMITTED_VERSION_TRANSITIONS[current] || [];
  if (!allowed.includes(target)) {
    throw new TemplateStateError(
      `Illegal template version transition from '${current}' to '${target}'. Allowed: ${allowed.join(', ') || 'none'}`,
      'ILLEGAL_STATE_TRANSITION',
      409
    );
  }
}

export const APPROVED_PLACEHOLDERS = ['otp', 'app_name', 'expiry_minutes'] as const;
export type ApprovedPlaceholder = typeof APPROVED_PLACEHOLDERS[number];

export interface TemplateValidationSuccess {
  valid: true;
  placeholders: ApprovedPlaceholder[];
  characterCount: number;
  segmentCount: number;
  encoding: 'GSM_7' | 'UCS2';
  segmentInfo: SmsSegmentInfo;
}

export interface TemplateValidationFailure {
  valid: false;
  error: string;
  code: 'INVALID_PLACEHOLDER' | 'MISSING_OTP_PLACEHOLDER' | 'UNSAFE_INPUT' | 'EXCEEDS_MAX_LENGTH' | 'EMPTY_BODY';
}

export type TemplateValidationResult = TemplateValidationSuccess | TemplateValidationFailure;

export interface PreviewOptions {
  otp?: string;
  app_name?: string;
  expiry_minutes?: number | string;
}

export interface TemplatePreviewResult {
  renderedText: string;
  variables: Record<string, string>;
  segmentInfo: SmsSegmentInfo;
}

/**
 * Sanitizes template strings against unsafe input (null bytes, control characters, scripts).
 */
export function checkUnsafeInput(body: string): { safe: boolean; reason?: string } {
  // Check for null bytes
  if (body.includes('\0') || body.includes('\u0000')) {
    return { safe: false, reason: 'Template body contains illegal null byte characters' };
  }

  // Check for dangerous non-printable control characters (excluding \r, \n, \t)
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      return { safe: false, reason: `Template body contains illegal control character (code: ${code})` };
    }
  }

  // Check for malicious HTML / script injections
  if (/<\s*script/i.test(body) || /javascript:/i.test(body) || /<\s*iframe/i.test(body)) {
    return { safe: false, reason: 'Template body contains forbidden script or HTML tags' };
  }

  return { safe: true };
}

/**
 * Validates message template body:
 * - Checks length and empty body
 * - Verifies unsafe input
 * - Enforces that ONLY approved placeholders are present: {{otp}}, {{app_name}}, {{expiry_minutes}}
 * - If templateType is OTP, enforces that {{otp}} is present
 */
export function validateTemplate(
  body: string,
  templateType: 'OTP' | 'TRANSACTIONAL' | 'MARKETING' | 'NOTIFICATION' = 'OTP'
): TemplateValidationResult {
  if (!body || typeof body !== 'string' || body.trim().length === 0) {
    return {
      valid: false,
      code: 'EMPTY_BODY',
      error: 'Template body cannot be empty',
    };
  }

  if (body.length > 500) {
    return {
      valid: false,
      code: 'EXCEEDS_MAX_LENGTH',
      error: 'Template body exceeds maximum allowed limit of 500 characters',
    };
  }

  // Check for disallowed shell/interpolation placeholder syntax like ${var}
  if (/\$\{([^}]+)\}/.test(body)) {
    return {
      valid: false,
      code: 'INVALID_PLACEHOLDER',
      error: 'Unapproved placeholder syntax ${...} is forbidden. Only {{otp}}, {{app_name}}, {{expiry_minutes}} are allowed.',
    };
  }

  const safetyCheck = checkUnsafeInput(body);
  if (!safetyCheck.safe) {
    return {
      valid: false,
      code: 'UNSAFE_INPUT',
      error: safetyCheck.reason || 'Template contains unsafe or malicious input',
    };
  }

  // Extract all placeholders matching double curly braces {{...}}
  const doubleBraceRegex = /\{\{([^}]+)\}\}/g;
  const foundPlaceholders = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = doubleBraceRegex.exec(body)) !== null) {
    let rawKey = match[1].trim().toLowerCase();
    // Normalize known aliases
    if (rawKey === 'code') rawKey = 'otp';
    if (rawKey === 'project_name') rawKey = 'app_name';
    foundPlaceholders.add(rawKey);
  }

  // Check for standalone single-brace placeholders that might be unintended or legacy
  const singleBraceRegex = /(?<!\{)\{([^{}]+)\}(?!\})/g;
  while ((match = singleBraceRegex.exec(body)) !== null) {
    let rawKey = match[1].trim().toLowerCase();
    // Normalize known aliases
    if (rawKey === 'project_name') {
      rawKey = 'app_name';
    } else if (rawKey === 'code') {
      rawKey = 'otp';
    }
    foundPlaceholders.add(rawKey);
  }

  // Verify all found placeholders are approved
  const approvedSet = new Set<string>(APPROVED_PLACEHOLDERS);
  const disallowed: string[] = [];
  const normalizedApproved: ApprovedPlaceholder[] = [];

  for (const placeholder of foundPlaceholders) {
    if (approvedSet.has(placeholder)) {
      normalizedApproved.push(placeholder as ApprovedPlaceholder);
    } else {
      disallowed.push(placeholder);
    }
  }

  if (disallowed.length > 0) {
    return {
      valid: false,
      code: 'INVALID_PLACEHOLDER',
      error: `Disallowed placeholder(s) found: ${disallowed.map((d) => `{{${d}}}`).join(', ')}. Only {{otp}}, {{app_name}}, {{expiry_minutes}} are allowed.`,
    };
  }

  // Enforce OTP placeholder for OTP templates
  if (templateType === 'OTP' && !normalizedApproved.includes('otp')) {
    return {
      valid: false,
      code: 'MISSING_OTP_PLACEHOLDER',
      error: 'OTP message templates must contain the {{otp}} placeholder.',
    };
  }

  const segmentInfo = calculateSmsSegments(body);

  return {
    valid: true,
    placeholders: normalizedApproved,
    characterCount: segmentInfo.characterCount,
    segmentCount: segmentInfo.segmentCount,
    encoding: segmentInfo.encoding,
    segmentInfo,
  };
}

/**
 * Safely renders a template with provided variable values.
 * Never allows client injection into variable values.
 */
export function renderTemplate(body: string, variables: PreviewOptions): string {
  const otpVal = variables.otp != null ? String(variables.otp).replace(/[^\d]/g, '') : '';
  const appNameVal = variables.app_name != null ? String(variables.app_name).replace(/[\r\n\0]/g, '').trim() : 'Swift';
  const expiryVal = variables.expiry_minutes != null ? String(variables.expiry_minutes).replace(/[^\d]/g, '') : '5';

  return body
    // Double braces (canonical)
    .replace(/\{\{\s*otp\s*\}\}/gi, otpVal)
    .replace(/\{\{\s*code\s*\}\}/gi, otpVal)
    .replace(/\{\{\s*app_name\s*\}\}/gi, appNameVal)
    .replace(/\{\{\s*project_name\s*\}\}/gi, appNameVal)
    .replace(/\{\{\s*expiry_minutes\s*\}\}/gi, expiryVal)
    // Single braces (backward compatibility)
    .replace(/\{\s*otp\s*\}/gi, otpVal)
    .replace(/\{\s*code\s*\}/gi, otpVal)
    .replace(/\{\s*project_name\s*\}/gi, appNameVal)
    .replace(/\{\s*app_name\s*\}/gi, appNameVal)
    .replace(/\{\s*expiry_minutes\s*\}/gi, expiryVal);
}

/**
 * Previews a template with either provided or default sample variables,
 * returning rendered text and telecom character/segment metrics.
 */
export function previewTemplate(
  body: string,
  sampleVariables: PreviewOptions = {}
): {
  success: true;
  preview: TemplatePreviewResult;
} | {
  success: false;
  error: string;
  code: string;
} {
  const validation = validateTemplate(body, 'NOTIFICATION'); // Don't enforce otp for raw preview calculation
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      code: validation.code,
    };
  }

  const finalVars: Record<string, string> = {
    otp: sampleVariables.otp?.trim() || '123456',
    app_name: sampleVariables.app_name?.trim() || 'Swift',
    expiry_minutes: String(sampleVariables.expiry_minutes || '5'),
  };

  const renderedText = renderTemplate(body, finalVars);
  const segmentInfo = calculateSmsSegments(renderedText);

  return {
    success: true,
    preview: {
      renderedText,
      variables: finalVars,
      segmentInfo,
    },
  };
}
