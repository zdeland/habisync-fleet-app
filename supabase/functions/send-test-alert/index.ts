// "Send test alert" button (src/components/TestAlertButton.tsx) — sends one
// real email over the same Postmark path climate-alerts uses, to the calling
// user's own address, so the email setup can be verified without waiting on
// real telemetry or the 3-minute sustained-out-of-range window. See
// docs/climate-alerts.md.
//
// Unlike climate-alerts (verify_jwt = false, its own X-Cron-Secret check —
// see that function's comment for why), this one keeps Supabase's normal
// JWT verification on (supabase/config.toml has no override, so it
// defaults to true): only a real signed-in user of this app can trigger a
// send, and only to their own address, so there's no way to use this to
// email an arbitrary address.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { sendEmail } from '../_shared/sendEmail.ts';

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return new Response('unauthorized', { status: 401 });

  // A service-role client can't tell us WHO is calling — only a client
  // scoped to the caller's own JWT can, via auth.getUser().
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user?.email) return new Response('unauthorized', { status: 401 });

  try {
    await sendEmail(
      user.email,
      'HabiSync Fleet Monitor: test alert',
      [
        'This is a test email from HabiSync Fleet Monitor, confirming the',
        'climate-alerts email setup is working end to end.',
        '',
        'If you can read this, real out-of-range alert emails for your',
        'favorited devices will reach this same address.',
      ].join('\n'),
    );
  } catch (sendError) {
    // Surface Postmark's own message (e.g. an unconfirmed sender signature)
    // to the caller so the failure is diagnosable from the UI, not just here.
    console.error('failed to send test alert email:', sendError);
    return new Response(sendError instanceof Error ? sendError.message : 'failed to send email', { status: 502 });
  }

  return new Response('ok', { status: 200 });
});
