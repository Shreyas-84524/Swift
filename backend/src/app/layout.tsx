import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  applicationName: 'Swift',
  title: 'Swift | SMS & OTP Console',
  description: 'Swift brings your projects, API keys, and SMS gateway devices into one secure workspace.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
