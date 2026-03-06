import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TruthTeller AI',
  description: 'Multi-LLM deliberation system with anonymized peer review',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
