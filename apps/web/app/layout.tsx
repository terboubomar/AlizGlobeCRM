import type { Metadata } from 'next';
import { connection } from 'next/server';
import '@fontsource/cairo/400.css';
import '@fontsource/cairo/600.css';
import '@fontsource/cairo/700.css';
import '@fontsource/cairo/800.css';
import './style.css';
export const metadata: Metadata = {
  title: 'أليز غلوب | إدارة تجربة العملاء',
  description: 'مساحة عمل موحّدة لتجربة العملاء وعمليات الفروع',
  robots: { index: false, follow: false },
};
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Render per request so Next.js can attach the CSP nonce from proxy.ts to
  // its scripts. A statically prerendered page would have no nonce and its
  // scripts would be blocked.
  await connection();
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
