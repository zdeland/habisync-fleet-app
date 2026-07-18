'use client';

import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/client';

export default function LoginForm() {
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get('redirectTo') || '/';

  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = createClient();
    if (!supabase) return;

    setStatus('sending');
    setErrorMessage('');

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?redirectTo=${encodeURIComponent(redirectTo)}`,
      },
    });

    if (error) {
      setStatus('error');
      setErrorMessage(error.message);
      return;
    }

    setStatus('sent');
  }

  if (!isSupabaseConfigured) {
    return (
      <p className="mt-4 text-sm text-device-text-secondary">
        Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> to enable sign-in.
      </p>
    );
  }

  if (status === 'sent') {
    return (
      <p className="mt-4 text-sm text-device-text-secondary">
        Check <span className="font-medium text-device-text">{email}</span> for a sign-in link.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
      <label className="text-sm text-device-text-secondary" htmlFor="email">
        Email
      </label>
      <input
        id="email"
        type="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className="rounded-lg bg-device-surface px-3 py-2 text-sm text-device-text outline-none focus:ring-2 focus:ring-device-accent"
        placeholder="you@example.com"
      />
      <button
        type="submit"
        disabled={status === 'sending'}
        className="mt-2 rounded-lg bg-device-accent px-3 py-2 text-sm font-medium text-device-screen transition hover:brightness-110 disabled:opacity-60"
      >
        {status === 'sending' ? 'Sending link…' : 'Send magic link'}
      </button>
      {status === 'error' && <p className="text-sm text-device-alert">{errorMessage}</p>}
    </form>
  );
}
