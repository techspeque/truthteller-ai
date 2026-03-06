import './globals.css';

export const metadata = {
  title: 'TruthTeller AI',
  description: 'Multi-LLM deliberation system with anonymized peer review',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
