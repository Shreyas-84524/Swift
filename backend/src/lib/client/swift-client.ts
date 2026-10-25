/**
 * Swift OTP Platform — Production Client Reference Adapter
 *
 * Designed for trusted application backends (such as CivicFix, municipal platforms,
 * or consumer services).
 *
 * Security Invariants:
 * 1. Must run ONLY on a trusted server-side environment (Node.js, Next.js API, Express, etc.).
 * 2. NEVER embed in client-side bundles (React, Vue, iOS, Android, Flutter).
 * 3. Enforces server-side session binding: clients only submit candidate OTP codes against
 *    a server-issued verification session token; clients can NEVER manipulate the phone number
 *    or Swift request_id during verification.
 */

import { randomUUID } from 'crypto';

export interface SwiftClientConfig {
  baseUrl: string;
  projectKey: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface SendOtpOptions {
  phone: string;
  idempotencyKey?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface SendOtpResult {
  success: boolean;
  requestId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export interface VerifyOtpOptions {
  phone: string;
  requestId: string;
  otp: string;
  timeoutMs?: number;
}

export interface VerifyOtpResult {
  success: boolean;
  verified: boolean;
  challengeId?: string;
  verifiedAt?: string;
}

export class SwiftClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string = 'SWIFT_ERROR',
    public readonly retryAfterSeconds?: number,
    public readonly attemptsRemaining?: number
  ) {
    super(message);
    this.name = 'SwiftClientError';
  }
}

/**
 * Production TypeScript adapter for Swift SMS Gateway API.
 */
export class SwiftClient {
  private readonly baseUrl: string;
  private readonly projectKey: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: SwiftClientConfig) {
    if (!config.projectKey || typeof config.projectKey !== 'string' || !config.projectKey.trim()) {
      throw new Error('SwiftClient requires a non-empty projectKey');
    }
    if (!config.baseUrl || typeof config.baseUrl !== 'string') {
      throw new Error('SwiftClient requires an explicit baseUrl');
    }
    const parsedBaseUrl = new URL(config.baseUrl);
    const isLocalDevelopment = parsedBaseUrl.hostname === 'localhost' || parsedBaseUrl.hostname === '127.0.0.1';
    if (parsedBaseUrl.protocol !== 'https:' && !(isLocalDevelopment && parsedBaseUrl.protocol === 'http:')) {
      throw new Error('SwiftClient baseUrl must use HTTPS (HTTP is allowed only for localhost)');
    }
    this.projectKey = config.projectKey.trim();
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.defaultTimeoutMs = Math.max(1000, Math.min(30000, config.timeoutMs ?? 10000));
    this.maxRetries = Math.max(0, Math.min(3, config.maxRetries ?? 2));
  }

  /**
   * Dispatches an OTP verification code via Swift.
   */
  public async sendOtp(options: SendOtpOptions): Promise<SendOtpResult> {
    if (!options.phone || typeof options.phone !== 'string') {
      throw new SwiftClientError('Phone number must be a non-empty string', 400, 'INVALID_PHONE');
    }

    const payload: Record<string, unknown> = {
      phone: options.phone.trim(),
    };
    if (options.metadata) payload.metadata = options.metadata;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Project-Key': this.projectKey,
    };
    // Every send receives an idempotency key so bounded network retries cannot
    // create multiple challenges or SMS jobs.
    headers['Idempotency-Key'] = options.idempotencyKey?.trim() || randomUUID();

    const data = await this.executeWithRetry<any>(
      '/api/v1/otp/send',
      'POST',
      headers,
      payload,
      this.normalizeTimeout(options.timeoutMs)
    );

    const requestId = data.request_id || data.challenge_id || data.data?.challenge_id;
    if (!requestId) {
      throw new SwiftClientError('Invalid response from Swift: missing request_id', 502, 'BAD_GATEWAY');
    }

