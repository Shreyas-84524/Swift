import { NextRequest, NextResponse } from 'next/server';
import { authorizeAdminMutation, apiError, isAdminUser } from '@/lib/admin/http';
import { TemplateService } from '@/lib/templates/service';
import { TemplateStateError, TemplateValidationError } from '@/lib/templates/validator';
import { ActivateTemplateRequest } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string; templateId: string } }
) {
  const admin = await authorizeAdminMutation(request);
  if (!isAdminUser(admin)) return admin;

  let body: Partial<ActivateTemplateRequest> = {};
  try {
    const text = await request.text();
    if (text && text.trim().length > 0) {
      body = JSON.parse(text);
    }
  } catch {
    return NextResponse.json({ success: false, error: 'Malformed JSON payload' }, { status: 400 });
  }

  try {
    const template = await TemplateService.activateTemplate(
      params.templateId,
      params.projectId,
      body.version_id
    );
    return NextResponse.json({ success: true, template }, { status: 200 });
  } catch (error: any) {
    if (error?.message === 'Template not found' || error?.message === 'Target version not found') {
      return NextResponse.json({ success: false, error: error.message }, { status: 404 });
    }
    if (error instanceof TemplateStateError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 409 });
    }
    if (error instanceof TemplateValidationError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return apiError(error, 'Could not activate template');
  }
}
