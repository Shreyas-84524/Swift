/**
 * SMS Character and Segment Calculation Engine
 * 
 * Supports standard 3GPP TS 23.038 GSM 7-bit default alphabet with extension table,
 * as well as UCS-2 (16-bit) Unicode fallback for international characters and emojis.
 */

// Basic GSM 7-bit alphabet characters
const GSM_7_BASIC = new Set<string>([
  '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å',
  'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ', 'Æ', 'æ', 'ß', 'É',
  ' ', '!', '"', '#', '¤', '%', '&', '\'', '(', ')', '*', '+', ',', '-', '.', '/',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '<', '=', '>', '?',
  '¡', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
  'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Ä', 'Ö', 'Ñ', 'Ü', '§',
  '¿', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
  'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'ä', 'ö', 'ñ', 'ü', 'à',
]);

// Extended GSM 7-bit characters (require an ESC 0x1B prefix, so count as 2 septets / 2 chars)
const GSM_7_EXTENDED = new Set<string>([
  '\f', // Form Feed
  '^',  // Caret
  '{',  // Open brace
  '}',  // Close brace
  '\\', // Backslash
  '[',  // Open bracket
  '~',  // Tilde
  ']',  // Close bracket
  '|',  // Pipe
  '€',  // Euro sign
]);

export type SmsEncoding = 'GSM_7' | 'UCS2';

export interface SmsSegmentInfo {
  encoding: SmsEncoding;
  characterCount: number; // Effective septets for GSM-7, code units for UCS-2
  rawLength: number; // JavaScript string character length
  segmentCount: number;
  maxCharactersPerSegment: number;
  maxMultipartCharactersPerSegment: number;
  remainingInCurrentSegment: number;
}

/**
 * Detects whether a string conforms to GSM 7-bit alphabet or requires UCS-2.
 */
export function detectEncoding(text: string): SmsEncoding {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!GSM_7_BASIC.has(char) && !GSM_7_EXTENDED.has(char)) {
      return 'UCS2';
    }
  }
  return 'GSM_7';
}

/**
 * Calculates SMS character counts and segments according to telecom standards.
 * 
 * GSM 7-bit:
 * - Single SMS: up to 160 septets
 * - Concatenated SMS: 153 septets per segment (7 septets reserved for UDH header)
 * - Extended characters count as 2 septets
 * 
 * UCS-2 (Unicode):
 * - Single SMS: up to 70 characters
 * - Concatenated SMS: 67 characters per segment (3 characters / 6 bytes reserved for UDH)
 */
export function calculateSmsSegments(text: string): SmsSegmentInfo {
  const rawLength = text.length;
  if (rawLength === 0) {
    return {
      encoding: 'GSM_7',
      characterCount: 0,
      rawLength: 0,
      segmentCount: 0,
      maxCharactersPerSegment: 160,
      maxMultipartCharactersPerSegment: 153,
      remainingInCurrentSegment: 160,
    };
  }

  const encoding = detectEncoding(text);

  if (encoding === 'GSM_7') {
    let septetCount = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (GSM_7_EXTENDED.has(char)) {
        septetCount += 2;
      } else {
        septetCount += 1;
      }
    }

    let segmentCount: number;
    let remainingInCurrentSegment: number;

    if (septetCount <= 160) {
      segmentCount = 1;
      remainingInCurrentSegment = 160 - septetCount;
    } else {
      segmentCount = Math.ceil(septetCount / 153);
      const usedInLastSegment = septetCount % 153 === 0 ? 153 : septetCount % 153;
      remainingInCurrentSegment = 153 - usedInLastSegment;
    }

    return {
      encoding: 'GSM_7',
      characterCount: septetCount,
      rawLength,
      segmentCount,
      maxCharactersPerSegment: segmentCount > 1 ? 153 : 160,
      maxMultipartCharactersPerSegment: 153,
      remainingInCurrentSegment,
    };
  } else {
    // UCS-2 Encoding
    // Handle surrogate pairs as single characters or code units
    // Telecom carriers count UCS-2 in 16-bit code units (length in JS string)
    const codeUnits = rawLength;
    let segmentCount: number;
    let remainingInCurrentSegment: number;

    if (codeUnits <= 70) {
      segmentCount = 1;
      remainingInCurrentSegment = 70 - codeUnits;
    } else {
      segmentCount = Math.ceil(codeUnits / 67);
      const usedInLastSegment = codeUnits % 67 === 0 ? 67 : codeUnits % 67;
      remainingInCurrentSegment = 67 - usedInLastSegment;
    }

    return {
      encoding: 'UCS2',
      characterCount: codeUnits,
      rawLength,
      segmentCount,
      maxCharactersPerSegment: segmentCount > 1 ? 67 : 70,
      maxMultipartCharactersPerSegment: 67,
      remainingInCurrentSegment,
    };
  }
}
