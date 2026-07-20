'use client';

import { useState, type FormEvent } from 'react';
import { inviteUser } from '@/app/invite/actions';

export default function InviteForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus('sending');
    setErrorMessage('');

    const { error } = await inviteUser(email);

    if (error) {
      setStatus('error');
      setErrorMessage(error);
      return;
    }

    setStatus('sent');
  }

  if (status === 'sent') {
    return (
      <div className="mt-6 flex flex-col gap-3">
        <p className="text-sm text-device-text-secondary">
          Invited <span className="font-medium text-device-text">{email}</span> — they&apos;ll get an email with a
          sign-in link.
        </p>
        <button
          type="button"
          onClick={() => {
            setEmail('');
            setStatus('idle');
          }}
          className="w-fit rounded-lg bg-device-surface px-3 py-2 text-sm text-device-text-secondary transition hover:bg-device-surface-hover"
        >
          Invite another
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
      <label className="text-sm text-device-text-secondary" htmlFor="invite-email">
        Email
      </label>
      <input
        id="invite-email"
        type="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className="rounded-lg bg-device-surface px-3 py-2 text-sm text-device-text outline-none focus:ring-2 focus:ring-device-accent"
        placeholder="newperson@example.com"
      />
      <button
        type="submit"
        disabled={status === 'sending'}
        className="mt-2 rounded-lg bg-device-accent px-3 py-2 text-sm font-medium text-device-screen transition hover:brightness-110 disabled:opacity-60"
      >
        {status === 'sending' ? 'Sending invite…' : 'Send invite'}
      </button>
      {status === 'error' && <p className="text-sm text-device-alert">{errorMessage}</p>}
    </form>
  );
}
