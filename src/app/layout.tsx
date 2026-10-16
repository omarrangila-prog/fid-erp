import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { Toaster } from 'sonner';
import { BrandProvider } from '@/components/brand-context';
import { getBrand } from '@/lib/brand';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export function generateMetadata(): Metadata {
  const brand = getBrand();
  return {
    title: { default: brand.name, template: `%s · ${brand.name}` },
    description: brand.description,
    icons: { icon: brand.icon },
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#faf8f4',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-dvh antialiased">
        <BrandProvider brand={getBrand()}>{children}</BrandProvider>
        <Toaster
          position="top-right"
          toastOptions={{
            className: 'text-sm',
            style: { borderRadius: '0.6rem' },
          }}
        />
      </body>
    </html>
  );
}
