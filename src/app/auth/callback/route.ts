import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const redirectTo = searchParams.get('redirectTo') || '/';

  if (code) {
    const supabase = createClient();
    if (supabase) {
      await supabase.auth.exchangeCodeForSession(code);
    }
  }

  return NextResponse.redirect(`${origin}${redirectTo}`);
}
