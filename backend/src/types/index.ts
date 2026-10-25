export type JobStatus =
  | 'QUEUED'
  | 'CLAIMED'
  | 'SENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'FAILED'
  | 'EXPIRED';

export type KeyStatus = 'ACTIVE' | 'REVOKED';

export type KeyEnvironment = 'live' | 'test';

export interface ProjectConfig {
  cooldown_seconds?: number;
  hourly_limit?: number;
  expiry_seconds?: number;
  max_attempts?: number;
  otp_length?: number;
  template?: string;
  sms_template?: string;
}
export interface Project {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  config: ProjectConfig;
  created_at: Date;
  updated_at: Date;
}

export interface ProjectApiKey {
  id: string;
  project_id: string;
  key_prefix: string;
  key_hash: string;
  name: string;
  environment: KeyEnvironment;
  status: KeyStatus;
  created_at: Date;
  revoked_at: Date | null;
}

export interface OtpChallenge {
  id: string;
  project_id: string;
  phone_number: string;
  otp_hash: string;
  salt: string;
  attempts: number;
  max_attempts: number;
  expires_at: Date;
  consumed: boolean;
  idempotency_key?: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface SmsJob {
  id: string;
  project_id: string;
  challenge_id: string | null;
  assigned_gateway_id: string | null;
  phone_number: string;
  message: string;
  status: JobStatus;
  attempts: number;
  lease_expires_at: Date | null;
  failure_reason: string | null;
  created_at: Date;
  picked_up_at: Date | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  failed_at: Date | null;
}

export interface Gateway {
  id: string;
  name: string;
  device_id: string | null;
  model: string | null;
  android_sdk: number | null;
  app_version: string | null;
  sim_status: string;
  battery_pct: number | null;
  worker_enabled: boolean;
  is_active: boolean;
  last_seen_at: Date | null;
  created_at: Date;
}

export interface GatewayApiKey {
  id: string;
  gateway_id: string;
  key_prefix: string;
  key_hash: string;
  name: string;
  status: KeyStatus;
  created_at: Date;
  revoked_at: Date | null;
}

// API Request/Response DTOs

export interface SendOtpRequest {
  phone: string;
  template?: string;
  code_length?: number;
  expiry_seconds?: number;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
}

export interface SendOtpResponse {
  success: boolean;
  request_id: string;
  expires_in: number;
  resend_after: number;
}

export interface VerifyOtpRequest {
  phone: string;
  request_id: string;
  otp: string;
}

export interface VerifyOtpResponse {
  success: boolean;
  verified: boolean;
  error?: {
    code: string;
    message: string;
    attempts_remaining?: number;
  };
}

export interface GatewayJobDto {
  job_id: string;
  phone_number: string;
  message: string;
  created_at: string;
  lease_expires_at: string;
}

export interface GatewayJobsResponse {
  success: boolean;
  data: {
    jobs: GatewayJobDto[];
  };
}

export interface UpdateJobStatusRequest {
  status: 'SENDING' | 'SENT' | 'DELIVERED' | 'FAILED';
  error_code?: string;
  error_message?: string;
  dispatched_at?: string;
}

export interface GatewayHeartbeatRequest {
  device_id?: string;
  model?: string;
  android_sdk?: number;
  app_version?: string;
  sim_status?: string;
  battery_pct?: number;
  worker_enabled?: boolean;
  last_sms_status?: string;
}

export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  timestamp: string;
  services: {
    database: 'connected' | 'disconnected';
    queue_lag_seconds: number | null;
    queue_depth: number;
    active_gateways: number;
  };
}

// ============================================================================
// Phase 1: Message Templates & Push Notification Types
// ============================================================================

export type TemplateStatus = 'DRAFT' | 'APPROVED' | 'ACTIVE' | 'ARCHIVED';
export type TemplateType = 'OTP' | 'TRANSACTIONAL' | 'MARKETING' | 'NOTIFICATION';
export type SmsEncoding = 'GSM_7' | 'UCS2';

export interface MessageTemplate {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  template_type: TemplateType;
  description: string | null;
  status: TemplateStatus;
  active_version_id: string | null;
  dlt_template_id?: string | null;
  sender_header?: string | null;
  pe_id?: string | null;
  created_at: Date;
  updated_at: Date;
  active_version?: MessageTemplateVersion | null;
}

export interface MessageTemplateWithVersions extends MessageTemplate {
  versions: MessageTemplateVersion[];
  active_version: MessageTemplateVersion | null;
  latest_version?: MessageTemplateVersion | null;
}

export interface MessageTemplateVersion {
  id: string;
  template_id: string;
  version_number: number;
  body: string;
  variables: string[];
  character_count: number;
  segment_count: number;
  encoding: SmsEncoding;
  status: TemplateStatus;
  dlt_template_id?: string | null;
  sender_header?: string | null;
  pe_id?: string | null;
  created_by?: string | null;
  approved_by?: string | null;
  approved_at?: Date | null;
  created_at: Date;
  activated_at?: Date | null;
}

export interface GatewayPushToken {
  id: string;
  gateway_id: string;
  token: string;
  provider: 'FCM' | 'HMS' | 'APNS';
  platform: 'ANDROID' | 'IOS' | 'WEB';
  device_fingerprint?: string | null;
  is_valid: boolean;
  last_registered_at: Date;
  last_used_at?: Date | null;
  created_at: Date;
}

export interface NotificationOutboxItem {
  id: string;
  gateway_id?: string | null;
  job_id?: string | null;
  channel: 'FCM' | 'WEBHOOK' | 'SYSTEM';
  priority: 'HIGH' | 'NORMAL';
  payload: Record<string, unknown>;
  status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'DEAD_LETTER';
  attempts: number;
  max_attempts: number;
  last_attempt_at?: Date | null;
  next_attempt_at: Date;
  response_code?: string | null;
  error_message?: string | null;
  deduplication_key?: string | null;
  created_at: Date;
  sent_at?: Date | null;
}

export interface RegisterPushTokenRequest {
  token: string;
  provider: 'FCM';
  platform: 'ANDROID';
  device_fingerprint?: string;
  app_version?: string;
}

export interface RegisterPushTokenResponse {
  success: boolean;
  data: {
    registered: boolean;
    provider: 'FCM';
    platform: 'ANDROID';
    last_registered_at: string;
  };
}

export interface PushWakePayload {
  type: 'JOBS_AVAILABLE';
}

export interface CreateTemplateRequest {
  name: string;
  slug: string;
  template_type?: TemplateType;
  description?: string;
  body: string;
  dlt_template_id?: string;
  sender_header?: string;
  pe_id?: string;
  status?: TemplateStatus; // default DRAFT
}

export interface UpdateTemplateRequest {
  name?: string;
  description?: string;
  body?: string; // if provided, creates new version
  dlt_template_id?: string;
  sender_header?: string;
  pe_id?: string;
  status?: TemplateStatus;
}

export interface ApproveTemplateRequest {
  version_id?: string;
}

export interface ActivateTemplateRequest {
  version_id?: string;
}

export interface PreviewTemplateRequest {
  body: string;
  sample_variables?: {
    otp?: string;
    app_name?: string;
    expiry_minutes?: number | string;
  };
}

export interface PreviewTemplateResponse {
  success: boolean;
  data: {
    rendered_text: string;
    variables: Record<string, string>;
    encoding: SmsEncoding;
    character_count: number;
    raw_length: number;
    segment_count: number;
    max_characters_per_segment: number;
    remaining_in_current_segment: number;
  };
}
