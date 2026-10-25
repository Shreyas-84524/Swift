import { Message } from 'firebase-admin/messaging';
import { getFirebaseMessaging, isFirebaseConfigured } from './firebase-admin';

export interface FcmSendResult {
  success: boolean;
  messageId?: string;
  responseCode: string;
  errorMessage?: string;
  isInvalidToken?: boolean;
  isTransient?: boolean;
}

/**
 * Sanitizes Firebase error objects into safe, structured status codes and messages.
 * NEVER leaks raw stack traces, API keys, private keys, or internal Firebase URLs.
 */
export function sanitizeFirebaseError(error: unknown): {
  code: string;
  message: string;
  isInvalidToken: boolean;
  isTransient: boolean;
} {
  if (!error) {
    return {
      code: 'UNKNOWN_ERROR',
      message: 'Unknown Firebase error',
      isInvalidToken: false,
      isTransient: false,
    };
  }

  const errObj = error as Record<string, any>;
  const rawCode: string = String(errObj.code || (errObj.errorInfo && errObj.errorInfo.code) || errObj.status || '');
  const rawMsg: string = String(errObj.message || '');

  // Invalid or unregistered device tokens
  if (
    rawCode === 'messaging/invalid-registration-token' ||
    rawCode === 'messaging/registration-token-not-registered' ||
    rawCode === 'messaging/mismatched-credential' ||
    rawCode === '404' ||
    rawMsg.includes('NOT_FOUND') ||
    rawMsg.includes('UNREGISTERED') ||
    rawMsg.includes('Requested entity was not found')
  ) {
    return {
      code: 'UNREGISTERED_TOKEN',
      message: 'Device registration token is invalid or no longer registered',
      isInvalidToken: true,
      isTransient: false,
    };
  }

  // INVALID_ARGUMENT can describe the message envelope or Firebase project,
  // not only the registration token. Never revoke a token on this ambiguous code.
  if (rawCode === 'messaging/invalid-argument') {
    return {
      code: 'INVALID_ARGUMENT',
      message: 'Firebase rejected the push message request',
      isInvalidToken: false,
      isTransient: false,
    };
  }

  // Transient / Network / Quota errors eligible for retry
  if (
    rawCode === 'messaging/server-unavailable' ||
    rawCode === 'messaging/internal-error' ||
    rawCode === 'messaging/quota-exceeded' ||
    rawCode === 'messaging/device-message-rate-exceeded' ||
    rawCode === 'messaging/topics-message-rate-exceeded' ||
    rawCode === '429' ||
    errObj.name === 'FetchError' ||
    errObj.code === 'ECONNRESET' ||
    errObj.code === 'ETIMEDOUT' ||
    errObj.code === 'ENOTFOUND'
  ) {
    return {
      code: 'TRANSIENT_FAILURE',
      message: 'Temporary communication failure contacting Firebase Cloud Messaging',
      isInvalidToken: false,
      isTransient: true,
    };
  }

  // Authentication / Project configuration errors
  if (
    rawCode === 'messaging/authentication-error' ||
    rawCode === 'app/invalid-credential' ||
    rawCode.includes('auth')
  ) {
    return {
      code: 'AUTHENTICATION_ERROR',
      message: 'Firebase Admin authentication failed; verify project credentials',
      isInvalidToken: false,
      isTransient: false,
    };
  }

  // General sanitized fallback
  return {
    code: 'FCM_SEND_FAILURE',
    message: 'Failed to deliver push wake signal via FCM',
    isInvalidToken: false,
    isTransient: false,
  };
}

export class FcmSender {
  // Short TTL (60 seconds) so old wake-ups do not trigger delayed wakes
  public static readonly WAKE_TTL_SECONDS = 60;
  public static readonly COLLAPSE_KEY = 'swift_jobs_available';

  /**
   * Constructs the authoritative minimal Android high-priority data message envelope.
   * STRICT GUARANTEE: Contains ZERO user metadata, zero OTP codes, zero phone numbers,
   * zero message text, and zero credentials.
   */
  public static buildWakeMessage(targetToken: string): Message {
    const dataPayload = {
      type: 'JOBS_AVAILABLE',
    };

    return {
      token: targetToken,
      data: dataPayload,
      android: {
        priority: 'high',
        ttl: this.WAKE_TTL_SECONDS * 1000,
        collapseKey: this.COLLAPSE_KEY,
      },
    };
  }

  /**
   * Sends the high-priority wake signal to the Android Gateway via FCM.
   */
  public static async sendWakeSignal(targetToken: string): Promise<FcmSendResult> {
    if (!isFirebaseConfigured()) {
      return {
        success: false,
        responseCode: 'FIREBASE_NOT_CONFIGURED',
        errorMessage: 'Firebase Admin credentials are not configured on the server',
        isTransient: false,
        isInvalidToken: false,
      };
    }

    const messaging = getFirebaseMessaging();
    if (!messaging) {
      return {
        success: false,
        responseCode: 'FIREBASE_INITIALIZATION_FAILED',
        errorMessage: 'Unable to obtain Firebase Messaging client instance',
        isTransient: false,
        isInvalidToken: false,
      };
    }

    const message = this.buildWakeMessage(targetToken);

    try {
      const messageId = await messaging.send(message);
      return {
        success: true,
        messageId,
        responseCode: 'SENT',
      };
    } catch (error: unknown) {
      const sanitized = sanitizeFirebaseError(error);
      return {
        success: false,
        responseCode: sanitized.code,
        errorMessage: sanitized.message,
        isInvalidToken: sanitized.isInvalidToken,
        isTransient: sanitized.isTransient,
      };
    }
  }
}
