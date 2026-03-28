import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Transcriptor para Papá',
  description: 'Transcribe videos de YouTube, Facebook e Instagram al instante',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
