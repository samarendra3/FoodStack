import { Plus_Jakarta_Sans } from 'next/font/google';
import type { ReactNode } from 'react';

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-jakarta',
  display: 'swap',
});

// Applies the saved theme before paint so the page does not flash light → dark.
const themeScript = `try{if(localStorage.getItem('fs-theme')==='dark')document.documentElement.classList.add('dark')}catch(e){}`;

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className={jakarta.variable}>
      <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      {children}
    </div>
  );
}
