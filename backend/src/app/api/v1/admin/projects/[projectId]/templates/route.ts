import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isAdminUser } from '@/lib/admin/auth';
import { authorizeAdminMutation, apiError } from '@/lib/admin/http';
import { TemplateService } from '@/lib/templates/service';
import {
  assertValidTemplateType,
  assertValidTemplateStatus,
  TemplateValidationError,
  TemplateStateError,
} from '@/lib/templates/validator';
import { CreateTemplateRequest } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  const admin = await requireAdmin(request);
  if (!isAdminUser(admin)) return admin;

  try {
    const templates = await TemplateService.listTemplates(params.projectId);
    return NextResponse.json({ success: true, templates }, { status: 200 });
  } catch (error) {
    return apiError(error, 'Could not list templates');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } }
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
    const name = body?.name?.trim();
    const slug = body?.slug?.trim().toLowerCase();
    const templateBody = body?.body?.trim();

    if (!name || name.length > 100) {
      return NextResponse.json(
        { success: false, error: 'Template name is required (max 100 chars)' },
        { status: 400 }
      );
    }

    if (!slug || !/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
      return NextResponse.json(
        { success: false, error: 'Slug must be 3-50 lowercase alphanumeric characters with hyphens' },
        { status: 400 }
      );
    }

    if (!templateBody) {
      return NextResponse.json(
        { success: false, error: 'Template body is required' },
        { status: 400 }
      );
    }

    if (body.template_type) {
      assertValidTemplateType(body.template_type);
    }

    if (body.status !== undefined) {
      assertValidTemplateStatus(body.status);
      if (body.status !== 'DRAFT') {
        return NextResponse.json(
          { success: false, error: `Invalid status '${body.status}' for template creation. Templates must start in DRAFT status.` },
          { status: 400 }
        );
      }
    }

    const template = await TemplateService.createTemplate(
      params.projectId,
      body as CreateTemplateRequest,
      admin.email || admin.display_name
    );

    return NextResponse.json({ success: true, template }, { status: 201 });
  } catch (error: any) {
    if (error instanceof TemplateValidationError || error?.code === 'INVALID_TYPE' || error?.code === 'INVALID_STATUS' || error?.message?.startsWith('Template validation failed')) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    if (error instanceof TemplateStateError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 409 });
    }
    return apiError(error, 'Could not create template');
  }
}
