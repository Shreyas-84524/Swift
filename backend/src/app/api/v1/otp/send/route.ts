import { NextRequest, NextResponse } from 'next/server';
import { authenticateProject } from '@/lib/auth/middleware';
import { OtpService } from '@/lib/otp/service';
import { JsonBodyError, readBoundedJsonObject } from '@/lib/http/json-body';
import { SendOtpRequest } from '@/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateProject(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    let rawBody: Record<string, unknown>;
    try {
      rawBody = await readBoundedJsonObject(request);
    } catch (error) {
      if (error instanceof JsonBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.statusCode });
      }
      throw error;
    }

    const phone = rawBody?.phone || rawBody?.phone_number;
    if (!phone || typeof phone !== 'string') {
      return NextResponse.json(
        { error: 'Field "phone" or "phone_number" must be a non-empty string' },
        { status: 400 }
      );
    }

    const trimmedPhone = phone.trim();
    if (trimmedPhone.length < 8 || trimmedPhone.length > 20) {
      return NextResponse.json(
        { error: 'Phone number must be between 8 and 20 characters in valid E.164 format' },
        { status: 400 }
      );
    }

    const rawIdempotencyKey =
      request.headers.get('idempotency-key') ||
      request.headers.get('x-idempotency-key') ||
      rawBody.idempotency_key ||
      undefined;
    if (rawIdempotencyKey !== undefined && typeof rawIdempotencyKey !== 'string') {
      return NextResponse.json({ error: 'Idempotency key must be a string' }, { status: 400 });
    }

    const payload: SendOtpRequest = {
      phone: trimmedPhone,
      code_length: rawBody.code_length as number | undefined,
      expiry_seconds: rawBody.expiry_seconds as number | undefined,
      idempotency_key: rawIdempotencyKey,
      metadata: rawBody.metadata as Record<string, unknown> | undefined,
    };

    const result = await OtpService.sendOtp(auth.context.project, payload);

    if (result.status === 200 && 'request_id' in result.body) {
      const respData = {
        success: true,
        data: {
          challenge_id: result.body.request_id,
          phone_number: trimmedPhone,
          status: 'QUEUED',
          expires_in: result.body.expires_in,
          retry_after_seconds: result.body.resend_after,
        },
        request_id: result.body.request_id,
        challenge_id: result.body.request_id,
        expires_in: result.body.expires_in,
        resend_after: result.body.resend_after,
      };
      return NextResponse.json(respData, { status: 200 });
    }

    return NextResponse.json(result.body, { status: result.status });
  } catch {
    console.error('[API /api/v1/otp/send] Internal error');
    return NextResponse.json(
      { error: 'Internal server error processing OTP request' },
      { status: 500 }
    );
  }
}
