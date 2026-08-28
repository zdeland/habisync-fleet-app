// Shared email helper for this repo's Edge Functions. Sends via Postmark's
// HTTP API (plain HTTPS fetch), NOT raw SMTP.
//
// Why not SMTP: Supabase Edge Functions (Deno) can't reliably open outbound
// SMTP connections — confirmed against this project's own function logs,
// port 587's STARTTLS trips a denomailer bug ("invalid cmd") and port 465's
// implicit TLS connection just times out (os error 110, blocked). HTTPS to
// Postmark's REST API works cleanly and uses the SAME Postmark server token
// already configured as the SMTP username/password, so it still reuses the
// existing provider and credentials as intended — see docs/climate-alerts.md.
//
// Deno-only (reads Deno.env), unlike _shared/climateDetection.ts in this
// same directory, which is kept dual Deno/Node importable for its unit test.

const POSTMARK_API = 'https://api.postmarkapp.com/email';

// Sends one plaintext email. Throws on any non-2xx Postmark response (e.g.
// an unconfirmed sender signature) so the caller can log/surface it rather
// than silently swallowing a non-delivery.
export async function sendEmail(to: string, subject: string, textBody: string): Promise<void> {
  const token = Deno.env.get('POSTMARK_SERVER_TOKEN');
  const from = Deno.env.get('SMTP_FROM');
  if (!token) throw new Error('POSTMARK_SERVER_TOKEN is not set');
  if (!from) throw new Error('SMTP_FROM is not set');

  const response = await fetch(POSTMARK_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Postmark-Server-Token': token,
    },
    body: JSON.stringify({
      From: from,
      To: to,
      Subject: subject,
      TextBody: textBody,
      MessageStream: 'outbound',
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Postmark send failed (${response.status})${body ? `: ${body}` : ''}`);
  }
}
