import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isAdminUser } from '@/lib/admin/auth';
import { apiError } from '@/lib/admin/http';
import { TemplateService } from '@/lib/templates/service';
import { previewTemplate } from '@/lib/templates/validator';
import { PreviewTemplateRequest } from '@/types';

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

    const templateBody = template.active_version?.body || template.latest_version?.body;
    if (!templateBody) {
      return NextResponse.json({ success: false, error: 'Template has no version body' }, { status: 400 });
    }

    const previewResult = previewTemplate(templateBody, {});
    if (!previewResult.success) {
      return NextResponse.json(
        { success: false, error: previewResult.error, code: previewResult.code },
        { status: 400 }
      );
    }

    const { renderedText, variables, segmentInfo } = previewResult.preview;

    return NextResponse.json(
      {
        success: true,
        data: {
          template_id: template.id,
          template_name: template.name,
          version_number: template.active_version?.version_number ?? template.latest_version?.version_number,
          rendered_text: renderedText,
          variables,
          encoding: segmentInfo.encoding,
          character_count: segmentInfo.characterCount,
          raw_length: segmentInfo.rawLength,
          segment_count: segmentInfo.segmentCount,
          max_characters_per_segment: segmentInfo.maxCharactersPerSegment,
          remaining_in_current_segment: segmentInfo.remainingInCurrentSegment,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    return apiError(error, 'Could not preview template');
  }
}

export async function POST(
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

    const body = (await request.json().catch(() => ({}))) as Partial<PreviewTemplateRequest>;
    const templateBody = body.body || template.active_version?.body || template.latest_version?.body;

    if (!templateBody) {
      return NextResponse.json({ success: false, error: 'Template body is missing' }, { status: 400 });
    }

    const previewResult = previewTemplate(templateBody, body.sample_variables || {});
    if (!previewResult.success) {
      return NextResponse.json(
        { success: false, error: previewResult.error, code: previewResult.code },
        { status: 400 }
      );
    }

    const { renderedText, variables, segmentInfo } = previewResult.preview;

    return NextResponse.json(
      {
        success: true,
        data: {
          template_id: template.id,
          template_name: template.name,
          version_number: template.active_version?.version_number ?? template.latest_version?.version_number,
          rendered_text: renderedText,
          variables,
          encoding: segmentInfo.encoding,
          character_count: segmentInfo.characterCount,
          raw_length: segmentInfo.rawLength,
          segment_count: segmentInfo.segmentCount,
          max_characters_per_segment: segmentInfo.maxCharactersPerSegment,
          remaining_in_current_segment: segmentInfo.remainingInCurrentSegment,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    return apiError(error, 'Could not preview template');
  }
}
