import crypto from 'crypto';
import {
  Project,
  ProjectApiKey,
  OtpChallenge,
  SmsJob,
  Gateway,
  GatewayApiKey,
  MessageTemplate,
  MessageTemplateVersion,
  GatewayPushToken,
  NotificationOutboxItem,
} from '@/types';

export class MockDatabase {
  public projects: Project[] = [];
  public projectApiKeys: ProjectApiKey[] = [];
  public otpChallenges: OtpChallenge[] = [];
  public smsJobs: SmsJob[] = [];
  public gateways: Gateway[] = [];
  public gatewayApiKeys: GatewayApiKey[] = [];
  public messageTemplates: MessageTemplate[] = [];
  public messageTemplateVersions: MessageTemplateVersion[] = [];
  public gatewayPushTokens: GatewayPushToken[] = [];
  public notificationOutbox: NotificationOutboxItem[] = [];

  public clear(): void {
    this.projects = [];
    this.projectApiKeys = [];
    this.otpChallenges = [];
    this.smsJobs = [];
    this.gateways = [];
    this.gatewayApiKeys = [];
    this.messageTemplates = [];
    this.messageTemplateVersions = [];
    this.gatewayPushTokens = [];
    this.notificationOutbox = [];
  }

  public insertProject(project: Partial<Project>): Project {
    const fullProject: Project = {
      id: project.id || crypto.randomUUID(),
      name: project.name || 'Test Project',
      slug: project.slug || 'test-project',
      enabled: project.enabled !== undefined ? project.enabled : true,
      config: project.config || {},
      created_at: project.created_at || new Date(),
      updated_at: project.updated_at || new Date(),
    };
    this.projects.push(fullProject);
    return fullProject;
  }

  public insertProjectKey(key: Partial<ProjectApiKey>): ProjectApiKey {
    const fullKey: ProjectApiKey = {
      id: key.id || crypto.randomUUID(),
      project_id: key.project_id!,
      key_prefix: key.key_prefix || 'otp_proj_test_',
      key_hash: key.key_hash!,
      name: key.name || 'Key',
      environment: key.environment || 'test',
      status: key.status || 'ACTIVE',
      created_at: key.created_at || new Date(),
      revoked_at: key.revoked_at || null,
    };
    this.projectApiKeys.push(fullKey);
    return fullKey;
  }

  public insertGateway(gateway: Partial<Gateway>): Gateway {
    const fullGw: Gateway = {
      id: gateway.id || crypto.randomUUID(),
      name: gateway.name || 'Test Gateway',
      device_id: gateway.device_id || null,
      model: gateway.model || 'Pixel 7a',
      android_sdk: gateway.android_sdk || 34,
      app_version: gateway.app_version || '1.0.0',
      sim_status: gateway.sim_status || 'READY',
      battery_pct: gateway.battery_pct || 90,
      worker_enabled: gateway.worker_enabled !== undefined ? gateway.worker_enabled : true,
      is_active: gateway.is_active !== undefined ? gateway.is_active : true,
      last_seen_at: gateway.last_seen_at || new Date(),
      created_at: gateway.created_at || new Date(),
    };
    this.gateways.push(fullGw);
    return fullGw;
  }

  public insertGatewayKey(key: Partial<GatewayApiKey>): GatewayApiKey {
    const fullKey: GatewayApiKey = {
      id: key.id || crypto.randomUUID(),
      gateway_id: key.gateway_id!,
      key_prefix: key.key_prefix || 'otp_gw_test_',
      key_hash: key.key_hash!,
      name: key.name || 'GW Key',
      status: key.status || 'ACTIVE',
      created_at: key.created_at || new Date(),
      revoked_at: key.revoked_at || null,
    };
    this.gatewayApiKeys.push(fullKey);
    return fullKey;
  }

  public insertTemplate(template: Partial<MessageTemplate>): MessageTemplate {
    const fullT: MessageTemplate = {
      id: template.id || crypto.randomUUID(),
      project_id: template.project_id!,
      name: template.name || 'Default OTP Template',
      slug: template.slug || 'otp-template',
      template_type: template.template_type || 'OTP',
      description: template.description || null,
      status: template.status || 'DRAFT',
      active_version_id: template.active_version_id || null,
      dlt_template_id: template.dlt_template_id || null,
      sender_header: template.sender_header || null,
      pe_id: template.pe_id || null,
      created_at: template.created_at || new Date(),
      updated_at: template.updated_at || new Date(),
    };
    this.messageTemplates.push(fullT);
    return fullT;
  }

  public insertTemplateVersion(version: Partial<MessageTemplateVersion>): MessageTemplateVersion {
    const fullV: MessageTemplateVersion = {
      id: version.id || crypto.randomUUID(),
      template_id: version.template_id!,
      version_number: version.version_number || 1,
      body: version.body || 'Your code is {{otp}}',
      variables: version.variables || ['otp'],
      character_count: version.character_count || 20,
      segment_count: version.segment_count || 1,
      encoding: version.encoding || 'GSM_7',
      status: version.status || 'DRAFT',
      dlt_template_id: version.dlt_template_id || null,
      sender_header: version.sender_header || null,
      pe_id: version.pe_id || null,
      created_by: version.created_by || 'test',
      approved_by: version.approved_by || null,
      approved_at: version.approved_at || null,
      created_at: version.created_at || new Date(),
      activated_at: version.activated_at || null,
    };
    this.messageTemplateVersions.push(fullV);
    return fullV;
  }
}

export const mockDb = new MockDatabase();