    return {
      success: true,
      requestId,
      expiresInSeconds: data.expires_in || data.data?.expires_in || 300,
      resendAfterSeconds: data.resend_after || data.data?.retry_after_seconds || 30,
    };
  }

  /**
   * Verifies candidate OTP against Swift.
   */
  public async verifyOtp(options: VerifyOtpOptions): Promise<VerifyOtpResult> {
    if (!options.phone || !options.requestId || !options.otp) {
      throw new SwiftClientError('phone, requestId, and otp are required', 400, 'INVALID_INPUT');
    }

    const payload = {
      phone: options.phone.trim(),
      request_id: options.requestId.trim(),
      otp: options.otp.trim(),
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Project-Key': this.projectKey,
    };

    // Verification calls must NEVER be automatically retried to prevent draining attempt quotas
    const data = await this.executeWithoutRetry<any>(
      '/api/v1/otp/verify',
      'POST',
      headers,
      payload,
      this.normalizeTimeout(options.timeoutMs)
    );

    return {
      success: true,
      verified: data.verified === true || data.data?.verified === true,
      challengeId: data.data?.challenge_id || options.requestId,
      verifiedAt: data.data?.verified_at,
    };
  }

  /**
   * Executes HTTP request without retry (for non-idempotent verification operations).
   */
  private async executeWithoutRetry<T>(
    endpoint: string,
    method: string,
    headers: Record<string, string>,
    body: unknown,
    timeoutMs: number
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      let json: any;
      try {
        json = await response.json();
      } catch {
        json = { error: 'Non-JSON response received' };
      }

      if (!response.ok) {
        const errorObj = json?.error;
        const message = typeof errorObj === 'string' ? errorObj : errorObj?.message || `HTTP ${response.status} Error`;
        const code = typeof errorObj === 'object' && errorObj?.code ? errorObj.code : 'HTTP_ERROR';
        const retryAfter = json?.retry_after_seconds || (typeof errorObj === 'object' ? errorObj?.retry_after_seconds : undefined);
        const attemptsRemaining = typeof errorObj === 'object' ? errorObj?.attempts_remaining : undefined;

        throw new SwiftClientError(message, response.status, code, retryAfter, attemptsRemaining);
      }

      return json as T;
    } catch (err: unknown) {
      if (err instanceof SwiftClientError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SwiftClientError(`Request timeout after ${timeoutMs}ms`, 504, 'GATEWAY_TIMEOUT');
      }
      throw new SwiftClientError(
        err instanceof Error ? err.message : 'Network failure contacting Swift API',
        502,
        'NETWORK_FAILURE'
      );
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  private normalizeTimeout(timeoutMs?: number): number {
    return Math.max(1000, Math.min(30000, timeoutMs ?? this.defaultTimeoutMs));
  }

  /**
   * Executes HTTP request with bounded exponential backoff retries strictly for transient 5xx/network errors.
   */
  private async executeWithRetry<T>(
    endpoint: string,
    method: string,
    headers: Record<string, string>,
    body: unknown,
    timeoutMs: number
  ): Promise<T> {
    let attempt = 0;
    let delayMs = 250;

    while (true) {
      attempt++;
      try {
        return await this.executeWithoutRetry<T>(endpoint, method, headers, body, timeoutMs);
      } catch (err: unknown) {
        const isTransient =
          err instanceof SwiftClientError &&
          (err.statusCode === 502 || err.statusCode === 503 || err.statusCode === 504 || err.code === 'NETWORK_FAILURE');

        if (attempt <= this.maxRetries && isTransient) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs *= 2;
          continue;
        }
        throw err;
      }
    }
  }
}

/**
 * Server-Side Pending Verification Session Model.
 * Implements server-side session binding preventing client-side phone/challenge tampering.
 */
export interface VerificationSession {
  sessionId: string;
  phone: string;
  swiftRequestId: string;
  idempotencyKey: string;
  resendAvailableAt: Date;
  expiresAt: Date;
  consumed: boolean;
}

/**
 * In-memory demonstration store for tests and single-process examples only.
 * Production/serverless applications must persist this model in their own
 * database or durable session store.
 */
export class VerificationSessionStore {
  private sessions = new Map<string, VerificationSession>();

  public createSession(
    sessionId: string,
    phone: string,
    swiftRequestId: string,
    idempotencyKey: string,
    expiresInSeconds: number,
    resendAfterSeconds: number
  ): VerificationSession {
    if (this.sessions.has(sessionId)) {
      throw new Error('Verification session ID already exists');
    }
    const session: VerificationSession = {
      sessionId,
      phone,
      swiftRequestId,
      idempotencyKey,
      resendAvailableAt: new Date(Date.now() + resendAfterSeconds * 1000),
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      consumed: false,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  public getSession(sessionId: string): VerificationSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.consumed || session.expiresAt.getTime() <= Date.now()) {
      return undefined;
    }
    return session;
  }

  public consumeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.consumed || session.expiresAt.getTime() <= Date.now()) return false;
    session.consumed = true;
    return true;
  }
}
