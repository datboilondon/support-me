import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Suspense } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import ReceiptPage from '../page';

const params = vi.hoisted(() => ({ current: new URLSearchParams() }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => params.current,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const TX_HASH = 'abc123def456';

const VERIFIED_DONATION = {
  transactionHash: TX_HASH,
  amount: '25',
  currency: 'XLM',
  message: 'Keep it up',
  createdAt: '2026-11-19T10:00:00.000Z',
  verified: true,
  creator: { username: 'maya', displayName: 'Maya', avatarUrl: null },
};

const fetchMock = vi.fn();

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function notFoundResponse() {
  return {
    ok: false,
    status: 404,
    json: async () => ({ code: 'NOT_FOUND', message: 'Donation not found' }),
  };
}

// ReceiptPage unwraps the `params` prop with React's use(), which suspends
// on an unresolved promise — App Router provides a Suspense boundary in
// production, so tests need to provide one too. The initial render has to be
// wrapped in `act` (and awaited) for React to flush past the suspended commit
// once the (already-resolved) promise settles.
async function renderReceipt(
  search = '',
  response: ReturnType<typeof okResponse> | ReturnType<typeof notFoundResponse> | Error = notFoundResponse()
) {
  params.current = new URLSearchParams(search);
  if (response instanceof Error) {
    fetchMock.mockRejectedValue(response);
  } else {
    fetchMock.mockResolvedValue(response);
  }

  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <Suspense fallback={null}>
        <ReceiptPage params={Promise.resolve({ txHash: TX_HASH })} />
      </Suspense>
    );
  });
  return result;
}

beforeEach(() => {
  params.current = new URLSearchParams();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReceiptPage (#448)', () => {
  it('renders the verified donation from the API, not the query params', async () => {
    await renderReceipt(
      // Every value is tampered: the verified API record must win.
      'amount=9999&asset=USDC&creatorName=Forger&creatorUsername=forger&message=forged&timestamp=2020-01-01T00:00:00.000Z',
      okResponse(VERIFIED_DONATION)
    );

    await waitFor(() => expect(screen.getByText('25 XLM')).toBeInTheDocument());
    expect(screen.getByText('Maya')).toBeInTheDocument();
    expect(screen.getByText('@maya')).toBeInTheDocument();
    expect(screen.getByText(TX_HASH)).toBeInTheDocument();
    expect(screen.getByText(/Keep it up/)).toBeInTheDocument();
    // The formatted date appears twice: the print-only header and the date section.
    expect(screen.getAllByText(/November 19, 2026/)).toHaveLength(2);

    // Tampered params did not change the amount, recipient or date.
    expect(screen.queryByText(/9999/)).not.toBeInTheDocument();
    expect(screen.queryByText('Forger')).not.toBeInTheDocument();
    expect(screen.queryByText('@forger')).not.toBeInTheDocument();
    expect(screen.queryByText(/2020/)).not.toBeInTheDocument();
    expect(screen.queryByText('Unverified receipt')).not.toBeInTheDocument();
  });

  it('requests the verified donation for the transaction hash in the URL', async () => {
    await renderReceipt('', okResponse(VERIFIED_DONATION));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/api/donations/${TX_HASH}`),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('marks the receipt unverified when the API has no matching donation', async () => {
    await renderReceipt('amount=9999&creatorName=Forger', notFoundResponse());

    await waitFor(() => expect(screen.getByText('Unverified receipt')).toBeInTheDocument());
    expect(screen.getByText('9999 XLM')).toBeInTheDocument();
    expect(screen.getByText('Forger')).toBeInTheDocument();
  });

  it('marks the receipt unverified when the lookup request fails', async () => {
    await renderReceipt('amount=25&creatorName=Maya', new Error('network down'));

    await waitFor(() => expect(screen.getByText('Unverified receipt')).toBeInTheDocument());
    expect(screen.getByText('25 XLM')).toBeInTheDocument();
  });

  it('treats a donation the API reports as unverified as unverified', async () => {
    await renderReceipt(
      'amount=9999&creatorName=Forger',
      okResponse({ ...VERIFIED_DONATION, verified: false })
    );

    await waitFor(() => expect(screen.getByText('Unverified receipt')).toBeInTheDocument());
  });

  it('falls back to defaults and an Unknown date when nothing is available', async () => {
    await renderReceipt();

    await waitFor(() => expect(screen.getByText('Unverified receipt')).toBeInTheDocument());
    expect(screen.getByText('0 XLM')).toBeInTheDocument();
    expect(screen.getByText('Unknown Creator')).toBeInTheDocument();
    expect(screen.getByText('@unknown')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('hides the message section when there is no message', async () => {
    await renderReceipt('', okResponse({ ...VERIFIED_DONATION, message: null }));

    await waitFor(() => expect(screen.getByText('25 XLM')).toBeInTheDocument());
    expect(screen.queryByText('Message')).not.toBeInTheDocument();
  });

  it('shows Invalid Date for an unparseable timestamp', async () => {
    await renderReceipt('amount=25&timestamp=not-a-date');

    await waitFor(() => expect(screen.getByText('Invalid Date')).toBeInTheDocument());
  });

  it('links the transaction hash to the Stellar explorer', async () => {
    await renderReceipt('', okResponse(VERIFIED_DONATION));

    const link = screen.getByLabelText('View on Stellar Explorer');
    expect(link.getAttribute('href')).toBe(
      `https://stellar.expert/explorer/testnet/tx/${TX_HASH}`
    );
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('calls window.print when the print button is clicked', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    await renderReceipt('', okResponse(VERIFIED_DONATION));

    fireEvent.click(screen.getByLabelText('Print receipt'));

    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });
});
