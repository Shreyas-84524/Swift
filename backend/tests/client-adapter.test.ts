import assert from 'assert';
import { SwiftClient, SwiftClientError, VerificationSessionStore } from '../src/lib/client/swift-client';

async function runClientAdapterTests() {
  console.log('===============================================================');
  console.log('       Swift Client Reference Adapter Contract Tests           ');
  console.log('===============================================================');

  const originalFetch = global.fetch;

  try {
    // 1. Initialization tests
    console.log('\n▶ Client Adapter Suite 1: Construction & Config Validation');
    assert.throws(
      () => new SwiftClient({ projectKey: '', baseUrl: 'https://test-api.swift.local' }),
      /SwiftClient requires a non-empty projectKey/,
      'Rejects empty projectKey'
    );
    console.log('  ✅ [PASS] Rejects empty projectKey');
    assert.throws(
      () => new SwiftClient({ projectKey: 'otp_live_test_key', baseUrl: 'http://example.com' }),
      /must use HTTPS/,
      'Rejects insecure non-local base URL'
    );
    console.log('  ✅ [PASS] Rejects insecure production base URL');

    const client = new SwiftClient({
      projectKey: 'otp_live_test_1234567890abcdef',
      baseUrl: 'https://test-api.swift.local/',
      timeoutMs: 5000,
      maxRetries: 2,
    });
    assert(client !== null, 'Client instantiated successfully');
    console.log('  ✅ [PASS] Clean client instantiation with normalized URL');

    // 2. Successful Send OTP
    console.log('\n▶ Client Adapter Suite 2: Send OTP Contract');
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body || '{}'));

      assert(url === 'https://test-api.swift.local/api/v1/otp/send', 'URL matches send endpoint');
      assert(headers['X-Project-Key'] === 'otp_live_test_1234567890abcdef', 'Project key attached');
      assert(headers['Idempotency-Key'] === 'idemp_test_1', 'Idempotency key attached');
      assert(body.phone === '+919876543210', 'Phone forwarded');

      return new Response(
        JSON.stringify({
          success: true,
          request_id: 'challenge-uuid-1234',
          expires_in: 300,
          resend_after: 30,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const sendRes = await client.sendOtp({
      phone: '+919876543210',
      idempotencyKey: 'idemp_test_1',
    });
    assert(sendRes.success === true, 'Send OTP returns success: true');
    assert(sendRes.requestId === 'challenge-uuid-1234', 'Returns correct requestId');
    assert(sendRes.expiresInSeconds === 300, 'Returns expiresInSeconds');
    assert(sendRes.resendAfterSeconds === 30, 'Returns resendAfterSeconds');
    console.log('  ✅ [PASS] Successful sendOtp returns normalized SendOtpResult');

    // 3. Retry Behavior on 503 Transient Failure
    console.log('\n▶ Client Adapter Suite 3: Transient Retry & Backoff');
    let callCount = 0;
    global.fetch = async (): Promise<Response> => {
      callCount++;
      if (callCount < 3) {
        return new Response(JSON.stringify({ error: 'Gateway timeout' }), { status: 503 });
      }
      return new Response(
        JSON.stringify({
          success: true,
          request_id: 'retry-recovered-id',
          expires_in: 300,
          resend_after: 30,
        }),
        { status: 200 }
      );
    };

    const retryRes = await client.sendOtp({ phone: '+919876543210' });
    assert(callCount === 3, 'Retried exactly twice on transient 503 errors');
    assert(retryRes.requestId === 'retry-recovered-id', 'Recovered on third attempt');
    console.log('  ✅ [PASS] Bounded retry on 503 transient failure succeeded');

    // 4. Non-Transient 400 Bad Request (Zero Retries)
    console.log('\n▶ Client Adapter Suite 4: Fail Fast on 4xx Client Errors');
    let badRequestCalls = 0;
    global.fetch = async (): Promise<Response> => {
      badRequestCalls++;
      return new Response(
        JSON.stringify({ error: { code: 'INVALID_PHONE', message: 'Invalid phone number format' } }),
        { status: 400 }
      );
    };

    try {
      await client.sendOtp({ phone: 'invalid' });
      assert.fail('Should have thrown SwiftClientError');
    } catch (e: any) {
      assert(e instanceof SwiftClientError, 'Throws SwiftClientError');
      assert(e.statusCode === 400, 'Error status is 400');
      assert(e.code === 'INVALID_PHONE', 'Error code extracted');
      assert(badRequestCalls === 1, 'Strictly zero retries on 400 client error');
    }
    console.log('  ✅ [PASS] Client error 400 fails fast without retrying');

    // 5. Successful Verification Contract
    console.log('\n▶ Client Adapter Suite 5: Verify OTP Contract');
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body || '{}'));
      assert(body.phone === '+919876543210', 'Phone forwarded');
      assert(body.request_id === 'challenge-uuid-1234', 'request_id forwarded');
      assert(body.otp === '123456', 'otp forwarded');

      return new Response(
        JSON.stringify({
          success: true,
          verified: true,
          data: {
            verified: true,
            challenge_id: 'challenge-uuid-1234',
            verified_at: '2026-10-25T18:00:00.000Z',
          },
        }),
        { status: 200 }
      );
    };

    const verifyRes = await client.verifyOtp({
      phone: '+919876543210',
      requestId: 'challenge-uuid-1234',
      otp: '123456',
    });
    assert(verifyRes.success === true, 'Verify success is true');
    assert(verifyRes.verified === true, 'Verified is true');
    assert(verifyRes.challengeId === 'challenge-uuid-1234', 'challengeId returned');
    console.log('  ✅ [PASS] Successful verifyOtp returns normalized VerifyOtpResult');

    // 6. Verification Rejection on Wrong OTP with attempts_remaining
    console.log('\n▶ Client Adapter Suite 6: Verify OTP Wrong Code & Attempts Remaining');
    global.fetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          success: false,
          verified: false,
          error: {
            code: 'INVALID_OTP',
            message: 'The OTP code entered is incorrect.',
            attempts_remaining: 2,
          },
        }),
        { status: 400 }
      );
    };

    try {
      await client.verifyOtp({
        phone: '+919876543210',
        requestId: 'challenge-uuid-1234',
        otp: '000000',
      });
      assert.fail('Should have thrown error on wrong code');
    } catch (e: any) {
      assert(e instanceof SwiftClientError, 'Throws SwiftClientError');
      assert(e.statusCode === 400, 'Status is 400');
      assert(e.code === 'INVALID_OTP', 'Code is INVALID_OTP');
      assert(e.attemptsRemaining === 2, 'Extracts attemptsRemaining');
    }
    console.log('  ✅ [PASS] Wrong code returns attemptsRemaining');

    // 7. Server-Side Session Binding Model
    console.log('\n▶ Client Adapter Suite 7: Server-Side Session Binding (Tamper Prevention)');
    const sessionStore = new VerificationSessionStore();
    const sessionId = 'session_civicfix_user_1';
    const boundPhone = '+919876543210';
    const boundSwiftId = 'challenge-uuid-1234';

    // Server creates session upon successful sendOtp
    const session = sessionStore.createSession(sessionId, boundPhone, boundSwiftId, 'idemp_key_1', 300, 30);
    assert(session.sessionId === sessionId, 'Session created with ID');
    assert(session.phone === boundPhone, 'Phone bound server-side');
    assert(session.consumed === false, 'Session initially unconsumed');

    // Untrusted client submits candidate OTP and session ID (client CANNOT replace phone or challenge ID)
    const clientSuppliedSessionId = sessionId;
    const clientSuppliedOtp = '123456';

    const retrievedSession = sessionStore.getSession(clientSuppliedSessionId);
    assert(!!retrievedSession, 'Server looks up session from store');

    // Server invokes verifyOtp using ONLY server-bound phone and requestId
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body || '{}'));
      assert(body.phone === retrievedSession!.phone, 'Server used bound phone');
      assert(body.request_id === retrievedSession!.swiftRequestId, 'Server used bound requestId');
      assert(body.otp === clientSuppliedOtp, 'Client OTP evaluated');
      return new Response(JSON.stringify({ success: true, verified: true }), { status: 200 });
    };

    const sessionVerifyResult = await client.verifyOtp({
      phone: retrievedSession!.phone,
      requestId: retrievedSession!.swiftRequestId,
      otp: clientSuppliedOtp,
    });
    assert(sessionVerifyResult.verified === true, 'Verification verified: true');

    // Consume session
    const consumed = sessionStore.consumeSession(sessionId);
    assert(consumed === true, 'Session successfully consumed');

    // Replay attempt on consumed session rejected
    const replayCheck = sessionStore.getSession(sessionId);
    assert(replayCheck === undefined, 'Consumed session is no longer returned as active');
    console.log('  ✅ [PASS] Server-side session binding strictly prevents client phone/challenge tampering');

    console.log('\n===============================================================');
    console.log('       All Swift Client Adapter Tests Passed Successfully!     ');
    console.log('===============================================================\n');
  } finally {
    global.fetch = originalFetch;
  }
}

runClientAdapterTests().catch((err) => {
  console.error('Client adapter test failed:', err);
  process.exit(1);
});
