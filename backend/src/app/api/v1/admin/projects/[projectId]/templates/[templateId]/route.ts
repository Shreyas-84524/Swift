import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isAdminUser } from '@/lib/admin/auth';
import { authorizeAdminMutation, apiError } from '@/lib/admin/http';
import { TemplateService } from '@/lib/templates/service';
import {
  TemplateValidationError,
  TemplateStateError,
} from '@/lib/templates/validator';
import { UpdateTemplateRequest } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string; templateId: string } }
) {
  const admin = await requireAdmin(request);
  if (!isAdminUser(admin)) return admin;

  try {
    const template = await TemplateService.getTemplate(params.templateId, params.projectId);
    if (!template) {
      return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, template }, { status: 200 });
  } catch (error) {
    return apiError(error, 'Could not retrieve template');
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { projectId: string; templateId: string } }
) {
  const admin = await authorizeAdminMutation(request);
  if (!isAdminUser(admin)) return admin;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Malformed JSON payload' }, { status: 400 });
  }

  try {
    if (body && ('status' in body || body.status !== undefined)) {
      return NextResponse.json(
        { success: false, error: 'Status cannot be updated via PATCH. Lifecycle changes must use approve, activate, or archive endpoints.' },
        { status: 400 }
      );
    }

    if (body && body.body !== undefined) {
      if (typeof body.body !== 'string' || body.body.trim().length === 0) {
        return NextResponse.json(
          { success: false, error: 'Template body cannot be empty' },
          { status: 400 }
        );
      }
    }

    const template = await TemplateService.updateTemplate(
      params.templateId,
      params.projectId,
      body as UpdateTemplateRequest,
      admin.email || admin.display_name
    );

    return NextResponse.json({ success: true, template }, { status: 200 });
  } catch (error: any) {
    if (error?.message === 'Template not found') {
      return NextResponse.json({ success: false, error: error.message }, { status: 404 });
    }
    if (error instanceof TemplateValidationError || error?.message?.startsWith('Template validation failed')) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    if (error instanceof TemplateStateError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 409 });
    }
    return apiError(error, 'Could not update template');
  }
}

export async function DELETE(
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
    return NextResponse.json({ success: true, message: 'Template archived' }, { status: 200 });
  } catch (error) {
    return apiError(error, 'Could not archive template');
  }
}

