import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Integrate with Swift | Developer guide' };

const send = `curl -X POST "$SWIFT_BASE_URL/api/v1/otp/send" \\
  -H "Content-Type: application/json" \\
  -H "X-Project-Key: $SWIFT_PROJECT_KEY" \\
  -H "Idempotency-Key: unique-per-verification-attempt" \\
  -d '{"phone":"+919876543210"}'`;
const verify = `curl -X POST "$SWIFT_BASE_URL/api/v1/otp/verify" \\
  -H "Content-Type: application/json" \\
  -H "X-Project-Key: $SWIFT_PROJECT_KEY" \\
  -d '{"phone":"+919876543210","request_id":"ID_FROM_SEND","otp":"123456"}'`;

export default function IntegrationGuide() {
  return <main className="public-docs">
    <nav className="docs-nav" aria-label="Documentation navigation"><a className="brand" href="/admin" style={{textDecoration:'none'}}><img className="brand-mark" src="/swift-logo.png" alt="" width={48} height={48}/><span>Swift<span className="brand-caption">DEVELOPER GUIDE</span></span></a><a className="button" href="/admin">Open workspace ↗</a></nav>
    <header className="docs-hero"><p className="eyebrow">FROM YOUR APP TO THEIR PHONE</p><h1>A better connection.<br/>Just two API calls.</h1><p>Add SMS verification to a website, mobile app, or any project with a backend. Swift generates the code, queues the message, and verifies the response.</p><a href="/swift-integration.md" download>Download the complete guide ↓</a></header>
    <section className="guide-step"><p className="eyebrow">01 / PREPARE</p><h2>Connect your project and a gateway</h2><ol><li>The Swift owner creates a project in the workspace and generates a project API key.</li><li>The owner registers an Android gateway and configures its gateway key, backend URL, SIM permissions, and global worker mode.</li><li>Keep the gateway online with an active SIM. A successful send response means queued, not delivered.</li></ol><p>Your integration path is: website or mobile app → your backend → Swift → Android gateway → recipient.</p></section>
    <section className="guide-step"><p className="eyebrow">02 / AUTHENTICATE</p><h2>Keep credentials on your server</h2><pre>{`SWIFT_BASE_URL=https://global-otp-service.vercel.app
SWIFT_PROJECT_KEY=your_project_key`}</pre><p>Send the project key in the <code>X-Project-Key</code> header. Never embed it in browser JavaScript, Android, iOS, Flutter, or a public repository. Mobile and web clients call your own backend. The owner login and gateway keys are separate from project API credentials.</p></section>
    <section className="guide-step"><p className="eyebrow">03 / SEND</p><h2>Request a verification code</h2><pre>{send}</pre><p>Use an E.164 phone number. Save <code>request_id</code>, <code>expires_in</code>, and <code>resend_after</code> from the JSON response. Bind the request ID and phone to your pending user session on your backend. Use a fresh idempotency key for each new attempt; reuse it only when retrying that exact request.</p></section>
    <section className="guide-step"><p className="eyebrow">04 / VERIFY</p><h2>Confirm the code on your backend</h2><pre>{verify}</pre><p>Only an HTTP 200 response with <code>verified: true</code> should complete verification. Swift consumes successful codes so they cannot be reused. Your backend then creates its own authenticated session or marks the intended phone as verified.</p></section>
    <section className="guide-step"><p className="eyebrow">05 / HANDLE THE DETAILS</p><h2>Make the experience feel effortless</h2><ul><li>Show a resend countdown using <code>resend_after</code>. On HTTP 429, honor <code>retry_after_seconds</code> when returned.</li><li>For a wrong code, show the remaining attempts. For expired codes, start a new attempt.</li><li>Handle network timeouts with bounded retries and the same idempotency key for the same send attempt.</li><li>Never log OTPs, passwords, or raw API keys. Enforce your own app-level rate limits and session checks.</li></ul><p>The downloadable guide includes Node.js, Python, and Flutter examples, response shapes, error handling, and an end-to-end checklist.</p></section>
  </main>;
}
