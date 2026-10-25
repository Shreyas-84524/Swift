import { NextRequest, NextResponse } from 'next/server';
import { authenticateGateway } from '@/lib/auth/middleware';
import { db } from '@/lib/db/client';
import { JsonBodyError, readBoundedJsonObject } from '@/lib/http/json-body';
import { GatewayHeartbeatRequest } from '@/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateGateway(request);
  if (!auth.success) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    let body: GatewayHeartbeatRequest;
    try {
      body = (await readBoundedJsonObject(request)) as unknown as GatewayHeartbeatRequest;
    } catch (error) {
      if (error instanceof JsonBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.statusCode });
      }
      throw error;
    }
    if (body.model !== undefined && (typeof body.model !== 'string' || body.model.length > 100)) {
      return NextResponse.json({ error: 'model must be a string of at most 100 characters' }, { status: 400 });
    }
    if (body.android_sdk !== undefined && (!Number.isInteger(body.android_sdk) || body.android_sdk < 24 || body.android_sdk > 100)) {
      return NextResponse.json({ error: 'android_sdk must be an integer between 24 and 100' }, { status: 400 });
    }
    if (body.app_version !== undefined && (typeof body.app_version !== 'string' || body.app_version.length > 20)) {
      return NextResponse.json({ error: 'app_version must be a string of at most 20 characters' }, { status: 400 });
    }
    if (body.sim_status !== undefined && (typeof body.sim_status !== 'string' || body.sim_status.length > 30)) {
      return NextResponse.json({ error: 'sim_status must be a string of at most 30 characters' }, { status: 400 });
    }
    if (body.battery_pct !== undefined && (!Number.isInteger(body.battery_pct) || body.battery_pct < 0 || body.battery_pct > 100)) {
      return NextResponse.json({ error: 'battery_pct must be an integer between 0 and 100' }, { status: 400 });
    }
    if (body.worker_enabled !== undefined && typeof body.worker_enabled !== 'boolean') {
      return NextResponse.json({ error: 'worker_enabled must be a boolean' }, { status: 400 });
    }
    const gatewayId = auth.context.gateway.id;

    const updates: string[] = ['last_seen_at = NOW()'];
    const params: unknown[] = [gatewayId];
    let idx = 2;

    if (body.model !== undefined) {
      updates.push(`model = $${idx++}`);
      params.push(body.model);
    }
    if (body.android_sdk !== undefined) {
      updates.push(`android_sdk = $${idx++}`);
      params.push(body.android_sdk);
    }
    if (body.app_version !== undefined) {
      updates.push(`app_version = $${idx++}`);
      params.push(body.app_version);
    }
    if (body.sim_status !== undefined) {
      updates.push(`sim_status = $${idx++}`);
      params.push(body.sim_status);
    }
    if (body.battery_pct !== undefined) {
      updates.push(`battery_pct = $${idx++}`);
      params.push(body.battery_pct);
    }
    if (body.worker_enabled !== undefined) {
      updates.push(`worker_enabled = $${idx++}`);
      params.push(body.worker_enabled);
    }

    await db.query(
      `UPDATE gateways SET ${updates.join(', ')} WHERE id = $1`,
      params
    );

    return NextResponse.json({
      success: true,
      data: {
        last_seen_at: new Date().toISOString(),
        backend_timestamp: Math.floor(Date.now() / 1000),
      },
    });
  } catch {
    console.error('API Error /api/v1/gateway/heartbeat');
    return NextResponse.json(
      { error: 'Internal error processing heartbeat' },
      { status: 500 }
    );
  }
}
