import { type NextRequest, NextResponse } from 'next/server';

/**
 * Optimistic check before protected pages render: without the API's `fs_session` marker cookie
 * the visitor is sent to sign-in straight away. The marker proves nothing by itself; the page
 * then confirms the session with the API, and the API authorizes every request.
 */
export function proxy(request: NextRequest) {
  const marker = request.cookies.get('fs_session')?.value;
  const { pathname, search } = request.nextUrl;
  const platformArea = pathname === '/platform' || pathname.startsWith('/platform/');

  if (!marker || (platformArea && marker !== 'platform')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  const response = NextResponse.next();
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const config = {
  matcher: [
    '/platform/:path*',
    '/restaurant/:path*',
    '/pos/:path*',
    '/kitchen/:path*',
    '/waiter/:path*',
  ],
};
