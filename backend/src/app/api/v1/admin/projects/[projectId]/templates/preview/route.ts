import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isAdminUser } from '@/lib/admin/auth';
import { apiError } from '@/lib/admin/http';
import { previewTemplate } from '@/lib/templates/validator';
import { PreviewTemplateRequest } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  const admin = await requireAdmin(request);
  if (!isAdminUser(admin)) return admin;

  try {
    const body = (await request.json()) as PreviewTemplateRequest;

    if (!body || typeof body.body !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Field "body" is required and must be a string' },
        { status: 400 }
      );
    }

    const previewResult = previewTemplate(body.body, body.sample_variables || {});

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
