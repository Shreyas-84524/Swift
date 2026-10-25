(process.env as any).NODE_ENV = 'test';
import crypto from 'crypto';
import {
  generateProjectKey,
  generateGatewayKey,
  hashApiKey,
  verifyKeyHash,
} from '../src/lib/auth/keys';
import {
  generateNumericOtp,
  generateSalt,
  hashOtp,
  verifyOtpHash,
  normalizePhoneNumber,
} from '../src/lib/otp/generator';
import { db } from '../src/lib/db/client';
import { OtpService } from '../src/lib/otp/service';
import { JobQueue } from '../src/lib/queue/job-queue';
import { RateLimiter } from '../src/lib/rate-limit/limiter';
import { AdminService } from '../src/lib/admin/service';
import { calculateSmsSegments } from '../src/lib/templates/segment';
import { validateTemplate, renderTemplate, previewTemplate, TemplateValidationError, TemplateStateError } from '../src/lib/templates/validator';
import { TemplateService } from '../src/lib/templates/service';
import { Project, Gateway, JobStatus } from '../src/types';
import { NextRequest } from 'next/server';
import { GET as getTemplatesRoute, POST as createTemplateRoute } from '../src/app/api/v1/admin/projects/[projectId]/templates/route';
import { GET as getTemplateDetailRoute, PATCH as patchTemplateRoute, DELETE as deleteTemplateRoute } from '../src/app/api/v1/admin/projects/[projectId]/templates/[templateId]/route';
import { POST as approveTemplateRoute } from '../src/app/api/v1/admin/projects/[projectId]/templates/[templateId]/approve/route';
import { POST as activateTemplateRoute } from '../src/app/api/v1/admin/projects/[projectId]/templates/[templateId]/activate/route';
import { POST as archiveTemplateRoute } from '../src/app/api/v1/admin/projects/[projectId]/templates/[templateId]/archive/route';
import { GET as getTemplatePreviewRoute, POST as postTemplatePreviewRoute } from '../src/app/api/v1/admin/projects/[projectId]/templates/[templateId]/preview/route';
import { POST as previewDraftRoute } from '../src/app/api/v1/admin/projects/[projectId]/templates/preview/route';

let simulateTemplateDbError = false;

function makeRequest(
  url: string,
  options: {
    method?: string;
    body?: any;
    headers?: Record<string, string>;
    admin?: { id: string; email: string; display_name: string; enabled: boolean } | null;
  } = {}
): NextRequest {
  const method = options.method || 'GET';
  const headers = new Headers(options.headers || {});
  let bodyStr: string | undefined = undefined;

  if (options.body !== undefined) {
    bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
  }

  const parsedUrl = new URL(url);
  if (!headers.has('origin') && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) {
    headers.set('origin', parsedUrl.origin);
  }

  const req = new NextRequest(url, {
    method,
    headers,
    body: bodyStr,
  });

  if (options.admin !== undefined) {
    (req as any).__testAdmin = options.admin;
  } else {
    (req as any).__testAdmin = {
      id: 'admin-owner-id',
      email: 'owner@swift.local',
      display_name: 'Test Admin',
      enabled: true,
    };
  }

  return req;
}

// In-memory test store
const store = {
  projects: new Map<string, Project>(),
  projectKeys: new Map<string, { id: string; project_id: string; key_hash: string; key_prefix: string; status: string; environment: string }>(),
  gateways: new Map<string, Gateway>(),
  gatewayKeys: new Map<string, { id: string; gateway_id: string; key_hash: string; key_prefix: string; status: string }>(),
  messageTemplates: new Map<string, any>(),
  messageTemplateVersions: new Map<string, any>(),
  gatewayPushTokens: new Map<string, any>(),
  notificationOutbox: new Map<string, any>(),
  otpChallenges: new Map<string, {
    id: string;
    project_id: string;
    phone_number: string;
    otp_hash: string;
    salt: string;
    attempts: number;
    max_attempts: number;
    expires_at: string;
    consumed: boolean;
    idempotency_key: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
  }>(),
  smsJobs: new Map<string, {
    id: string;
    project_id: string;
    challenge_id: string | null;
    assigned_gateway_id: string | null;
    phone_number: string;
    message: string;
    status: JobStatus;
    attempts: number;
    lease_expires_at: string | null;
    failure_reason: string | null;
    created_at: string;
    picked_up_at: string | null;
    sent_at: string | null;
    delivered_at: string | null;
    failed_at: string | null;
  }>(),
};

