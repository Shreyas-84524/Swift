import { NextRequest, NextResponse } from 'next/server';
import { authorizeAdminMutation, apiError, isAdminUser } from '@/lib/admin/http';
import { TemplateService } from '@/lib/templates/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string; templateId: string } }
) {
  const admin = await authorizeAdminMutation(request);
  if (!isAdminUser(admin)) return admin;

  try {
    const success = await TemplateService.archiveTemplate(params.templateId, params.projectId);
    if (!success) {
      return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, archived: true }, { status: 200 });
  } catch (error: any) {
    return apiError(error, 'Could not archive template');
  }
}
