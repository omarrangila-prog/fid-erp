import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'FID Trading',
    template: '%s · FID Trading',
  },
  description:
    'Coffee trading, inventory, shipment and accounting management for FID Trading L.L.C. and FID Trading International SARL.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#faf8f4',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-dvh antialiased">
        {children}
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
