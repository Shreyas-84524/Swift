import { NextRequest, NextResponse } from 'next/server';
import { authenticateProject } from '@/lib/auth/middleware';
import { OtpService } from '@/lib/otp/service';
import { JsonBodyError, readBoundedJsonObject } from '@/lib/http/json-body';
import { VerifyOtpRequest } from '@/types';

export const dynamic = 'force-dynamic';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      if (!(error instanceof JsonBodyError)) throw error;
      return NextResponse.json(
        {
          success: false,
          verified: false,
          error: {
            code: error.code,
            message: error.message,
          },
        },
        { status: error.statusCode }
      );
    }

    const phone = rawBody?.phone || rawBody?.phone_number;
    const requestId = rawBody?.request_id || rawBody?.challenge_id;
    const otp = rawBody?.otp || rawBody?.code;

    if (!phone || !requestId || !otp) {
      return NextResponse.json(
        {
          success: false,
          verified: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Fields ("phone" or "phone_number"), ("request_id" or "challenge_id"), and ("otp" or "code") are required',
          },
        },
        { status: 400 }
      );
    }

    const trimmedPhone = String(phone).trim();
    const trimmedRequestId = String(requestId).trim();
    const trimmedOtp = String(otp).trim();

    if (!UUID_REGEX.test(trimmedRequestId)) {
      return NextResponse.json(
        {
          success: false,
          verified: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'request_id must be a valid UUID',
          },
        },
        { status: 400 }
      );
    }

    if (!/^\d{4,10}$/.test(trimmedOtp)) {
      return NextResponse.json(
        {
          success: false,
          verified: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Verification code must be numeric with length between 4 and 10 digits',
          },
        },
        { status: 400 }
      );
    }

    const payload: VerifyOtpRequest = {
      phone: trimmedPhone,
      request_id: trimmedRequestId,
      otp: trimmedOtp,
    };

    const result = await OtpService.verifyOtp(auth.context.project, payload);

    if (result.status === 200) {
      return NextResponse.json(
        {
          success: true,
          verified: true,
          data: {
            verified: true,
            challenge_id: trimmedRequestId,
            verified_at: new Date().toISOString(),
          },
        },
        { status: 200 }
      );
    }

    return NextResponse.json(result.body, { status: result.status });
  } catch {
    console.error('[API /api/v1/otp/verify] Internal error');
    return NextResponse.json(
      {
        success: false,
        verified: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error processing OTP verification',
        },
      },
      { status: 500 }
    );
  }
}
