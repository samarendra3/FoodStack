import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'FoodStack Admin', template: '%s · FoodStack Admin' },
  description: 'Restaurant admin dashboard',
};

export const viewport: Viewport = {
  themeColor: '#0f172a',
  width: 'device-width',
  initialScale: 1,
};

// Applies the saved theme (landing page or Super Admin area) before paint so it does not flash light → dark. It lives
// here because the root layout is rendered only on the server: a <script> rendered by a nested
// layout is re-created on client navigation, which React never executes and warns about.
const themeScript = `try{var p=location.pathname,k=p==='/'?'fs-theme':p.indexOf('/platform')===0||p.indexOf('/restaurant')===0||p.indexOf('/pos')===0||p.indexOf('/kitchen')===0||p.indexOf('/waiter')===0?'fs-app-theme':null;if(k&&localStorage.getItem(k)==='dark')document.documentElement.classList.add('dark')}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
