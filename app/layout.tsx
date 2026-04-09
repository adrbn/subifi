import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SubIFI — Video subtitle editor',
  description:
    'Upload a video, transcribe voices, edit and style subtitles, export SRT/VTT/TXT/JSON or a burned-in MP4.',
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
