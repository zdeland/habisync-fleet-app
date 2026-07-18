import { Suspense } from 'react';
import LoginForm from './LoginForm';

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-device-screen p-6 text-device-text">
      <div className="w-full max-w-sm rounded-2xl bg-device-card p-8 shadow-device">
        <p className="text-sm uppercase tracking-[0.3em] text-device-accent">HabiSync Fleet Monitor</p>
        <h1 className="mt-2 text-2xl font-semibold">Sign in</h1>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
