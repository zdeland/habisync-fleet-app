import { Suspense } from 'react';
import LoginForm from './LoginForm';

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
      <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-xl shadow-black/20">
        <p className="text-sm uppercase tracking-[0.3em] text-cyan-400">HabiSync Fleet Monitor</p>
        <h1 className="mt-2 text-2xl font-semibold">Sign in</h1>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
