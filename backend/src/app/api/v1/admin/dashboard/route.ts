import { NextRequest, NextResponse } from 'next/server';
import { AdminService } from '@/lib/admin/service';
import { isAdminUser, requireAdmin } from '@/lib/admin/auth';
import { apiError } from '@/lib/admin/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!isAdminUser(admin)) return admin;

  try {
    const [projects, gateways, queue] = await Promise.all([
      AdminService.listProjects(),
      AdminService.listGateways(),
      AdminService.getQueueMetrics(),
    ]);
    const [projectKeys, gatewayKeys] = await Promise.all([
      Promise.all(projects.map(async (project) => [project.id, await AdminService.getProjectKeys(project.id)] as const)),
      Promise.all(gateways.map(async (gateway) => [gateway.id, await AdminService.getGatewayKeys(gateway.id)] as const)),
    ]);

    return NextResponse.json({
      success: true,
      admin: { display_name: admin.display_name, email: admin.email },
      projects: projects.map((project) => ({
        ...project,
        keys: Object.fromEntries(projectKeys)[project.id] ?? [],
      })),
      gateways: gateways.map((gateway) => ({
        ...gateway,
        keys: Object.fromEntries(gatewayKeys)[gateway.id] ?? [],
      })),
      queue,
    });
  } catch (error) {
    return apiError(error, 'Could not load dashboard');
  }
}
