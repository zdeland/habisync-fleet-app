import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'HabiSync Fleet Monitor',
  description: 'Monitoring and debugging web app for HabiSync devices',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
