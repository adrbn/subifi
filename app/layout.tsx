import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SubIFI — Video subtitle editor',
  description:
    'Upload a video, transcribe voices, edit and style subtitles, export SRT/VTT/TXT/JSON or a burned-in MP4.',
  manifest: '/manifest.json',
  icons: {
    icon: '/favicon.svg',
    apple: '/icon-192.svg',
  },
  themeColor: '#6366f1',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'SubIFI',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
