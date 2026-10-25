import { NextRequest, NextResponse } from 'next/server';
import { authenticateGateway } from '@/lib/auth/middleware';
import { PushTokenService, TokenValidationError } from '@/lib/push/token-service';
import { RegisterPushTokenRequest, RegisterPushTokenResponse } from '@/types';

export const dynamic = 'force-dynamic';

/**
 * PUT /api/v1/gateway/push-token
 * Registers or rotates the FCM push token for the authenticated gateway.
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateGateway(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let rawBody: RegisterPushTokenRequest;
  try {
    rawBody = (await request.json()) as RegisterPushTokenRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
  }

  try {
    const gatewayId = auth.context.gateway.id;

    const result = await PushTokenService.registerToken(gatewayId, rawBody);

    const response: RegisterPushTokenResponse = {
      success: true,
      data: {
        registered: true,
        provider: 'FCM',
        platform: 'ANDROID',
        last_registered_at: result.last_registered_at,
      },
    };

    return NextResponse.json(response, { status: 200 });
  } catch (error: unknown) {
    if (error instanceof TokenValidationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode }
      );
    }

    // Never log raw errors from token persistence; database details can contain
    // the registration token.
    console.error('API Error /api/v1/gateway/push-token PUT');
    return NextResponse.json(
      { error: 'Internal server error processing push token registration' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/v1/gateway/push-token
 * Invalidates active push tokens for the authenticated gateway.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateGateway(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const gatewayId = auth.context.gateway.id;
    // Invalidate all tokens belonging to this authenticated gateway. Tokens are
    // deliberately not accepted in URLs because query strings are commonly logged.
    const invalidatedCount = await PushTokenService.invalidateGatewayTokens(gatewayId);

    return NextResponse.json({
      success: true,
      data: {
        invalidated: true,
        count: invalidatedCount,
      },
    });
  } catch (error: unknown) {
    console.error('API Error /api/v1/gateway/push-token DELETE');
    return NextResponse.json(
      { error: 'Internal server error invalidating push token' },
      { status: 500 }
    );
  }
}