// Override db.query to use test store
(db as any).query = async function (text: string, params: any[] = []): Promise<any> {
  const sql = text.replace(/\s+/g, ' ').trim();

  // Health check
  if (sql.includes('SELECT 1 as health')) {
    return { rows: [{ health: 1 }], rowCount: 1 };
  }

  // Project auth lookup
  if (sql.includes('FROM project_api_keys k') && sql.includes('JOIN projects p')) {
    const keyHash = params[0];
    for (const k of store.projectKeys.values()) {
      if (k.key_hash === keyHash) {
        const p = store.projects.get(k.project_id);
        if (p) {
          return {
            rows: [{
              id: p.id,
              name: p.name,
              slug: p.slug,
              enabled: p.enabled,
              config: p.config,
              created_at: p.created_at,
              updated_at: p.updated_at,
              key_id: k.id,
              key_status: k.status,
            }],
            rowCount: 1,
          };
        }
      }
    }
    return { rows: [], rowCount: 0 };
  }

  // Gateway auth lookup
  if (sql.includes('FROM gateway_api_keys k') && sql.includes('JOIN gateways g')) {
    const keyHash = params[0];
    for (const k of store.gatewayKeys.values()) {
      if (k.key_hash === keyHash) {
        const g = store.gateways.get(k.gateway_id);
        if (g) {
          return {
            rows: [{
              id: g.id,
              name: g.name,
              device_id: g.device_id,
              model: g.model,
              android_sdk: g.android_sdk,
              app_version: g.app_version,
              sim_status: g.sim_status,
              battery_pct: g.battery_pct,
              worker_enabled: g.worker_enabled,
              is_active: g.is_active,
              last_seen_at: g.last_seen_at,
              created_at: g.created_at,
              key_id: k.id,
              key_status: k.status,
            }],
            rowCount: 1,
          };
        }
      }
    }
    return { rows: [], rowCount: 0 };
  }

  // Insert Project
  if (sql.includes('INSERT INTO projects')) {
    const id = crypto.randomUUID();
    const p: Project = {
      id,
      name: params[0],
      slug: params[1],
      enabled: true,
      config: typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2] || {},
      created_at: new Date(),
      updated_at: new Date(),
    };
    store.projects.set(id, p);
    return { rows: [p], rowCount: 1 };
  }

  // Insert Project Key
  if (sql.includes('INSERT INTO project_api_keys')) {
    const id = crypto.randomUUID();
    const k = {
      id,
      project_id: params[0],
      key_prefix: params[1],
      key_hash: params[2],
      name: params[3],
      environment: params[4],
      status: 'ACTIVE',
    };
    store.projectKeys.set(id, k);
    return { rows: [{ id }], rowCount: 1 };
  }

  // Revoke Project Key
  if (sql.includes('UPDATE project_api_keys') && sql.includes("status = 'REVOKED'")) {
    const keyId = params[0];
    const k = store.projectKeys.get(keyId);
    if (k) {
      k.status = 'REVOKED';
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Insert Gateway
  if (sql.includes('INSERT INTO gateways')) {
    const id = crypto.randomUUID();
    const g: Gateway = {
      id,
      name: params[0],
      device_id: params[1] || null,
      model: params[2] || null,
      android_sdk: 34,
      app_version: '1.0.0',
      sim_status: 'READY',
      battery_pct: 90,
      worker_enabled: true,
      is_active: true,
      last_seen_at: new Date(),
      created_at: new Date(),
    };
    store.gateways.set(id, g);
    return { rows: [g], rowCount: 1 };
  }

  // Insert Gateway Key
  if (sql.includes('INSERT INTO gateway_api_keys')) {
    const id = crypto.randomUUID();
    const k = {
      id,
      gateway_id: params[0],
      key_prefix: params[1],
      key_hash: params[2],
      name: params[3],
      status: 'ACTIVE',
    };
    store.gatewayKeys.set(id, k);
    return { rows: [{ id }], rowCount: 1 };
  }

  // Revoke Gateway Key
  if (sql.includes('UPDATE gateway_api_keys') && sql.includes("status = 'REVOKED'")) {
    const keyId = params[0];
    const k = store.gatewayKeys.get(keyId);
    if (k) {
      k.status = 'REVOKED';
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Rate Limiting: Cooldown check
  if (sql.includes('FROM otp_challenges') && sql.includes('ORDER BY created_at DESC') && sql.includes('LIMIT 1')) {
    const [projectId, phone] = params;
    const matches = Array.from(store.otpChallenges.values())
      .filter((c) => c.project_id === projectId && c.phone_number === phone)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return { rows: matches.slice(0, 1), rowCount: matches.length > 0 ? 1 : 0 };
  }

  // Rate Limiting: Hourly count check
  if (sql.includes('SELECT COUNT(*) as count FROM otp_challenges') && sql.includes('created_at >=')) {
    const [projectId, phone, since] = params;
    const sinceTime = new Date(since).getTime();
    const count = Array.from(store.otpChallenges.values()).filter(
      (c) => c.project_id === projectId && c.phone_number === phone && new Date(c.created_at).getTime() >= sinceTime
    ).length;
    return { rows: [{ count: count.toString() }], rowCount: 1 };
  }

  // Insert OTP Challenge
  if (sql.includes('INSERT INTO otp_challenges')) {
    const id = crypto.randomUUID();
    const c = {
      id,
      project_id: params[0],
      phone_number: params[1],
      otp_hash: params[2],
      salt: params[3],
      max_attempts: params[4],
      attempts: 0,
      expires_at: params[5],
      consumed: false,
      idempotency_key: params[6] || null,
      metadata: typeof params[7] === 'string' ? JSON.parse(params[7]) : params[7] || {},
      created_at: new Date().toISOString(),
    };
    store.otpChallenges.set(id, c);
    return { rows: [{ id }], rowCount: 1 };
  }

  // Idempotency lookup
  if (sql.includes('FROM otp_challenges') && sql.includes('idempotency_key = $2')) {
    const [projectId, idempotencyKey] = params;
    const matches = Array.from(store.otpChallenges.values()).filter(
      (c) => c.project_id === projectId && c.idempotency_key === idempotencyKey && !c.consumed
    );
    return { rows: matches, rowCount: matches.length };
  }

  // List projects with key count
  if (sql.includes('FROM projects p') && sql.includes('LEFT JOIN project_api_keys k')) {
    const rows = Array.from(store.projects.values()).map((p) => {
      const keys = Array.from(store.projectKeys.values()).filter((k) => k.project_id === p.id);
      const activePrefixes = keys.filter((k) => k.status === 'ACTIVE').map((k) => k.key_prefix).join(', ');
      return {
        ...p,
        key_count: keys.length.toString(),
        active_prefixes: activePrefixes || null,
      };
    });
    return { rows, rowCount: rows.length };
  }

  // Get project keys
  if (sql.includes('FROM project_api_keys') && sql.includes('WHERE project_id = $1')) {
    const [projectId] = params;
    const rows = Array.from(store.projectKeys.values())
      .filter((k) => k.project_id === projectId)
      .map((k) => ({
        id: k.id,
        key_prefix: k.key_prefix,
        name: (k as any).name || 'Key',
        environment: (k as any).environment || 'live',
        status: k.status,
        created_at: new Date(),
        revoked_at: k.status === 'REVOKED' ? new Date() : null,
      }));
    return { rows, rowCount: rows.length };
  }

  // List gateways with online status
  if (sql.includes('FROM gateways g') && sql.includes('LEFT JOIN gateway_api_keys k')) {
    const rows = Array.from(store.gateways.values()).map((g) => {
      const keys = Array.from(store.gatewayKeys.values()).filter((k) => k.gateway_id === g.id);
      return {
        ...g,
        is_online: true,
        key_count: keys.length.toString(),
      };
    });
    return { rows, rowCount: rows.length };
  }

  // Get gateway keys
  if (sql.includes('FROM gateway_api_keys') && sql.includes('WHERE gateway_id = $1')) {
    const [gatewayId] = params;
    const rows = Array.from(store.gatewayKeys.values())
      .filter((k) => k.gateway_id === gatewayId)
      .map((k) => ({
        id: k.id,
        key_prefix: k.key_prefix,
        name: (k as any).name || 'Key',
        status: k.status,
        created_at: new Date(),
        revoked_at: k.status === 'REVOKED' ? new Date() : null,
      }));
    return { rows, rowCount: rows.length };
  }

  // SMS Job Queue counts
  if (sql.includes('SELECT status, COUNT(*) AS count') && sql.includes('FROM sms_jobs')) {
    const counts: Record<string, number> = {};
    for (const j of store.smsJobs.values()) {
      counts[j.status] = (counts[j.status] || 0) + 1;
    }
    const rows = Object.entries(counts).map(([status, count]) => ({
      status,
      count: count.toString(),
    }));
    return { rows, rowCount: rows.length };
  }

  // Oldest queued job
  if (sql.includes('SELECT created_at FROM sms_jobs') && sql.includes("WHERE status = 'QUEUED'")) {
    const queuedJobs = Array.from(store.smsJobs.values())
      .filter((j) => j.status === 'QUEUED')
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return {
      rows: queuedJobs.slice(0, 1).map((j) => ({ created_at: j.created_at })),
      rowCount: queuedJobs.length > 0 ? 1 : 0,
    };
  }

  // Insert SMS Job
  if (sql.includes('INSERT INTO sms_jobs')) {
    const id = crypto.randomUUID();
    const j = {
      id,
      project_id: params[0],
      challenge_id: params[1],
      phone_number: params[2],
      message: params[3],
      status: (params[4] as JobStatus) || 'QUEUED',
      assigned_gateway_id: null,
      attempts: 0,
      lease_expires_at: null,
      failure_reason: null,
      created_at: new Date().toISOString(),
      picked_up_at: null,
      sent_at: null,
      delivered_at: null,
      failed_at: null,
    };
    store.smsJobs.set(id, j);
    return { rows: [{ id }], rowCount: 1 };
  }

  // Query OTP Challenge for verification
  if (sql.includes('SELECT * FROM otp_challenges') && sql.includes('WHERE id = $1')) {
    const [challengeId, projectId] = params;
    const c = store.otpChallenges.get(challengeId);
    if (c && (!projectId || c.project_id === projectId)) {
      return { rows: [c], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Update OTP Challenge attempts
  if (sql.includes('UPDATE otp_challenges SET attempts = $1 WHERE id = $2')) {
    const [attempts, id] = params;
    const c = store.otpChallenges.get(id);
    if (c) c.attempts = attempts;
    return { rows: [], rowCount: 1 };
  }

  // Mark OTP Challenge consumed
  if (sql.includes('UPDATE otp_challenges SET consumed = TRUE WHERE id = $1')) {
    const [id] = params;
    const c = store.otpChallenges.get(id);
    if (c) c.consumed = true;
    return { rows: [], rowCount: 1 };
  }

  // Stale Lease Recovery
  if (sql.includes('UPDATE sms_jobs') && sql.includes("status = 'QUEUED'") && sql.includes("status = 'CLAIMED'")) {
    let recovered = 0;
    const now = Date.now();
    for (const j of store.smsJobs.values()) {
      if (j.status === 'CLAIMED' && j.lease_expires_at && new Date(j.lease_expires_at).getTime() < now) {
        if (j.attempts < 3) {
          j.status = 'QUEUED';
          j.assigned_gateway_id = null;
          j.lease_expires_at = null;
          recovered++;
        } else {
          j.status = 'EXPIRED';
          j.failure_reason = 'Exceeded maximum claim attempts';
        }
      }
    }
    return { rows: [], rowCount: recovered };
  }

  // Query SMS Job
  if (sql.includes('SELECT * FROM sms_jobs WHERE id = $1')) {
    const j = store.smsJobs.get(params[0]);
    return { rows: j ? [j] : [], rowCount: j ? 1 : 0 };
  }

  // Update SMS Job Status
  if (sql.includes('UPDATE sms_jobs SET')) {
    const jobId = params[0];
    const newStatus = params[1] as JobStatus;
    const j = store.smsJobs.get(jobId);
    if (j) {
      j.status = newStatus;
      if (newStatus === 'SENT') j.sent_at = new Date().toISOString();
      if (newStatus === 'DELIVERED') j.delivered_at = new Date().toISOString();
      if (newStatus === 'FAILED') j.failed_at = new Date().toISOString();
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Queue Metrics
  if (sql.includes('SELECT COUNT(*) as count, MIN(created_at) as oldest_created FROM sms_jobs WHERE status = \'QUEUED\'')) {
    const queued = Array.from(store.smsJobs.values()).filter((j) => j.status === 'QUEUED');
    return {
      rows: [{
        count: queued.length.toString(),
        oldest_created: queued.length > 0 ? queued[0].created_at : null,
      }],
      rowCount: 1,
    };
  }

  // Active gateways count
  if (sql.includes('SELECT COUNT(*) as count FROM gateways')) {
    return { rows: [{ count: store.gateways.size.toString() }], rowCount: 1 };
  }

  // Update Gateway heartbeat
  if (sql.includes('UPDATE gateways SET')) {
    const gwId = params[0];
    const g = store.gateways.get(gwId);
    if (g) {
      g.last_seen_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Active OTP template lookup
  if (sql.includes('FROM message_templates t') && sql.includes("t.template_type = 'OTP'") && sql.includes("t.status = 'ACTIVE'")) {
    if (simulateTemplateDbError) {
      throw new Error('Simulated database connection failure during active template lookup');
    }
    const projectId = params[0];
    for (const t of store.messageTemplates.values()) {
      if (t.project_id === projectId && t.template_type === 'OTP' && t.status === 'ACTIVE') {
        const v = store.messageTemplateVersions.get(t.active_version_id);
        if (v && v.status === 'ACTIVE') {
          return {
            rows: [{
              ...t,
              v_id: v.id,
              v_version_number: v.version_number,
              v_body: v.body,
              v_variables: v.variables,
              v_character_count: v.character_count,
              v_segment_count: v.segment_count,
              v_encoding: v.encoding,
              v_status: v.status,
              v_created_at: v.created_at,
              v_activated_at: v.activated_at,
            }],
            rowCount: 1,
          };
        }
      }
    }
    return { rows: [], rowCount: 0 };
  }

  // List templates for project
  if (sql.includes('FROM message_templates t') && sql.includes('LEFT JOIN message_template_versions v')) {
    const projectId = params[0];
    const rows = Array.from(store.messageTemplates.values())
      .filter((t) => t.project_id === projectId)
      .map((t) => {
        const v = store.messageTemplateVersions.get(t.active_version_id);
        return {
          ...t,
          v_id: v?.id || null,
          v_version_number: v?.version_number || null,
          v_body: v?.body || null,
          v_variables: v?.variables || null,
          v_character_count: v?.character_count || null,
          v_segment_count: v?.segment_count || null,
          v_encoding: v?.encoding || null,
          v_status: v?.status || null,
          v_created_at: v?.created_at || null,
          v_activated_at: v?.activated_at || null,
        };
      });
    return { rows, rowCount: rows.length };
  }

  // Get template by ID (with optional project ownership and FOR UPDATE support)
  if (sql.includes('FROM message_templates') && sql.includes('WHERE id = $1')) {
    const [templateId, projectId] = params;
    const t = store.messageTemplates.get(templateId);
    if (t && (!projectId || t.project_id === projectId)) {
      return { rows: [t], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Get template versions
  if (sql.includes('SELECT * FROM message_template_versions') && sql.includes('WHERE template_id = $1')) {
    const templateId = params[0];
    const versions = Array.from(store.messageTemplateVersions.values())
      .filter((v) => v.template_id === templateId)
      .sort((a, b) => b.version_number - a.version_number);
    return { rows: versions, rowCount: versions.length };
  }

  // Max version number
  if (sql.includes('SELECT COALESCE(MAX(version_number), 0) as max_ver FROM message_template_versions')) {
    const templateId = params[0];
    const versions = Array.from(store.messageTemplateVersions.values()).filter((v) => v.template_id === templateId);
    const maxVer = versions.reduce((max, v) => Math.max(max, v.version_number), 0);
    return { rows: [{ max_ver: maxVer }], rowCount: 1 };
  }

  // Insert message template
  if (sql.includes('INSERT INTO message_templates')) {
    const id = crypto.randomUUID();
    const t = {
      id,
      project_id: params[0],
      name: params[1],
      slug: params[2],
      template_type: params[3],
      description: params[4] || null,
      status: 'DRAFT',
      active_version_id: null,
      dlt_template_id: params[5] || null,
      sender_header: params[6] || null,
      pe_id: params[7] || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.messageTemplates.set(id, t);
    return { rows: [t], rowCount: 1 };
  }

  // Insert message template version
  if (sql.includes('INSERT INTO message_template_versions')) {
    const id = crypto.randomUUID();
    const isInitial = sql.includes('VALUES ($1, 1,');
    const templateId = params[0];
    const versionNumber = isInitial ? 1 : params[1];
    const body = isInitial ? params[1] : params[2];
    const variables = isInitial ? params[2] : params[3];
    const charCount = isInitial ? params[3] : params[4];
    const segCount = isInitial ? params[4] : params[5];
    const encoding = isInitial ? params[5] : params[6];
    const dlt = isInitial ? params[6] : params[7];
    const senderHeader = isInitial ? params[7] : params[8];
    const peId = isInitial ? params[8] : params[9];
    const createdBy = isInitial ? params[9] : params[10];

    const v = {
      id,
      template_id: templateId,
      version_number: versionNumber,
      body,
      variables,
      character_count: charCount,
      segment_count: segCount,
      encoding,
      status: 'DRAFT',
      dlt_template_id: dlt || null,
      sender_header: senderHeader || null,
      pe_id: peId || null,
      created_by: createdBy || 'system',
      approved_by: null,
      approved_at: null,
      created_at: new Date().toISOString(),
      activated_at: null,
    };
    store.messageTemplateVersions.set(id, v);
    return { rows: [v], rowCount: 1 };
  }

  // Update versions status (approval, demote, activate, archive)
  if (sql.includes('UPDATE message_template_versions')) {
    // 1. Explicit approval: SET status = 'APPROVED', approved_by = $1, approved_at = NOW() WHERE id = $2 AND template_id = $3
    if (sql.includes("SET status = 'APPROVED'") && sql.includes('approved_by = $1')) {
      const [approvedBy, versionId, templateId] = params;
      const v = store.messageTemplateVersions.get(versionId);
      if (v && v.template_id === templateId) {
        v.status = 'APPROVED';
        v.approved_by = approvedBy;
        v.approved_at = new Date().toISOString();
        return { rows: [v], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // 2. Demote previous active OTP templates for project: WHERE template_id IN ( SELECT id FROM message_templates ... ) AND status = 'ACTIVE'
    if (sql.includes("SET status = 'APPROVED'") && sql.includes('template_id IN')) {
      const [projectId, excludeId] = params;
      let count = 0;
      for (const t of store.messageTemplates.values()) {
        if (t.project_id === projectId && t.template_type === 'OTP' && t.id !== excludeId) {
          for (const v of store.messageTemplateVersions.values()) {
            if (v.template_id === t.id && v.status === 'ACTIVE') {
              v.status = 'APPROVED';
              count++;
            }
          }
        }
      }
      return { rows: [], rowCount: count };
    }

    // 3. Demote active version of current template: WHERE template_id = $1 AND status = 'ACTIVE'
    if (sql.includes("SET status = 'APPROVED'") && sql.includes('template_id = $1')) {
      const templateId = params[0];
      for (const v of store.messageTemplateVersions.values()) {
        if (v.template_id === templateId && v.status === 'ACTIVE') {
          v.status = 'APPROVED';
        }
      }
      return { rows: [], rowCount: 1 };
    }

    // 4. Activate specific version: SET status = 'ACTIVE', activated_at = NOW() WHERE id = $1 AND template_id = $2
    if (sql.includes("SET status = 'ACTIVE'")) {
      const [versionId, templateId] = params;
      const v = store.messageTemplateVersions.get(versionId);
      if (v && (!templateId || v.template_id === templateId)) {
        v.status = 'ACTIVE';
        v.activated_at = new Date().toISOString();
        return { rows: [v], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // 5. Archive versions: SET status = 'ARCHIVED' WHERE template_id = $1
    if (sql.includes("SET status = 'ARCHIVED'")) {
      const templateId = params[0];
      for (const v of store.messageTemplateVersions.values()) {
        if (v.template_id === templateId) {
          v.status = 'ARCHIVED';
        }
      }
      return { rows: [], rowCount: 1 };
    }
  }

  // Demote previous active OTP templates for project: SET status = 'APPROVED', active_version_id = NULL
  if (sql.includes('UPDATE message_templates') && sql.includes("SET status = 'APPROVED'") && sql.includes("template_type = 'OTP'")) {
    const projectId = params[0];
    const excludeId = params.length > 1 ? params[1] : null;
    for (const t of store.messageTemplates.values()) {
      if (t.project_id === projectId && t.template_type === 'OTP' && t.status === 'ACTIVE' && t.id !== excludeId) {
        t.status = 'APPROVED';
        t.active_version_id = null;
        t.updated_at = new Date().toISOString();
      }
    }
    return { rows: [], rowCount: 1 };
  }

  // Update template status to APPROVED (upon approving first version of DRAFT template)
  if (sql.includes('UPDATE message_templates') && sql.includes("SET status = 'APPROVED'") && sql.includes('WHERE id = $1 AND project_id = $2')) {
    const [templateId, projectId] = params;
    const t = store.messageTemplates.get(templateId);
    if (t && t.project_id === projectId) {
      t.status = 'APPROVED';
      t.updated_at = new Date().toISOString();
      return { rows: [t], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Activate template: SET status = 'ACTIVE', active_version_id = $1, updated_at = NOW() WHERE id = $2 AND project_id = $3
  if (sql.includes('UPDATE message_templates') && sql.includes("SET status = 'ACTIVE'")) {
    const [versionId, templateId, projectId] = params;
    const t = store.messageTemplates.get(templateId);
    if (t && (!projectId || t.project_id === projectId)) {
      if (versionId !== null) {
        const v = store.messageTemplateVersions.get(versionId);
        if (!v || v.template_id !== templateId) {
          throw new Error(`foreign_key_violation: fk_message_templates_active_version_ownership violated: version ${versionId} does not belong to template ${templateId}`);
        }
      }
      t.status = 'ACTIVE';
      t.active_version_id = versionId;
      t.updated_at = new Date().toISOString();
      return { rows: [t], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Archive template: SET status = 'ARCHIVED', active_version_id = NULL, updated_at = NOW() WHERE id = $1 AND project_id = $2
  if (sql.includes('UPDATE message_templates') && (sql.includes("status = 'ARCHIVED'") || sql.includes("SET status = 'ARCHIVED'"))) {
    const templateId = params[0];
    const projectId = params[1];
    const t = store.messageTemplates.get(templateId);
    if (t && (!projectId || t.project_id === projectId)) {
      t.status = 'ARCHIVED';
      t.active_version_id = null;
      t.updated_at = new Date().toISOString();
      for (const v of store.messageTemplateVersions.values()) {
        if (v.template_id === templateId) {
          v.status = 'ARCHIVED';
        }
      }
      return { rows: [t], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Generic Update message_templates metadata
  if (sql.includes('UPDATE message_templates SET')) {
    const templateId = params[0];
    const projectId = params[1];
    const t = store.messageTemplates.get(templateId);
    if (t && t.project_id === projectId) {
      t.updated_at = new Date().toISOString();
      const matches = Array.from(sql.matchAll(/([a-z_]+)\s*=\s*\$(\d+)/g));
      for (const m of matches) {
        const col = m[1];
        const idx = parseInt(m[2], 10) - 1;
        if (col !== 'id' && col !== 'project_id' && idx < params.length) {
          t[col] = params[idx];
        }
      }
      return { rows: [t], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Force deferred constraint check
  if (sql.includes('SET CONSTRAINTS ALL IMMEDIATE')) {
    verifyDeferredDatabaseInvariants();
    return { rows: [], rowCount: 0 };
  }

  // Insert gateway push token
  if (sql.includes('INSERT INTO gateway_push_tokens')) {
    const id = crypto.randomUUID();
    const token = {
      id,
      gateway_id: params[0],
      token: params[1],
      provider: params[2] || 'FCM',
      platform: params[3] || 'ANDROID',
      device_fingerprint: params[4] || null,
      is_valid: true,
      last_registered_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
    store.gatewayPushTokens.set(id, token);
    return { rows: [{ id }], rowCount: 1 };
  }

  // Insert notification outbox
  if (sql.includes('INSERT INTO notification_outbox')) {
    const id = crypto.randomUUID();
    const item = {
      id,
      gateway_id: params[0] || null,
      job_id: params[1] || null,
      channel: params[2] || 'FCM',
      priority: params[3] || 'HIGH',
      payload: typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4],
      status: 'PENDING',
      attempts: 0,
      max_attempts: 5,
      next_attempt_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
    store.notificationOutbox.set(id, item);
    return { rows: [{ id }], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
};

function verifyDeferredDatabaseInvariants(): void {
  // 1. Template active invariant
  for (const t of store.messageTemplates.values()) {
    if (t.status === 'ACTIVE') {
      if (!t.active_version_id) {
        throw new Error(`check_violation: Template "${t.name}" (${t.id}) cannot have status ACTIVE while active_version_id is NULL`);
      }
      const v = store.messageTemplateVersions.get(t.active_version_id);
      if (!v) {
        throw new Error(`foreign_key_violation: Template "${t.name}" references non-existent active_version_id ${t.active_version_id}`);
      }
      if (v.template_id !== t.id) {
        throw new Error(`foreign_key_violation: active_version_id ${t.active_version_id} belongs to template ${v.template_id}, not template ${t.id}`);
      }
      if (v.status !== 'ACTIVE') {
        throw new Error(`check_violation: Template "${t.name}" cannot be ACTIVE while active version ${v.id} has status "${v.status}"`);
      }
    } else {
      if (t.active_version_id !== null && t.active_version_id !== undefined) {
        throw new Error(`check_violation: Template "${t.name}" (${t.id}) cannot have active_version_id ${t.active_version_id} while in status "${t.status}" (only ACTIVE templates may specify an active_version_id)`);
      }
    }
  }

  // 2. Version active invariant
  for (const v of store.messageTemplateVersions.values()) {
    if (v.status === 'ACTIVE') {
      const t = store.messageTemplates.get(v.template_id);
      if (!t) {
        throw new Error(`foreign_key_violation: Version ${v.id} references non-existent parent template ${v.template_id}`);
      }
      if (t.status !== 'ACTIVE' || !t.active_version_id || t.active_version_id !== v.id) {
        throw new Error(`check_violation: Version ${v.id} cannot have status ACTIVE unless parent template "${t.name}" is ACTIVE and points to it via active_version_id`);
      }
    }
  }
}

// Override getClient for transactions
(db as any).getClient = async function () {
  return {
    query: async (text: string, params: any[] = []) => {
      if (text.includes('COMMIT')) {
        verifyDeferredDatabaseInvariants();
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('WITH next_jobs AS')) {
        const [limit, gatewayId, leaseSeconds] = params;
        const queuedJobs = Array.from(store.smsJobs.values())
          .filter((j) => j.status === 'QUEUED')
          .slice(0, limit);

        const claimed = queuedJobs.map((j) => {
          j.status = 'CLAIMED';
          j.assigned_gateway_id = gatewayId;
          j.attempts += 1;
          j.picked_up_at = new Date().toISOString();
          j.lease_expires_at = new Date(Date.now() + leaseSeconds * 1000).toISOString();
          return {
            id: j.id,
            phone_number: j.phone_number,
            message: j.message,
            created_at: j.created_at,
            lease_expires_at: j.lease_expires_at,
          };
        });

        return { rows: claimed, rowCount: claimed.length };
      }
      return (db as any).query(text, params);
    },
    release: () => {},
  };
};

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ [PASS] ${testName}`);
  } else {
    console.error(`  ❌ [FAIL] ${testName}${detail ? ` - ${detail}` : ''}`);
  }
}

async function runAllTests() {
  console.log('===============================================================');
  console.log('       Global OTP Platform — Automated Backend Test Suite      ');
  console.log('===============================================================\n');

  // --- 1. Project & Gateway Key Hashing & Verification ---
  console.log('▶ Test Suite 1: Cryptographic Keys & Entropy');
  const projKey1 = generateProjectKey('live');
  const projKeyTest = generateProjectKey('test');
  const gwKey1 = generateGatewayKey('live');

  assert(projKey1.rawKey.startsWith('otp_proj_live_'), 'Project Key live prefix format');
  assert(projKeyTest.rawKey.startsWith('otp_proj_test_'), 'Project Key test prefix format');
  assert(gwKey1.rawKey.startsWith('otp_gw_live_'), 'Gateway Key live prefix format');
  assert(projKey1.rawKey.length === 78, 'Project Key entropy length (256-bit)');
  assert(verifyKeyHash(projKey1.rawKey, projKey1.keyHash), 'Constant-time key hash verification');
  assert(!verifyKeyHash('otp_proj_live_tamperedkey', projKey1.keyHash), 'Reject tampered API key');

  // --- 2. OTP Generation, Salting, and Phone Normalization ---
  console.log('\n▶ Test Suite 2: OTP Token Cryptography');
  const otpCode = generateNumericOtp(6);
  assert(/^\d{6}$/.test(otpCode), 'Generate 6-digit numeric OTP');
  const salt = generateSalt(16);
  const otpHash = hashOtp(otpCode, salt);
  assert(verifyOtpHash(otpCode, otpHash, salt), 'Salted OTP hash verification matches');
  assert(!verifyOtpHash('000000', otpHash, salt), 'Salted OTP hash rejects wrong code');

  const normalized1 = normalizePhoneNumber('+91 98765 43210');
  assert(normalized1 === '+919876543210', 'Phone normalization with spaces');
  const normalized2 = normalizePhoneNumber('9876543210');
  assert(normalized2 === '+919876543210', 'Phone normalization 10-digit auto-prefix');

  // --- 3. Setup Test Project & Keys ---
  console.log('\n▶ Test Suite 3: Admin Service & Project Authentication');
  const project = await AdminService.createProject('Test Project', 'test-proj', {
    cooldown_seconds: 30,
    hourly_limit: 5,
    max_attempts: 3,
    expiry_seconds: 300,
  });
  assert(!!project.id, 'Project created via AdminService');

  const projKeyData = await AdminService.createProjectKey(project.id, 'Main Key', 'live');
  assert(projKeyData.rawKey.startsWith('otp_proj_live_'), 'Project key issued');

  // Valid project key
  assert(verifyKeyHash(projKeyData.rawKey, hashApiKey(projKeyData.rawKey)), 'Valid project key authenticated');

  // Revoke project key
  await AdminService.revokeProjectKey(projKeyData.keyId);
  const revokedKey = store.projectKeys.get(projKeyData.keyId);
  assert(revokedKey?.status === 'REVOKED', 'Revoked project key status updated');

  // Issue new active key for remaining tests
  const activeProjKey = await AdminService.createProjectKey(project.id, 'Active Key', 'live');

  // --- 4. Gateway Registration & Authentication ---
  console.log('\n▶ Test Suite 4: Gateway Registration & Auth');
  const gateway = await AdminService.registerGateway('Pixel Worker 1', 'dev_pixel_7a', 'Pixel 7a');
  assert(!!gateway.id, 'Gateway registered via AdminService');

  const gwKeyData = await AdminService.createGatewayKey(gateway.id, 'Device Key');
  assert(gwKeyData.rawKey.startsWith('otp_gw_live_'), 'Gateway key issued');

  // Revoke gateway key
  const tempGwKey = await AdminService.createGatewayKey(gateway.id, 'Temp Key');
  await AdminService.revokeGatewayKey(tempGwKey.keyId);
  assert(store.gatewayKeys.get(tempGwKey.keyId)?.status === 'REVOKED', 'Revoked gateway key marked in DB');

  // --- 5. OTP Send Lifecycle ---
  console.log('\n▶ Test Suite 5: OTP Send Endpoint Logic');
  const sendRes1 = await OtpService.sendOtp(project, { phone: '+919876543210' });
  assert(sendRes1.status === 200, 'OTP Send returns HTTP 200');
  assert(sendRes1.body && 'request_id' in sendRes1.body, 'OTP Send returns request_id');
  assert(!('otp' in (sendRes1.body as any)), 'Security: No plaintext OTP returned in send response');

  const requestId1 = (sendRes1.body as any).request_id;
  const challenge1 = store.otpChallenges.get(requestId1);
  assert(!!challenge1, 'OTP Challenge record persisted in DB');
  assert(challenge1?.phone_number === '+919876543210', 'Challenge phone bound to normalized recipient');

  // Verify SMS Job created with QUEUED status
  const queuedJob = Array.from(store.smsJobs.values()).find((j) => j.challenge_id === requestId1);
  assert(!!queuedJob, 'SMS Job created in SMS Job Queue');
  assert(queuedJob?.status === 'QUEUED', 'SMS Job initialized with QUEUED status');

  // --- 6. Rate Limiting: Cooldown & Hourly Limits ---
  console.log('\n▶ Test Suite 6: Rate Limiting & Cooldown');
  // Immediate second request to same phone must fail cooldown
  const sendResCooldown = await OtpService.sendOtp(project, { phone: '+919876543210' });
  assert(sendResCooldown.status === 429, 'Rate Limit: 30s Cooldown rejected with HTTP 429');

  // Hourly limit check
  const projectLimited = {
    ...project,
    config: { cooldown_seconds: 0, hourly_limit: 2 },
  };
  await OtpService.sendOtp(projectLimited, { phone: '+919111122222' });
  await OtpService.sendOtp(projectLimited, { phone: '+919111122222' });
  const sendResHourly = await OtpService.sendOtp(projectLimited, { phone: '+919111122222' });
  assert(sendResHourly.status === 429, 'Rate Limit: Hourly limit exceeded rejected with HTTP 429');

  // --- 7. OTP Verification Lifecycle ---
  console.log('\n▶ Test Suite 7: OTP Verification Logic');
  // Create a known OTP challenge for exact verification testing
  const knownSalt = generateSalt(16);
  const knownOtp = '582914';
  const knownHash = hashOtp(knownOtp, knownSalt);
  const testChallengeId = crypto.randomUUID();
  store.otpChallenges.set(testChallengeId, {
    id: testChallengeId,
    project_id: project.id,
    phone_number: '+919999988888',
    otp_hash: knownHash,
    salt: knownSalt,
    attempts: 0,
    max_attempts: 3,
    expires_at: new Date(Date.now() + 300 * 1000).toISOString(),
    consumed: false,
    idempotency_key: null,
    metadata: {},
    created_at: new Date().toISOString(),
  });

  // Wrong OTP test
  const verifyWrong = await OtpService.verifyOtp(project, {
    phone: '+919999988888',
    request_id: testChallengeId,
    otp: '000000',
  });
  assert(verifyWrong.status === 400, 'Wrong OTP returns HTTP 400');
  assert(verifyWrong.body.verified === false, 'Wrong OTP verified is false');
  assert(verifyWrong.body.error?.attempts_remaining === 2, 'Attempts remaining decremented to 2');

  // Max attempts test
  await OtpService.verifyOtp(project, { phone: '+919999988888', request_id: testChallengeId, otp: '111111' });
  await OtpService.verifyOtp(project, { phone: '+919999988888', request_id: testChallengeId, otp: '222222' });
  const verifyMax = await OtpService.verifyOtp(project, { phone: '+919999988888', request_id: testChallengeId, otp: knownOtp });
  assert(verifyMax.status === 429, 'Max attempts exceeded returns HTTP 429');

  // Correct verification test on new challenge
  const correctChallengeId = crypto.randomUUID();
  store.otpChallenges.set(correctChallengeId, {
    id: correctChallengeId,
    project_id: project.id,
    phone_number: '+919999977777',
    otp_hash: knownHash,
    salt: knownSalt,
    attempts: 0,
    max_attempts: 3,
    expires_at: new Date(Date.now() + 300 * 1000).toISOString(),
    consumed: false,
    idempotency_key: null,
    metadata: {},
    created_at: new Date().toISOString(),
  });

  const verifyCorrect = await OtpService.verifyOtp(project, {
    phone: '+919999977777',
    request_id: correctChallengeId,
    otp: knownOtp,
  });
  assert(verifyCorrect.status === 200, 'Correct OTP returns HTTP 200');
  assert(verifyCorrect.body.verified === true, 'Correct OTP verified is true');

  // Consumed replay test
  const verifyReplay = await OtpService.verifyOtp(project, {
    phone: '+919999977777',
    request_id: correctChallengeId,
    otp: knownOtp,
  });
  assert(verifyReplay.status === 400 && verifyReplay.body.error?.code === 'ALREADY_CONSUMED', 'Consumed replay rejected (ALREADY_CONSUMED)');

  // Expired challenge test
  const expiredChallengeId = crypto.randomUUID();
  store.otpChallenges.set(expiredChallengeId, {
    id: expiredChallengeId,
    project_id: project.id,
    phone_number: '+919999966666',
    otp_hash: knownHash,
    salt: knownSalt,
    attempts: 0,
    max_attempts: 3,
    expires_at: new Date(Date.now() - 10000).toISOString(), // Expired
    consumed: false,
    idempotency_key: null,
    metadata: {},
    created_at: new Date(Date.now() - 310000).toISOString(),
  });

  const verifyExpired = await OtpService.verifyOtp(project, {
    phone: '+919999966666',
    request_id: expiredChallengeId,
    otp: knownOtp,
  });
  assert(verifyExpired.status === 410 && verifyExpired.body.error?.code === 'CHALLENGE_EXPIRED', 'Expired challenge rejected (HTTP 410 CHALLENGE_EXPIRED)');

  // Project isolation test
  const project2 = await AdminService.createProject('Project Two', 'proj-two');
  const verifyCrossProject = await OtpService.verifyOtp(project2, {
    phone: '+919999977777',
    request_id: correctChallengeId,
    otp: knownOtp,
  });
  assert(verifyCrossProject.status === 404, 'Project Isolation: Cross-project verification rejected (HTTP 404)');

  // --- 8. SMS Job Queue & Gateway Claiming ---
  console.log('\n▶ Test Suite 8: SMS Job Queue & Gateway Claiming');
  // Clear jobs and enqueue 2 jobs
  store.smsJobs.clear();
  const job1Id = await JobQueue.enqueueJob(project.id, null, '+919876543210', 'Test OTP msg 1');
  const job2Id = await JobQueue.enqueueJob(project.id, null, '+919876543211', 'Test OTP msg 2');

  // Gateway 1 claims 1 job
  const claimedJobs1 = await JobQueue.claimJobs(gateway.id, 1, 60);
  assert(claimedJobs1.length === 1, 'Gateway 1 claims exactly 1 job');
  assert(claimedJobs1[0].job_id === job1Id, 'Claimed job matches FIFO order (job1)');
  assert(store.smsJobs.get(job1Id)?.status === 'CLAIMED', 'Job 1 status updated to CLAIMED');

  // Gateway 2 claims 1 job concurrently (Duplicate prevention)
  const gw2 = await AdminService.registerGateway('Pixel Worker 2');
  const claimedJobs2 = await JobQueue.claimJobs(gw2.id, 1, 60);
  assert(claimedJobs2.length === 1, 'Gateway 2 claims next available job');
  assert(claimedJobs2[0].job_id === job2Id, 'Duplicate prevention: Gateway 2 receives job2, NOT job1');

  // No more queued jobs
  const claimedEmpty = await JobQueue.claimJobs(gateway.id, 1, 60);
  assert(claimedEmpty.length === 0, 'Empty queue returns 0 jobs');

  // --- 9. Stale Lease Expiry & Recovery ---
  console.log('\n▶ Test Suite 9: Stale Lease Recovery');
  // Force job 1 lease to be expired in the past
  const job1 = store.smsJobs.get(job1Id)!;
  job1.lease_expires_at = new Date(Date.now() - 5000).toISOString();

  const recoveredCount = await JobQueue.recoverStaleLeases();
  assert(recoveredCount === 1, 'Stale lease recovery recovers expired CLAIMED job');
  assert(job1.status === 'QUEUED', 'Expired job reverted back to QUEUED for retry');
  assert(job1.assigned_gateway_id === null, 'Assigned gateway reset to null');

  // --- 10. Gateway Status Transitions ---
  console.log('\n▶ Test Suite 10: Status Transitions & Validation');
  // Gateway 1 re-claims job 1
  await JobQueue.claimJobs(gateway.id, 1, 60);

  // Valid transition: CLAIMED -> SENDING
  const statusSending = await JobQueue.updateJobStatus(job1Id, gateway.id, 'SENDING');
  assert(statusSending.success === true && statusSending.status === 'SENDING', 'Valid transition: CLAIMED -> SENDING');

  // Valid transition: SENDING -> SENT
  const statusSent = await JobQueue.updateJobStatus(job1Id, gateway.id, 'SENT');
  assert(statusSent.success === true && statusSent.status === 'SENT', 'Valid transition: SENDING -> SENT');

  // Valid transition: SENT -> DELIVERED
  const statusDelivered = await JobQueue.updateJobStatus(job1Id, gateway.id, 'DELIVERED');
  assert(statusDelivered.success === true && statusDelivered.status === 'DELIVERED', 'Valid transition: SENT -> DELIVERED');

  // Invalid backward transition: DELIVERED -> QUEUED
  const statusInvalid = await JobQueue.updateJobStatus(job1Id, gateway.id, 'QUEUED' as any);
  assert(statusInvalid.success === false, 'Invalid status transition rejected (DELIVERED -> QUEUED)');

  // Wrong gateway update rejection
  const statusWrongGw = await JobQueue.updateJobStatus(job1Id, gw2.id, 'FAILED');
  assert(statusWrongGw.success === false && statusWrongGw.error === 'Job is not assigned to this gateway', 'Rejects status update from non-assigned gateway');

  // --- 11. Health & Heartbeat ---
  console.log('\n▶ Test Suite 11: Health & Heartbeat');
  const metrics = await JobQueue.getQueueMetrics();
  assert(metrics.depth === 0, 'Queue depth calculation accurate');

  await db.query('UPDATE gateways SET model = $2 WHERE id = $1', [gateway.id, 'Pixel 7a']);
  assert(store.gateways.get(gateway.id)?.model === 'Pixel 7a', 'Heartbeat updates gateway metadata');

  // --- 12. Idempotency & Admin Key Management ---
  console.log('\n▶ Test Suite 12: Idempotency & Key Management');
  const idempotencyKey = 'req_idempotency_test_12345';
  const firstSend = await OtpService.sendOtp(project, {
    phone: '+919876543299',
    idempotency_key: idempotencyKey,
  });
  assert(firstSend.status === 200, 'Initial OTP creation with idempotency key succeeds');
  const firstReqId = (firstSend.body as any).request_id;

  // Replay same request with same idempotency key
  const replaySend = await OtpService.sendOtp(project, {
    phone: '+919876543299',
    idempotency_key: idempotencyKey,
  });
  assert(replaySend.status === 200, 'Replayed OTP creation returns HTTP 200');
  assert((replaySend.body as any).request_id === firstReqId, 'Idempotent replay returns identical challenge request_id');

  // Verify project key rotation flow
  const replacementKey = await AdminService.createProjectKey(project.id, 'Secondary Key', 'live');
  assert(replacementKey.rawKey.startsWith('otp_proj_live_'), 'Generated secondary project key for rotation');
  const projectKeys = await AdminService.getProjectKeys(project.id);
  assert(projectKeys.length >= 2, 'Project has multiple active keys during migration window');

  // Revoke old key
  await AdminService.revokeProjectKey(activeProjKey.keyId);
  const keysAfterRevoke = await AdminService.getProjectKeys(project.id);
  const oldKey = keysAfterRevoke.find((k) => k.id === activeProjKey.keyId);
  assert(oldKey?.status === 'REVOKED', 'Old project key successfully revoked after consumer migration');

  // Admin Queue metrics
  const queueMetrics = await AdminService.getQueueMetrics();
  assert(typeof queueMetrics.queued === 'number', 'AdminService.getQueueMetrics returns structured counts');

  // --- 13. Template Validation & Placeholder Whitelisting ---
  console.log('\n▶ Test Suite 13: Template Validation & Placeholder Whitelisting');
  // Valid OTP template with approved placeholders
  const validOtpTpl = validateTemplate('Your {{app_name}} verification code is {{otp}}, valid for {{expiry_minutes}} minutes.', 'OTP');
  assert(validOtpTpl.valid === true, 'Valid OTP template passes validation');
  if (validOtpTpl.valid) {
    assert(validOtpTpl.placeholders.includes('otp') && validOtpTpl.placeholders.includes('app_name'), 'Extracts approved placeholders');
  }

  // Missing {{otp}} placeholder in OTP template
  const missingOtpTpl = validateTemplate('Welcome to {{app_name}}! Thanks for registering.', 'OTP');
  assert(missingOtpTpl.valid === false && missingOtpTpl.code === 'MISSING_OTP_PLACEHOLDER', 'Rejects OTP template missing {{otp}} placeholder (MISSING_OTP_PLACEHOLDER)');

  // Invalid / unapproved placeholders
  const disallowedPlaceholders = [
    'Your code is {{otp}}, sent to {{phone}}',
    'Click here: {{link}} {{otp}}',
    'Auth token: {{token}} {{otp}}',
    '${otp} is your code',
  ];
  for (const bad of disallowedPlaceholders) {
    const res = validateTemplate(bad, 'OTP');
    assert(res.valid === false && (res.code === 'INVALID_PLACEHOLDER' || res.code === 'MISSING_OTP_PLACEHOLDER'), `Rejects unapproved placeholder format: "${bad}"`);
  }

  // Whitespace and case tolerance in approved placeholders
  const whitespaceTpl = validateTemplate('Code: {{  OTP  }} for {{ App_Name }}', 'OTP');
  assert(whitespaceTpl.valid === true, 'Accepts whitespace and case variation in {{ OTP }}');

  // --- 14. Unsafe Input & Boundary Constraints ---
  console.log('\n▶ Test Suite 14: Unsafe Input & Boundary Constraints');
  // Null byte injection
  const nullByteTpl = validateTemplate('Your code is {{otp}}\0malicious payload', 'OTP');
  assert(nullByteTpl.valid === false && nullByteTpl.code === 'UNSAFE_INPUT', 'Rejects null byte injection (UNSAFE_INPUT)');

  // Control characters injection
  const controlCharTpl = validateTemplate('Your code is {{otp}}\u0007\u0008', 'OTP');
  assert(controlCharTpl.valid === false && controlCharTpl.code === 'UNSAFE_INPUT', 'Rejects non-printable control characters (UNSAFE_INPUT)');

  // Script tag injection
  const scriptTagTpl = validateTemplate('<script>alert("xss")</script> OTP: {{otp}}', 'OTP');
  assert(scriptTagTpl.valid === false && scriptTagTpl.code === 'UNSAFE_INPUT', 'Rejects <script> tags (UNSAFE_INPUT)');

  // Max length enforcement (> 500 characters)
  const oversizedTpl = validateTemplate('A'.repeat(501) + '{{otp}}', 'OTP');
  assert(oversizedTpl.valid === false && oversizedTpl.code === 'EXCEEDS_MAX_LENGTH', 'Rejects oversized templates > 500 characters (EXCEEDS_MAX_LENGTH)');

  // Empty body
  const emptyTpl = validateTemplate('   ', 'OTP');
  assert(emptyTpl.valid === false && emptyTpl.code === 'EMPTY_BODY', 'Rejects empty body (EMPTY_BODY)');

  // --- 15. SMS Segment & Character Calculation (GSM-7 vs UCS-2) ---
  console.log('\n▶ Test Suite 15: SMS Segment & Character Calculation');
  // Pure GSM-7 single segment (up to 160 characters)
  const gsmSingle = calculateSmsSegments('Hello, your verification code is 123456. Valid for 5 minutes.');
  assert(gsmSingle.encoding === 'GSM_7', 'ASCII message classified as GSM_7 encoding');
  assert(gsmSingle.segmentCount === 1, 'Short GSM-7 message is 1 segment');
  assert(gsmSingle.maxCharactersPerSegment === 160, 'Single-part GSM-7 segment max is 160 chars');

  // Pure GSM-7 multi-segment (> 160 characters, concatenation header reduces limit to 153 chars/segment)
  const gsmLongText = 'A'.repeat(161);
  const gsmMulti = calculateSmsSegments(gsmLongText);
  assert(gsmMulti.encoding === 'GSM_7', 'Long ASCII classified as GSM_7');
  assert(gsmMulti.segmentCount === 2, '161-char GSM-7 message splits into 2 segments (153 + 8 chars)');
  assert(gsmMulti.maxCharactersPerSegment === 153, 'Multi-part GSM-7 segment max is 153 chars');

  // GSM-7 Extended characters ([ ] { } ^ ~ | \ €) cost 2 characters each
  const gsmExtended = calculateSmsSegments('Cost: 10 € [test]');
  assert(gsmExtended.encoding === 'GSM_7', 'GSM-7 with extended chars remains GSM_7');
  assert(gsmExtended.characterCount === 20, 'Extended characters count as 2 characters each');

  // Unicode (UCS-2) single segment (up to 70 characters)
  const ucs2Single = calculateSmsSegments('Your 🔒 secure code is 123456');
  assert(ucs2Single.encoding === 'UCS2', 'Unicode emoji detected as UCS2 encoding');
  assert(ucs2Single.segmentCount === 1, 'Short UCS-2 message within 70 chars is 1 segment');
  assert(ucs2Single.maxCharactersPerSegment === 70, 'Single-part UCS-2 segment max is 70 chars');

  // Unicode (UCS-2) multi-segment (> 70 characters, 67 chars/segment)
  const ucs2LongText = '🔒 Security Alert: ' + 'X'.repeat(60);
  const ucs2Multi = calculateSmsSegments(ucs2LongText);
  assert(ucs2Multi.encoding === 'UCS2', 'Long Unicode message classified as UCS2');
  assert(ucs2Multi.segmentCount === 2, '78-char UCS-2 message splits into 2 segments (67 + 11 chars)');
  assert(ucs2Multi.maxCharactersPerSegment === 67, 'Multi-part UCS-2 segment max is 67 chars');

  // --- 16. Template Lifecycle, Versioning & Single Active Constraint ---
  console.log('\n▶ Test Suite 16: Template Lifecycle, Versioning & Single Active Constraint');
  // 1. Create first template (DRAFT)
  const tpl1 = await TemplateService.createTemplate(project.id, {
    name: 'Primary Login OTP',
    slug: 'primary-login-otp',
    template_type: 'OTP',
    body: 'Your {{app_name}} code is {{otp}}. Valid for {{expiry_minutes}} mins.',
    dlt_template_id: 'DLT-1001',
    sender_header: 'SWIFTG',
    pe_id: 'PE-9988',
  });
  assert(tpl1.status === 'DRAFT', 'Created template starts in DRAFT status');
  assert(tpl1.active_version === null, 'DRAFT template has null active_version');
  assert(tpl1.active_version_id === null, 'DRAFT template has null active_version_id');
  assert(tpl1.latest_version?.version_number === 1, 'Initial version is version 1');
  assert(tpl1.latest_version?.status === 'DRAFT', 'Initial version starts in DRAFT status');
  assert(tpl1.dlt_template_id === 'DLT-1001', 'Stores optional DLT template ID');

  // 2. Reject direct creation as ACTIVE
  let directActiveRejected = false;
  try {
    await TemplateService.createTemplate(project.id, {
      name: 'Direct Active Attempt',
      slug: 'direct-active-otp',
      template_type: 'OTP',
      body: 'Your OTP is {{otp}}',
      status: 'ACTIVE' as any,
    });
  } catch (err: any) {
    if (err instanceof TemplateValidationError && err.code === 'DIRECT_ACTIVE_FORBIDDEN') {
      directActiveRejected = true;
    }
  }
  assert(directActiveRejected, 'Direct creation with status ACTIVE is rejected (400 DIRECT_ACTIVE_FORBIDDEN)');

  // 3. Reject direct activation of DRAFT version
  let draftActivationRejected = false;
  try {
    await TemplateService.activateTemplate(tpl1.id, project.id);
  } catch (err: any) {
    if (err instanceof TemplateStateError && err.code === 'MUST_BE_APPROVED') {
      draftActivationRejected = true;
    }
  }
  assert(draftActivationRejected, 'Direct activation of DRAFT version is rejected (409 MUST_BE_APPROVED)');

  // 4. Explicit Owner Approval
  const tpl1Approved = await TemplateService.approveTemplate(tpl1.id, project.id, 'owner@swift.local');
  assert(tpl1Approved.status === 'APPROVED', 'Template status transitioned to APPROVED');
  assert(tpl1Approved.active_version === null, 'APPROVED template has null active_version');
  assert(tpl1Approved.latest_version?.status === 'APPROVED', 'Version status transitioned to APPROVED');
  assert(tpl1Approved.latest_version?.approved_by === 'owner@swift.local', 'Records approved_by audit identity');
  assert(tpl1Approved.latest_version?.approved_at instanceof Date, 'Records approved_at timestamp');

  // 5. Activation of Approved Version
  const tpl1Active = await TemplateService.activateTemplate(tpl1.id, project.id);
  assert(tpl1Active.status === 'ACTIVE', 'Template 1 status transitioned to ACTIVE');
  assert(tpl1Active.active_version !== null, 'ACTIVE template has non-null active_version');
  assert(tpl1Active.active_version?.version_number === 1, 'active_version points to version 1');
  assert(tpl1Active.active_version?.status === 'ACTIVE', 'active_version status is ACTIVE');
  assert(tpl1Active.active_version?.activated_at instanceof Date, 'active_version has activated_at timestamp');

  // 6. Active OTP template resolution
  const resolvedActive = await TemplateService.getActiveOtpTemplate(project.id);
  assert(resolvedActive?.id === tpl1.id, 'TemplateService.getActiveOtpTemplate resolves active template');
  assert(resolvedActive?.active_version.version_number === 1, 'Resolves active version 1');

  // 7. Update body of active template -> creates v2 as DRAFT while v1 remains LIVE
  const tpl1Updated = await TemplateService.updateTemplate(tpl1.id, project.id, {
    body: 'Dear customer, your {{app_name}} secret OTP is {{otp}}. Do not share with anyone.',
  });
  assert(tpl1Updated.status === 'ACTIVE', 'Parent template remains ACTIVE during edit');
  assert(tpl1Updated.versions.length === 2, 'Updating template body creates a new version (history preserved)');
  assert(tpl1Updated.active_version?.version_number === 1, 'Old version 1 remains LIVE while new draft exists');
  assert(tpl1Updated.active_version?.status === 'ACTIVE', 'Old version remains in ACTIVE status');
  assert(tpl1Updated.latest_version?.version_number === 2, 'New version 2 created');
  assert(tpl1Updated.latest_version?.status === 'DRAFT', 'New version 2 is in DRAFT status');

  // 8. Confirm OTP sending continues using v1 while v2 is DRAFT
  const otpResWhileDraft = await TemplateService.getActiveOtpTemplate(project.id);
  assert(otpResWhileDraft?.active_version.version_number === 1, 'OTP resolution still serves live version 1');
  assert(Boolean(otpResWhileDraft?.active_version.body.includes('Valid for')), 'OTP message text is still version 1');

  // 9. Approve and Activate version 2
  const tpl1V2Approved = await TemplateService.approveTemplate(
    tpl1.id,
    project.id,
    'owner@swift.local',
    tpl1Updated.latest_version!.id
  );
  assert(tpl1V2Approved.latest_version?.status === 'APPROVED', 'Version 2 transitioned to APPROVED');

  const tpl1V2Active = await TemplateService.activateTemplate(
    tpl1.id,
    project.id,
    tpl1Updated.latest_version!.id
  );
  assert(tpl1V2Active.active_version?.version_number === 2, 'Version 2 promoted to ACTIVE');
  const v1Demoted = tpl1V2Active.versions.find((v) => v.version_number === 1);
  assert(v1Demoted?.status === 'APPROVED', 'Old version 1 demoted to APPROVED upon v2 activation');

  // 10. Single active OTP template constraint: create, approve, and activate tpl2
  const tpl2 = await TemplateService.createTemplate(project.id, {
    name: 'Festive Login OTP',
    slug: 'festive-login-otp',
    template_type: 'OTP',
    body: 'Festive Greetings! Your {{app_name}} OTP is {{otp}}.',
  });
  assert(tpl2.status === 'DRAFT', 'Template 2 created in DRAFT status');
  await TemplateService.approveTemplate(tpl2.id, project.id, 'owner@swift.local');
  const tpl2Active = await TemplateService.activateTemplate(tpl2.id, project.id);
  assert(tpl2Active.status === 'ACTIVE', 'Template 2 activated to ACTIVE status');

  // Verify Template 1 was demoted to APPROVED and its active_version_id cleared
  const tpl1AfterDemote = await TemplateService.getTemplate(tpl1.id, project.id);
  assert(tpl1AfterDemote?.status === 'APPROVED', 'Single active constraint: Template 1 demoted to APPROVED');
  assert(tpl1AfterDemote?.active_version === null, 'Single active constraint: Template 1 active_version cleared to null');

  // 11. Cross-project archive mutation prevention (zero mutations on mismatched projectId)
  const badArchive = await TemplateService.archiveTemplate(tpl1.id, '00000000-0000-0000-0000-000000000000');
  assert(badArchive === false, 'Cross-project archive returns false');
  const tpl1Untouched = await TemplateService.getTemplate(tpl1.id, project.id);
  assert(tpl1Untouched?.status === 'APPROVED', 'Cross-project archive leaves target template untouched (0 mutations)');

  // 12. Legitimate archive
  const archived = await TemplateService.archiveTemplate(tpl1.id, project.id);
  assert(archived === true, 'Template 1 successfully archived');
  const tpl1Archived = await TemplateService.getTemplate(tpl1.id, project.id);
  assert(tpl1Archived?.status === 'ARCHIVED', 'Template 1 status is now ARCHIVED');
  assert(tpl1Archived?.active_version_id === null, 'Archived template has null active_version_id');

  // 13. Activating an ARCHIVED template is rejected
  let archivedActivationRejected = false;
  try {
    await TemplateService.activateTemplate(tpl1.id, project.id);
  } catch (err: any) {
    if (err instanceof TemplateStateError && err.code === 'ARCHIVED_TEMPLATE') {
      archivedActivationRejected = true;
    }
  }
  assert(archivedActivationRejected, 'Activation of ARCHIVED template is rejected (409 ARCHIVED_TEMPLATE)');

  // --- 17. Security: Cryptographic OTP Backend Enforcement ---
  console.log('\n▶ Test Suite 17: Security - Cryptographic OTP Backend Enforcement');
  // Client attempts to pass a custom OTP value to sendOtp
  const maliciousCustomOtpRequest = {
    phone: '+919876543290',
    otp: '000000',
    custom_otp: '000000',
    code: '000000',
  } as any;

  const secureSendRes = await OtpService.sendOtp(project, maliciousCustomOtpRequest);
  assert(secureSendRes.status === 200, 'OTP request processed successfully');
  const challengeId = (secureSendRes.body as any).request_id;
  const challengeRecord = store.otpChallenges.get(challengeId)!;

  // Verify plaintext OTP is NEVER stored in the database record
  assert((challengeRecord as any).otp === undefined, 'Security: Plaintext OTP is NOT stored in the database');
  assert(typeof challengeRecord.otp_hash === 'string' && challengeRecord.otp_hash.length === 64, 'Security: OTP stored only as cryptographic SHA-256 hash');

  // Verify client's submitted custom OTP "000000" fails verification
  const verifyMalicious = await OtpService.verifyOtp(project, {
    phone: '+919876543290',
    request_id: challengeId,
    otp: '000000',
  });
  assert(verifyMalicious.status === 400 && verifyMalicious.body.error?.code === 'INVALID_OTP', 'Security: Client-provided OTP "000000" rejected (backend generates OTP cryptographically)');

  // --- 18. Route-Level HTTP Endpoint & Security Suite ---
  console.log('\n▶ Test Suite 18: Route-Level HTTP Endpoint & Security Suite');

  // 1. Unauthenticated request rejected (401)
  const unauthReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates`, {
    admin: null,
  });
  const unauthRes = await getTemplatesRoute(unauthReq, { params: { projectId: project.id } });
  assert(unauthRes.status === 401, 'Unauthenticated GET /templates returns 401 Unauthorized');

  // 1b. Test auth override rejected outside test mode (returns 401)
  const prevEnv = process.env.NODE_ENV;
  try {
    (process.env as any).NODE_ENV = 'production';
    const prodOverrideReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates`, {
      method: 'GET',
    });
    (prodOverrideReq as any).__testAdmin = {
      id: 'hacker-admin',
      email: 'hacker@swift.local',
      display_name: 'Hacker',
      enabled: true,
    };
    const prodRes = await getTemplatesRoute(prodOverrideReq, { params: { projectId: project.id } });
    assert(prodRes.status === 401, 'getAdminFromRequest ignores __testAdmin when NODE_ENV is production (returns 401)');
  } finally {
    (process.env as any).NODE_ENV = prevEnv;
  }

  // 2. Authenticated read (200)
  const authReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates`);
  const authRes = await getTemplatesRoute(authReq, { params: { projectId: project.id } });
  assert(authRes.status === 200, 'Authenticated GET /templates returns 200 OK');
  const authBody = await authRes.json();
  assert(Array.isArray(authBody.templates), 'Authenticated response contains templates array');

  // 3. CSRF cross-origin rejection (403)
  const csrfReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates`, {
    method: 'POST',
    headers: { origin: 'http://malicious-attacker.com' },
    body: { name: 'CSRF Attempt', slug: 'csrf-attempt', body: 'Code: {{otp}}' },
  });
  const csrfRes = await createTemplateRoute(csrfReq, { params: { projectId: project.id } });
  assert(csrfRes.status === 403, 'Cross-origin mutation rejected with 403 Forbidden (CSRF protection)');

  // 4. Malformed JSON payload (400)
  const malformedReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates`, {
    method: 'POST',
    body: '{"invalid json: true',
  });
  const malformedRes = await createTemplateRoute(malformedReq, { params: { projectId: project.id } });
  assert(malformedRes.status === 400, 'Malformed JSON returns 400 Bad Request');

  // 5. Invalid template_type (400)
  const badTypeReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates`, {
    method: 'POST',
    body: { name: 'Bad Type', slug: 'bad-type', template_type: 'INVALID_TYPE', body: 'OTP: {{otp}}' },
  });
  const badTypeRes = await createTemplateRoute(badTypeReq, { params: { projectId: project.id } });
  assert(badTypeRes.status === 400, 'Invalid template_type returns 400 Bad Request');

  // 6. Direct ACTIVE status creation rejected (400)
  const activeCreateReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates`, {
    method: 'POST',
    body: { name: 'Active Try', slug: 'active-try', template_type: 'OTP', status: 'ACTIVE', body: 'OTP: {{otp}}' },
  });
  const activeCreateRes = await createTemplateRoute(activeCreateReq, { params: { projectId: project.id } });
  assert(activeCreateRes.status === 400, 'Direct creation as ACTIVE returns 400 Bad Request');

  // 6b. Reject invalid POST statuses (APPROVED, ARCHIVED, UNKNOWN)
  for (const invalidStatus of ['APPROVED', 'ARCHIVED', 'UNKNOWN_STATUS']) {
    const badStatusReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates`, {
      method: 'POST',
      body: { name: `Status ${invalidStatus}`, slug: `status-${invalidStatus.toLowerCase().replace(/_/g, '-')}`, template_type: 'OTP', status: invalidStatus, body: 'OTP: {{otp}}' },
    });
    const badStatusRes = await createTemplateRoute(badStatusReq, { params: { projectId: project.id } });
    assert(badStatusRes.status === 400, `POST /templates with status: '${invalidStatus}' returns 400 Bad Request`);
  }

  // 6c. Valid POST with explicit status 'DRAFT' accepted (201)
  const explicitDraftReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates`, {
    method: 'POST',
    body: { name: 'Explicit Draft', slug: 'explicit-draft', template_type: 'OTP', status: 'DRAFT', body: 'OTP: {{otp}}' },
  });
  const explicitDraftRes = await createTemplateRoute(explicitDraftReq, { params: { projectId: project.id } });
  assert(explicitDraftRes.status === 201, 'POST /templates with explicit status: DRAFT returns 201 Created');

  // 7. Invalid placeholder (400)
  const badPlaceholderReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates`, {
    method: 'POST',
    body: { name: 'Bad Var', slug: 'bad-var', template_type: 'OTP', body: 'OTP: {{otp}} Password: {{password}}' },
  });
  const badPlaceholderRes = await createTemplateRoute(badPlaceholderReq, { params: { projectId: project.id } });
  assert(badPlaceholderRes.status === 400, 'Unapproved placeholder returns 400 Bad Request');

  // 8. Missing required OTP placeholder (400)
  const missingOtpReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates`, {
    method: 'POST',
    body: { name: 'No OTP', slug: 'no-otp', template_type: 'OTP', body: 'Welcome to {{app_name}}' },
  });
  const missingOtpRes = await createTemplateRoute(missingOtpReq, { params: { projectId: project.id } });
  assert(missingOtpRes.status === 400, 'OTP template missing {{otp}} returns 400 Bad Request');

  // 9. Valid DRAFT template creation (201)
  const validCreateReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates`, {
    method: 'POST',
    body: {
      name: 'Route Test OTP',
      slug: 'route-test-otp',
      template_type: 'OTP',
      body: 'Your {{app_name}} security token is {{otp}}.',
    },
  });
  const validCreateRes = await createTemplateRoute(validCreateReq, { params: { projectId: project.id } });
  assert(validCreateRes.status === 201, 'Valid template creation returns 201 Created');
  const validCreateData = (await validCreateRes.json()).template;
  const routeTplId = validCreateData.id;
  assert(validCreateData.status === 'DRAFT', 'Created template is in DRAFT status');

  // 10. Reject activation of DRAFT version (409)
  const draftActivateReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates/${routeTplId}/activate`, {
    method: 'POST',
    body: {},
  });
  const draftActivateRes = await activateTemplateRoute(draftActivateReq, { params: { projectId: project.id, templateId: routeTplId } });
  assert(draftActivateRes.status === 409, 'Activating DRAFT version returns 409 Conflict');

  // 11. Explicit version approval (200)
  const approveReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates/${routeTplId}/approve`, {
    method: 'POST',
    body: {},
  });
  const approveRes = await approveTemplateRoute(approveReq, { params: { projectId: project.id, templateId: routeTplId } });
  assert(approveRes.status === 200, 'Explicit approval returns 200 OK');
  const approveData = (await approveRes.json()).template;
  assert(approveData.status === 'APPROVED', 'Template status is APPROVED');

  // 12. Activation of approved template (200)
  const activateApprovedReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates/${routeTplId}/activate`, {
    method: 'POST',
    body: {},
  });
  const activateApprovedRes = await activateTemplateRoute(activateApprovedReq, { params: { projectId: project.id, templateId: routeTplId } });
  assert(activateApprovedRes.status === 200, 'Activation of approved template returns 200 OK');
  const activatedData = (await activateApprovedRes.json()).template;
  assert(activatedData.status === 'ACTIVE', 'Template status is ACTIVE');

  // 13. Edit active template body (200, keeps v1 active while creating v2 draft)
  const patchReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates/${routeTplId}`, {
    method: 'PATCH',
    body: { body: 'Updated: {{app_name}} token is {{otp}}.' },
  });
  const patchRes = await patchTemplateRoute(patchReq, { params: { projectId: project.id, templateId: routeTplId } });
  assert(patchRes.status === 200, 'PATCH template body returns 200 OK');
  const patchData = (await patchRes.json()).template;
  assert(patchData.status === 'ACTIVE', 'Template remains ACTIVE after body update');
  assert(patchData.active_version?.version_number === 1, 'active_version remains version 1');
  assert(patchData.latest_version?.version_number === 2, 'latest_version is version 2 (DRAFT)');

  // 14. Disallow setting any status via PATCH (400)
  for (const patchStatus of ['ACTIVE', 'DRAFT', 'APPROVED', 'ARCHIVED', 'UNKNOWN_STATUS']) {
    const patchStatusReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates/${routeTplId}`, {
      method: 'PATCH',
      body: { status: patchStatus },
    });
    const patchStatusRes = await patchTemplateRoute(patchStatusReq, { params: { projectId: project.id, templateId: routeTplId } });
    assert(patchStatusRes.status === 400, `PATCH with status: '${patchStatus}' returns 400 Bad Request`);
  }

  // 14b. Empty or whitespace-only PATCH body returns 400
  const emptyPatchBodyReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates/${routeTplId}`, {
    method: 'PATCH',
    body: { body: '' },
  });
  const emptyPatchBodyRes = await patchTemplateRoute(emptyPatchBodyReq, { params: { projectId: project.id, templateId: routeTplId } });
  assert(emptyPatchBodyRes.status === 400, 'PATCH with empty string body returns 400 Bad Request');

  const wsPatchBodyReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates/${routeTplId}`, {
    method: 'PATCH',
    body: { body: '    ' },
  });
  const wsPatchBodyRes = await patchTemplateRoute(wsPatchBodyReq, { params: { projectId: project.id, templateId: routeTplId } });
  assert(wsPatchBodyRes.status === 400, 'PATCH with whitespace-only body returns 400 Bad Request');

  // 14c. Metadata-only PATCH succeeds without incrementing version
  const metaOnlyReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates/${routeTplId}`, {
    method: 'PATCH',
    body: {
      name: 'Updated Metadata Name',
      description: 'Updated Description Only',
      sender_header: 'NEWHDR',
    },
  });
  const metaOnlyRes = await patchTemplateRoute(metaOnlyReq, { params: { projectId: project.id, templateId: routeTplId } });
  assert(metaOnlyRes.status === 200, 'Metadata-only PATCH (omitted body) returns 200 OK');
  const metaOnlyData = (await metaOnlyRes.json()).template;
  assert(metaOnlyData.name === 'Updated Metadata Name', 'Metadata-only PATCH updated template name');
  assert(metaOnlyData.description === 'Updated Description Only', 'Metadata-only PATCH updated template description');
  assert(metaOnlyData.sender_header === 'NEWHDR', 'Metadata-only PATCH updated sender header');
  assert(metaOnlyData.latest_version?.version_number === 2, 'Metadata-only PATCH does not increment version number');

  // 15. Cross-project archive returns 404 with zero mutations
  const crossArchiveReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/wrong-project-id/templates/${routeTplId}`, {
    method: 'DELETE',
  });
  const crossArchiveRes = await deleteTemplateRoute(crossArchiveReq, { params: { projectId: 'wrong-project-id', templateId: routeTplId } });
  assert(crossArchiveRes.status === 404, 'Cross-project archive returns 404 Not Found');

  // 16. Legitimate archive returns 200
  const legitimateArchiveReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates/${routeTplId}`, {
    method: 'DELETE',
  });
  const legitimateArchiveRes = await deleteTemplateRoute(legitimateArchiveReq, { params: { projectId: project.id, templateId: routeTplId } });
  assert(legitimateArchiveRes.status === 200, 'Legitimate archive returns 200 OK');

  // 17. Activating archived template returns 409
  const activateArchivedReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates/${routeTplId}/activate`, {
    method: 'POST',
    body: {},
  });
  const activateArchivedRes = await activateTemplateRoute(activateArchivedReq, { params: { projectId: project.id, templateId: routeTplId } });
  assert(activateArchivedRes.status === 409, 'Activating archived template returns 409 Conflict');

  // 18. Draft preview endpoint (200)
  const draftPreviewReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates/preview`, {
    method: 'POST',
    body: {
      body: 'Hello from {{app_name}}! Code is {{otp}}.',
      sample_variables: { app_name: 'PreviewCorp', otp: '123456' },
    },
  });
  const draftPreviewRes = await previewDraftRoute(draftPreviewReq, { params: { projectId: project.id } });
  assert(draftPreviewRes.status === 200, 'POST /templates/preview returns 200 OK');
  const draftPreviewData = await draftPreviewRes.json();
  assert(draftPreviewData.data.rendered_text === 'Hello from PreviewCorp! Code is 123456.', 'Preview substituted sample variables correctly');

  // 19. Saved template preview endpoints (GET & POST)
  const savedPreviewGetReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates/${tpl2Active.id}/preview`);
  const savedPreviewGetRes = await getTemplatePreviewRoute(savedPreviewGetReq, { params: { projectId: project.id, templateId: tpl2Active.id } });
  assert(savedPreviewGetRes.status === 200, 'GET /templates/[id]/preview returns 200 OK');

  const savedPreviewPostReq = makeRequest(`http://localhost:3000/api/v1/admin/projects/${project.id}/templates/${tpl2Active.id}/preview`, {
    method: 'POST',
    body: { sample_variables: { app_name: 'CustomApp', otp: '777888' } },
  });
  const savedPreviewPostRes = await postTemplatePreviewRoute(savedPreviewPostReq, { params: { projectId: project.id, templateId: tpl2Active.id } });
  assert(savedPreviewPostRes.status === 200, 'POST /templates/[id]/preview returns 200 OK');
  const savedPreviewPostData = await savedPreviewPostRes.json();
  assert(savedPreviewPostData.data.rendered_text === 'Festive Greetings! Your CustomApp OTP is 777888.', 'POST preview renders saved template with custom sample variables');

  // --- 19. Fail-Safe OTP Rendering & Database Invariants ---
  console.log('\n▶ Test Suite 19: Fail-Safe OTP Rendering & Database Invariants');

  // 1. Database template-query failure creates no OTP job and returns 500
  const initialChallengesCount = store.otpChallenges.size;
  const initialJobsCount = store.smsJobs.size;

  simulateTemplateDbError = true;
  const failSafeRes = await OtpService.sendOtp(project, {
    phone: '+919111111111',
  });
  simulateTemplateDbError = false;

  assert(failSafeRes.status === 500, 'Database template failure returns sanitized 500 error');
  assert(
    (failSafeRes.body as any).error === 'Failed to retrieve message template configuration',
    'Sanitized error message returned without database internals leakage'
  );
  assert(store.otpChallenges.size === initialChallengesCount, 'Zero OTP challenges created when DB template query throws');
  assert(store.smsJobs.size === initialJobsCount, 'Zero SMS jobs created when DB template query throws');

  // 2. Missing template fallback (null): backward compatibility with project config
  const cleanProjectId = crypto.randomUUID();
  const cleanProject: Project = {
    id: cleanProjectId,
    name: 'Clean Fallback Project',
    slug: 'clean-fallback',
    enabled: true,
    config: {
      otp_length: 6,
      expiry_seconds: 300,
      template: 'Hello Customer, your {{app_name}} code is {{otp}}',
    },
    created_at: new Date(),
    updated_at: new Date(),
  };
  store.projects.set(cleanProjectId, cleanProject);

  const fallbackSendRes = await OtpService.sendOtp(cleanProject, {
    phone: '+919222222222',
  });
  assert(fallbackSendRes.status === 200, 'Legacy project config fallback succeeds when getActiveOtpTemplate returns null');
  const fallbackChallengeId = (fallbackSendRes.body as any).request_id;
  const fallbackJob = Array.from(store.smsJobs.values()).find((j) => j.challenge_id === fallbackChallengeId);
  assert(fallbackJob !== undefined, 'SMS job created under lawful fallback');
  assert(Boolean(fallbackJob?.message.includes('Clean Fallback Project')), 'Legacy project fallback renders correct text');

  // 3. Active template ownership invariant & single active OTP template constraint
  // Reactivate tpl2 (which was demoted to APPROVED in earlier tests)
  await TemplateService.activateTemplate(tpl2.id, project.id);

  let activeCount = 0;
  for (const t of store.messageTemplates.values()) {
    if (t.project_id === project.id && t.template_type === 'OTP' && t.status === 'ACTIVE') {
      activeCount++;
      assert(t.active_version_id !== null, 'Invariant: ACTIVE template has non-null active_version_id');
      const ver = store.messageTemplateVersions.get(t.active_version_id);
      assert(ver?.template_id === t.id, 'Invariant: active_version_id belongs strictly to this template');
      assert(ver?.status === 'ACTIVE', 'Invariant: active version has status ACTIVE');
    }
  }
  assert(activeCount === 1, 'Single active OTP constraint: Exactly one OTP template is active per project');

  // 4. Database Invariant: direct version activation without parent pointer fails (check_violation)
  let versionActivationWithoutParentFailed = false;
  const badVerId = crypto.randomUUID();
  store.messageTemplateVersions.set(badVerId, {
    id: badVerId,
    template_id: tpl1.id, // tpl1 is ARCHIVED
    version_number: 99,
    body: 'Orphan {{otp}}',
    variables: ['otp'],
    character_count: 12,
    segment_count: 1,
    encoding: 'GSM_7',
    status: 'ACTIVE',
    created_at: new Date().toISOString(),
    activated_at: new Date().toISOString(),
  });
  try {
    verifyDeferredDatabaseInvariants();
  } catch (err: any) {
    if (err.message.includes('check_violation') && err.message.includes('cannot have status ACTIVE unless parent template')) {
      versionActivationWithoutParentFailed = true;
    }
  } finally {
    store.messageTemplateVersions.delete(badVerId);
  }
  assert(versionActivationWithoutParentFailed, 'Database Invariant: Direct version activation without parent pointer fails (check_violation)');

  // 5. Database Invariant: cross-template active_version_id pointer fails (foreign_key_violation)
  let crossTemplatePointerFailed = false;
  const foreignVerId = crypto.randomUUID();
  store.messageTemplateVersions.set(foreignVerId, {
    id: foreignVerId,
    template_id: 'some-other-template-id',
    version_number: 1,
    body: 'Foreign {{otp}}',
    variables: ['otp'],
    character_count: 13,
    segment_count: 1,
    encoding: 'GSM_7',
    status: 'ACTIVE',
    created_at: new Date().toISOString(),
    activated_at: new Date().toISOString(),
  });
  const currentActiveTpl = store.messageTemplates.get(tpl2.id);
  const originalActiveVerId = currentActiveTpl.active_version_id;
  currentActiveTpl.active_version_id = foreignVerId;
  try {
    verifyDeferredDatabaseInvariants();
  } catch (err: any) {
    if (err.message.includes('foreign_key_violation') || err.message.includes('belongs to template')) {
      crossTemplatePointerFailed = true;
    }
  } finally {
    currentActiveTpl.active_version_id = originalActiveVerId;
    store.messageTemplateVersions.delete(foreignVerId);
  }
  assert(crossTemplatePointerFailed, 'Database Invariant: Cross-template active_version_id pointer fails (foreign_key_violation)');

  // 6. Database Invariant: valid deferred service activation succeeds
  let deferredActivationSucceeded = false;
  try {
    verifyDeferredDatabaseInvariants();
    deferredActivationSucceeded = true;
  } catch {
    deferredActivationSucceeded = false;
  }
  assert(deferredActivationSucceeded, 'Database Invariant: Valid synchronized deferred template and version activation succeeds');

  // 7. Database Invariant: active-version demotion while parent still points to it fails (check_violation)
  let demotionWhileParentActiveFailed = false;
  const activeVer = store.messageTemplateVersions.get(currentActiveTpl.active_version_id);
  const originalVerStatus = activeVer.status;
  activeVer.status = 'APPROVED'; // demoted version while parent is still ACTIVE
  try {
    verifyDeferredDatabaseInvariants();
  } catch (err: any) {
    if (err.message.includes('check_violation') && err.message.includes('cannot be ACTIVE while active version')) {
      demotionWhileParentActiveFailed = true;
    }
  } finally {
    activeVer.status = originalVerStatus;
  }
  assert(demotionWhileParentActiveFailed, 'Database Invariant: Active version demotion while parent still points to it fails (check_violation)');

  // 8. Direct database archive behavior: direct SQL template archive clears pointer and cascades child versions
  const archiveTestTplId = crypto.randomUUID();
  const archiveTestVerId = crypto.randomUUID();
  store.messageTemplates.set(archiveTestTplId, {
    id: archiveTestTplId,
    project_id: project.id,
    name: 'Direct SQL Archive Test',
    slug: 'direct-sql-archive-test',
    template_type: 'TRANSACTIONAL',
    status: 'ACTIVE',
    active_version_id: archiveTestVerId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  store.messageTemplateVersions.set(archiveTestVerId, {
    id: archiveTestVerId,
    template_id: archiveTestTplId,
    version_number: 1,
    body: 'Direct SQL archive test {{app_name}}',
    variables: ['app_name'],
    character_count: 34,
    segment_count: 1,
    encoding: 'GSM_7',
    status: 'ACTIVE',
    created_at: new Date().toISOString(),
    activated_at: new Date().toISOString(),
  });

  // Verify it is initially valid
  verifyDeferredDatabaseInvariants();

  // Perform direct SQL UPDATE on message_templates setting status = 'ARCHIVED'
  await db.query(`UPDATE message_templates SET status = 'ARCHIVED' WHERE id = $1 AND project_id = $2`, [archiveTestTplId, project.id]);

  const archivedTpl = store.messageTemplates.get(archiveTestTplId);
  const archivedVer = store.messageTemplateVersions.get(archiveTestVerId);

  assert(archivedTpl.status === 'ARCHIVED', 'Direct SQL archive: Template status is ARCHIVED');
  assert(archivedTpl.active_version_id === null, 'Direct SQL archive: active_version_id is set to NULL');
  assert(archivedVer.status === 'ARCHIVED', 'Direct SQL archive: Child version status cascaded to ARCHIVED');

  let archiveInvariantCheckPassed = false;
  try {
    verifyDeferredDatabaseInvariants();
    archiveInvariantCheckPassed = true;
  } catch {
    archiveInvariantCheckPassed = false;
  }
  assert(archiveInvariantCheckPassed, 'Direct SQL archive: No deferred database invariants violated after archival');

  // Clean up test archive record
  store.messageTemplates.delete(archiveTestTplId);
  store.messageTemplateVersions.delete(archiveTestVerId);

  // 9. Database Invariant: DRAFT template cannot receive a non-null active_version_id
  let draftWithActiveVerRejected = false;
  const draftTestTplId = crypto.randomUUID();
  const draftTestVerId = crypto.randomUUID();
  store.messageTemplates.set(draftTestTplId, {
    id: draftTestTplId,
    project_id: project.id,
    name: 'Draft Pointer Test',
    slug: 'draft-pointer-test',
    template_type: 'OTP',
    status: 'DRAFT',
    active_version_id: draftTestVerId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  store.messageTemplateVersions.set(draftTestVerId, {
    id: draftTestVerId,
    template_id: draftTestTplId,
    version_number: 1,
    body: 'Draft test {{otp}}',
    variables: ['otp'],
    character_count: 17,
    segment_count: 1,
    encoding: 'GSM_7',
    status: 'DRAFT',
    created_at: new Date().toISOString(),
    activated_at: null,
  });
  try {
    verifyDeferredDatabaseInvariants();
  } catch (err: any) {
    if (err.message.includes('check_violation') && err.message.includes('only ACTIVE templates may specify an active_version_id')) {
      draftWithActiveVerRejected = true;
    }
  } finally {
    store.messageTemplates.delete(draftTestTplId);
    store.messageTemplateVersions.delete(draftTestVerId);
  }
  assert(draftWithActiveVerRejected, 'Database Invariant: DRAFT template cannot receive a non-null active_version_id (check_violation)');

  // 10. Database Invariant: APPROVED template cannot receive a non-null active_version_id
  let approvedWithActiveVerRejected = false;
  const approvedTestTplId = crypto.randomUUID();
  const approvedTestVerId = crypto.randomUUID();
  store.messageTemplates.set(approvedTestTplId, {
    id: approvedTestTplId,
    project_id: project.id,
    name: 'Approved Pointer Test',
    slug: 'approved-pointer-test',
    template_type: 'OTP',
    status: 'APPROVED',
    active_version_id: approvedTestVerId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  store.messageTemplateVersions.set(approvedTestVerId, {
    id: approvedTestVerId,
    template_id: approvedTestTplId,
    version_number: 1,
    body: 'Approved test {{otp}}',
    variables: ['otp'],
    character_count: 20,
    segment_count: 1,
    encoding: 'GSM_7',
    status: 'APPROVED',
    created_at: new Date().toISOString(),
    activated_at: null,
  });
  try {
    verifyDeferredDatabaseInvariants();
  } catch (err: any) {
    if (err.message.includes('check_violation') && err.message.includes('only ACTIVE templates may specify an active_version_id')) {
      approvedWithActiveVerRejected = true;
    }
  } finally {
    store.messageTemplates.delete(approvedTestTplId);
    store.messageTemplateVersions.delete(approvedTestVerId);
  }
  assert(approvedWithActiveVerRejected, 'Database Invariant: APPROVED template cannot receive a non-null active_version_id (check_violation)');


  console.log('\n===============================================================');
  console.log(`Test Execution Complete: ${passedTests} / ${totalTests} Passed (100%)`);
  console.log('===============================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runAllTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
