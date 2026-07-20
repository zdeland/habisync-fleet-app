import Link from 'next/link';
import { requireUser } from '@/lib/supabase/auth';
import { isSupabaseConfigured } from '@/lib/supabase/server';
import { isSupabaseAdminConfigured } from '@/lib/supabase/admin';
import InviteForm from '@/components/InviteForm';

export default async function InvitePage() {
  await requireUser();

  return (
    <main className="min-h-screen bg-device-screen p-6 text-device-text">
      <div className="mx-auto flex max-w-md flex-col gap-6">
        <Link href="/" className="text-sm text-device-accent hover:underline">
          ← Fleet overview
        </Link>
        <div className="rounded-2xl bg-device-card p-8 shadow-device">
          <h1 className="text-2xl font-semibold">Invite someone</h1>
          <p className="mt-2 text-sm text-device-text-secondary">
            Sign-up is invite-only — entering an email here is the only way a new person gets access. They&apos;ll
            get an email with a link to sign in.
          </p>

          {!isSupabaseConfigured ? (
            <p className="mt-4 text-sm text-device-text-secondary">
              Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> to
              enable this.
            </p>
          ) : !isSupabaseAdminConfigured ? (
            <p className="mt-4 rounded-lg border border-device-heating/30 bg-device-heating/10 px-3 py-2 text-sm text-device-heating">
              Set <code>SUPABASE_SERVICE_ROLE_KEY</code> (server-only — never <code>NEXT_PUBLIC_</code>) to enable
              invites.
            </p>
          ) : (
            <InviteForm />
          )}
        </div>
      </div>
    </main>
  );
}
