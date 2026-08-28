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
  return new SMTPClient({
    connection: {
      hostname: Deno.env.get('SMTP_HOST')!,
      port: Number(Deno.env.get('SMTP_PORT') ?? '587'),
      tls: true,
      auth: { username: Deno.env.get('SMTP_USER')!, password: Deno.env.get('SMTP_PASS')! },
    },
  });
}

export async function sendEmail(client: SMTPClient, to: string, subject: string, content: string): Promise<void> {
  await client.send({ from: Deno.env.get('SMTP_FROM')!, to, subject, content });
}
