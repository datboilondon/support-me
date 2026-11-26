import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Donation receipt | SupportMe',
  // Receipts carry transaction details that are only meaningful when
  // verified, and an unverified receipt URL is trivially forgeable — keep
  // every receipt out of search indexes (#448).
  robots: {
    index: false,
    follow: false,
  },
};

export default function ReceiptLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
