import { NextRequest } from 'next/server';

export class JsonBodyError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 413,
    public readonly code: 'INVALID_JSON' | 'INVALID_BODY' | 'PAYLOAD_TOO_LARGE'
  ) {
    super(message);
    this.name = 'JsonBodyError';
  }
}

/**
 * Reads a JSON object while enforcing the limit against the actual UTF-8 body.
 * Content-Length is only an early rejection hint because chunked requests may
 * omit it and clients can provide an inaccurate value.
 */
export async function readBoundedJsonObject(
  request: NextRequest,
  maxBytes = 10 * 1024
): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new JsonBodyError(
        `Request body exceeds the ${maxBytes}-byte limit`,
        413,
        'PAYLOAD_TOO_LARGE'
      );
    }
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, 'utf8') > maxBytes) {
    throw new JsonBodyError(
      `Request body exceeds the ${maxBytes}-byte limit`,
      413,
      'PAYLOAD_TOO_LARGE'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new JsonBodyError('Invalid JSON request body', 400, 'INVALID_JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JsonBodyError('Request body must be a JSON object', 400, 'INVALID_BODY');
  }

  return parsed as Record<string, unknown>;
}
