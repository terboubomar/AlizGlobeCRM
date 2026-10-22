import type { Metadata } from 'next';
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
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
