import { Logo } from '@foodstack/ui/components/logo';

export const metadata = { title: 'Sign in' };

// Placeholder; the sign-in form is implemented with the auth module.
export default function LoginPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6">
      <Logo />
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="text-sm text-muted-foreground">Sign-in is not available yet.</p>
    </main>
  );
}
