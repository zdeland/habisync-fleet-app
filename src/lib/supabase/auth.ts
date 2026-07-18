import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

// Defense-in-depth alongside the middleware redirect: page-level components
// that read `logs`/`telemetry` should call this rather than trust middleware
// alone, since a middleware-only check is a single point of failure.
export async function requireUser() {
  const supabase = createClient();
  if (!supabase) return null;

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  return user;
}
