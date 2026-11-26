'use client';

import { use, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { HugeiconsIcon } from '@hugeicons/react';
import { FileEmpty02Icon, PrinterIcon, ExternalLinkIcon } from '@hugeicons/core-free-icons';
import { explorerTxUrl } from '@/lib/stellarNetwork';
import { API_URL } from '@/lib/api';

/** Donation shape returned by GET /api/donations/:transactionHash (#448). */
export interface VerifiedReceiptDonation {
  transactionHash: string;
  amount: string;
  currency: string;
  message: string | null;
  createdAt: string;
  verified: boolean;
  creator: {
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

interface ReceiptDetails {
  amount: string;
  asset: string;
  creatorName: string;
  creatorUsername: string;
  message: string;
  /** ISO timestamp, or null when neither the API nor the URL provided one. */
  timestamp: string | null;
}

type ReceiptState =
  | { status: 'loading' }
  | { status: 'verified'; details: ReceiptDetails }
  | { status: 'unverified'; details: ReceiptDetails };

function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function detailsFromParams(searchParams: URLSearchParams): ReceiptDetails {
  return {
    amount: searchParams.get('amount') || '0',
    asset: searchParams.get('asset') || 'XLM',
    creatorName: searchParams.get('creatorName') || 'Unknown Creator',
    creatorUsername: searchParams.get('creatorUsername') || 'unknown',
    message: searchParams.get('message') || '',
    // Only use a timestamp the URL actually supplies; falling back to "now"
    // would turn a missing value into a fabricated receipt date (#448).
    timestamp: searchParams.get('timestamp'),
  };
}

function detailsFromDonation(donation: VerifiedReceiptDonation): ReceiptDetails {
  return {
    amount: donation.amount,
    asset: donation.currency,
    creatorName: donation.creator.displayName || donation.creator.username,
    creatorUsername: donation.creator.username,
    message: donation.message || '',
    timestamp: donation.createdAt,
  };
}

export default function ReceiptPage({ params }: { params: Promise<{ txHash: string }> }) {
  const { txHash } = use(params);
  const searchParams = useSearchParams();
  // useSearchParams returns a new object on some renders; a stable string
  // keeps the verification effect from re-running on every render.
  const searchString = searchParams.toString();
  const [state, setState] = useState<ReceiptState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const showUnverified = () => {
      if (!active) return;
      setState({
        status: 'unverified',
        details: detailsFromParams(new URLSearchParams(searchString)),
      });
    };

    async function verifyTransaction() {
      try {
        const res = await fetch(
          `${API_URL}/api/donations/${encodeURIComponent(txHash)}`,
          { signal: controller.signal }
        );
        if (!res.ok) {
          showUnverified();
          return;
        }
        const donation: VerifiedReceiptDonation = await res.json();
        if (!active) return;
        // The API only serves on-chain-verified rows, but check the flag
        // anyway so a change in that contract cannot silently trust params.
        if (donation?.verified === true) {
          setState({ status: 'verified', details: detailsFromDonation(donation) });
          return;
        }
        showUnverified();
      } catch {
        // Network failure or abort: fall back to the URL details, clearly
        // marked as unverified, rather than showing an error page.
        showUnverified();
      }
    }

    verifyTransaction();
    return () => {
      active = false;
      controller.abort();
    };
  }, [txHash, searchString]);

  const explorerUrl = explorerTxUrl(txHash);

  const handlePrint = () => {
    window.print();
  };

  if (state.status === 'loading') {
    return (
      <div className="min-h-screen bg-background py-10 px-4">
        <div className="max-w-2xl mx-auto">
          <div className="card-brutal p-8" role="status">
            <p className="text-ink font-extrabold">Verifying transaction…</p>
            <p className="text-muted font-medium text-sm mt-2 break-all">
              Checking {txHash} against the verified donation record.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const { details, status } = state;
  const { amount, asset, creatorName, creatorUsername, message, timestamp } = details;
  const formattedDate = timestamp ? formatTimestamp(timestamp) : 'Unknown';

  return (
    <div className="min-h-screen bg-background py-10 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Print-only header */}
        <div className="print-only mb-8 text-center hidden print:block">
          <h1 className="text-2xl font-extrabold text-ink">SupportMe Testnet Donation Receipt</h1>
          <p className="text-muted font-medium">Generated on {formattedDate}</p>
        </div>

        {/* Receipt card */}
        <div className="card-brutal p-8 print:shadow-none print:border-2 print:border-ink">
          {status === 'unverified' && (
            <div className="mb-8 border-2 border-ink bg-accent-bg p-4">
              <p className="text-sm font-extrabold text-ink uppercase tracking-wide">
                Unverified receipt
              </p>
              <p className="text-sm font-medium text-ink mt-1">
                This transaction was not found in the verified donation record. The details
                below came from this page&apos;s URL and may be inaccurate or forged. Verify
                the transaction hash on the Stellar explorer before relying on them.
              </p>
            </div>
          )}

          {/* Header */}
          <div className="flex items-center justify-between mb-8 print:justify-center print:gap-4">
            <div className="flex items-center gap-3 print:items-center">
              <div className="w-12 h-12 rounded-full bg-brand-lime flex items-center justify-center print:hidden">
                <HugeiconsIcon icon={FileEmpty02Icon} size={24} strokeWidth={2} className="text-ink" />
              </div>
              <div>
                <h1 className="text-2xl font-extrabold text-ink">Testnet Donation Receipt</h1>
                <p className="text-sm text-muted font-medium">SupportMe</p>
              </div>
            </div>
            <button
              onClick={handlePrint}
              className="btn-brutal btn-brutal-white px-4 py-2 flex items-center gap-2 text-sm print:hidden"
              aria-label="Print receipt"
            >
              <HugeiconsIcon icon={PrinterIcon} size={18} strokeWidth={2} />
              Print / Save PDF
            </button>
          </div>

          {/* Divider */}
          <div className="border-t-2 border-ink mb-8" />

          {/* Donation details */}
          <div className="space-y-6">
            {/* Amount */}
            <div className="flex justify-between items-baseline">
              <span className="text-lg font-bold text-ink">Amount Donated</span>
              <span className="text-3xl font-extrabold text-ink">
                {amount} {asset}
              </span>
            </div>

            {/* Divider */}
            <div className="border-b border-ink/30" />

            {/* Creator info */}
            <div className="space-y-2">
              <p className="text-sm font-bold text-muted uppercase tracking-wide">To</p>
              <div>
                <p className="text-xl font-extrabold text-ink">{creatorName}</p>
                <p className="text-muted font-medium">@{creatorUsername}</p>
              </div>
            </div>

            {/* Message */}
            {message && (
              <>
                <div className="border-b border-ink/30" />
                <div className="space-y-2">
                  <p className="text-sm font-bold text-muted uppercase tracking-wide">Message</p>
                  <p className="text-ink font-medium italic">&ldquo;{message}&rdquo;</p>
                </div>
              </>
            )}

            {/* Divider */}
            <div className="border-b border-ink/30" />

            {/* Transaction details */}
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-sm font-bold text-muted uppercase tracking-wide">Date</p>
                <p className="text-ink font-medium">{formattedDate}</p>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-bold text-muted uppercase tracking-wide">Transaction Hash</p>
                <div className="flex items-center gap-2">
                  <code className="text-sm font-mono text-ink bg-accent-bg px-2 py-1 rounded border border-ink/30 flex-1 break-all">
                    {txHash}
                  </code>
                  <a
                    href={explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-brutal btn-brutal-white px-3 py-1 flex items-center gap-1 text-sm print:hidden"
                    aria-label="View on Stellar Explorer"
                  >
                    <HugeiconsIcon icon={ExternalLinkIcon} size={16} strokeWidth={2} />
                  </a>
                </div>
                <p className="text-xs text-muted font-medium print:hidden">
                  View on Stellar Explorer for full transaction details
                </p>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="mt-8 pt-6 border-t-2 border-ink">
            <p className="text-xs text-muted font-medium text-center">
              {status === 'verified'
                ? 'This receipt reflects the verified on-chain donation recorded for this transaction.'
                : 'This receipt is unverified and its details come from the page URL, not the donation record.'}{' '}
              This is a Stellar Testnet receipt. Testnet tokens have no monetary value.
            </p>
            <p className="text-xs text-muted font-medium text-center mt-2 print:hidden">
              <Link href="/" className="underline hover:text-ink">
                Return to SupportMe
              </Link>
            </p>
          </div>
        </div>

        {/* Print footer */}
        <div className="mt-8 text-center print:block hidden">
          <p className="text-xs text-muted font-medium">
            This is a Testnet receipt — tokens have no monetary value. Verify this transaction at stellar.expert
          </p>
        </div>
      </div>

      <style jsx global>{`
        @media print {
          body {
            background: white !important;
            padding: 0 !important;
          }
          .print-only {
            display: block !important;
          }
          .card-brutal {
            box-shadow: none !important;
            border: 2px solid black !important;
          }
          .btn-brutal {
            display: none !important;
          }
          a[href^="/"] {
            display: none !important;
          }
          @page {
            margin: 2cm;
          }
        }
      `}</style>
    </div>
  );
}
