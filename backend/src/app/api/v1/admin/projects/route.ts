import { NextRequest, NextResponse } from 'next/server';
import { AdminService } from '@/lib/admin/service';
import { authorizeAdminMutation, apiError, isAdminUser } from '@/lib/admin/http';
import { validateTemplate } from '@/lib/templates/validator';

export async function POST(request: NextRequest) {
  const admin = await authorizeAdminMutation(request);
  if (!isAdminUser(admin)) return admin;

  try {
    const body = (await request.json()) as {
      name?: string;
      slug?: string;
      sms_template?: string;
      cooldown_seconds?: number;
      hourly_limit?: number;
      expiry_seconds?: number;
    };
    const name = body.name?.trim();
    const slug = body.slug?.trim().toLowerCase();
    if (!name || name.length > 100 || !slug || !/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
      return NextResponse.json({ success: false, error: 'Enter a name and a 3-50 character lowercase slug' }, { status: 400 });
    }
    if (body.sms_template) {
      const v = validateTemplate(body.sms_template, 'OTP');
      if (!v.valid) {
        return NextResponse.json({ success: false, error: v.error }, { status: 400 });
      }
    }
    const config = {
      sms_template: body.sms_template?.trim() || 'Your verification code is {{otp}}. It expires in {{expiry_minutes}} minutes.',
      cooldown_seconds: Math.min(Math.max(Number(body.cooldown_seconds) || 30, 10), 3600),
      hourly_limit: Math.min(Math.max(Number(body.hourly_limit) || 5, 1), 100),
      expiry_seconds: Math.min(Math.max(Number(body.expiry_seconds) || 300, 60), 1800),
    };
    const project = await AdminService.createProject(name, slug, config);
    return NextResponse.json({ success: true, project }, { status: 201 });
  } catch (error) {
    return apiError(error, 'Could not create project');
  }
}
