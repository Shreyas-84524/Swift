import { App, initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';

/**
 * Server-only Firebase Admin SDK singleton manager.
 * Ensures zero leakage to client bundles, handles multiline private keys safely,
 * and allows clean mocking during test execution.
 */

export interface FirebaseConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

let mockMessagingInstance: Messaging | null = null;
let firebaseInitializedApp: App | null = null;

/**
 * Validates whether all required server environment variables for Firebase are present.
 */
export function isFirebaseConfigured(): boolean {
  return !!(
    process.env.FIREBASE_PROJECT_ID?.trim() &&
    process.env.FIREBASE_CLIENT_EMAIL?.trim() &&
    process.env.FIREBASE_PRIVATE_KEY?.trim()
  );
}

/**
 * Parses and validates Firebase server configuration from environment variables.
 */
export function getFirebaseConfig(): FirebaseConfig | null {
  if (!isFirebaseConfigured()) {
    return null;
  }

  let rawKey = process.env.FIREBASE_PRIVATE_KEY!.trim();
  // Strip surrounding quotes if present from secret managers or .env parsers
  if (
    (rawKey.startsWith('"') && rawKey.endsWith('"')) ||
    (rawKey.startsWith("'") && rawKey.endsWith("'"))
  ) {
    rawKey = rawKey.slice(1, -1);
  }
  // Correctly handle escaped newlines in environment variable
  const privateKey = rawKey.replace(/\\n/g, '\n');

  return {
    projectId: process.env.FIREBASE_PROJECT_ID!.trim(),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL!.trim(),
    privateKey,
  };
}

/**
 * Returns the singleton Firebase Admin App instance.
 * Strictly throws if called in browser or client context.
 */
export function getFirebaseAdminApp(): App | null {
  if (typeof window !== 'undefined') {
    throw new Error('Firebase Admin SDK must NEVER be executed in a browser client component');
  }

  // Return existing singleton if already initialized
  if (firebaseInitializedApp) {
    return firebaseInitializedApp;
  }

  // Check if Firebase Admin already has an app initialized in Node.js runtime
  const existingApps = getApps();
  if (existingApps.length > 0 && existingApps[0]) {
    firebaseInitializedApp = existingApps[0];
    return firebaseInitializedApp;
  }

  const config = getFirebaseConfig();
  if (!config) {
    return null;
  }

  try {
    firebaseInitializedApp = initializeApp({
      credential: cert({
        projectId: config.projectId,
        clientEmail: config.clientEmail,
        privateKey: config.privateKey,
      }),
    });
    return firebaseInitializedApp;
  } catch {
    // Firebase errors can embed credential metadata. Keep server logs sanitized.
    console.error('[FirebaseAdmin] Failed to initialize Firebase Admin singleton');
    return null;
  }
}

/**
 * Returns the messaging client (or mock client if set for testing).
 */
export function getFirebaseMessaging(): Messaging | null {
  if (mockMessagingInstance) {
    return mockMessagingInstance;
  }

  const app = getFirebaseAdminApp();
  if (!app) {
    return null;
  }

  return getMessaging(app);
}

/**
 * Test helper to inject a mock messaging client.
 */
export function setMockFirebaseMessaging(mock: Messaging | null): void {
  mockMessagingInstance = mock;
}

/**
 * Test helper to reset Firebase Admin state.
 */
export function resetFirebaseAdminState(): void {
  mockMessagingInstance = null;
  firebaseInitializedApp = null;
}
