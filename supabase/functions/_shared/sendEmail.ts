// Shared SMTP send helper for this repo's Edge Functions — Deno-only
// (imports a Deno module, reads Deno.env), unlike climateDetection.ts in
// this same _shared/ directory, which is kept dual-runtime importable.
// Used by both supabase/functions/climate-alerts (the real sweep) and
// supabase/functions/send-test-alert (the UI's "send me a test alert"
// button) so the SMTP connection setup isn't duplicated between them.
//
// See docs/climate-alerts.md for why this talks to SMTP directly rather
// than reusing Supabase Auth's SMTP config through some API — there isn't
// one.
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

export function createSmtpClient(): SMTPClient {
  const port = Number(Deno.env.get('SMTP_PORT') ?? '587');
  return new SMTPClient({
    connection: {
      hostname: Deno.env.get('SMTP_HOST')!,
      port,
      // denomailer's `tls: true` means *implicit* TLS from the first byte
      // (the port-465 convention) — `tls: false` connects plaintext and
      // then negotiates STARTTLS, which is what port 587 (Postmark's
      // recommended port, and this app's default) actually expects.
      // Setting tls: true unconditionally made every send silently fail
      // the handshake on 587. 465 is the one port that genuinely wants
      // implicit TLS; treat anything else as STARTTLS.
      tls: port === 465,
      auth: { username: Deno.env.get('SMTP_USER')!, password: Deno.env.get('SMTP_PASS')! },
    },
  });
}

export async function sendEmail(client: SMTPClient, to: string, subject: string, content: string): Promise<void> {
  await client.send({ from: Deno.env.get('SMTP_FROM')!, to, subject, content });
}
