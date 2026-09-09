import type { Metadata } from 'next';
import { BRAND } from '@shared/brand';
import '../globals.css';
import { KdsHtmlLang } from '@/components/kds/KdsHtmlLang';

export const metadata: Metadata = {
  title: `${BRAND.productName} — Cocina`,
  description: 'Kitchen Display System',
};

export default function KdsStandaloneLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen h-full flex flex-col p-4 bg-muted">
      <KdsHtmlLang />
      {children}
    </div>
  );
}
