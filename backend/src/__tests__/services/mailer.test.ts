jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    emailEvent: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  },
}));

import { sendEmail } from "../../services/email/mailer";
import prisma from "../../prisma";

const mockedPrisma = prisma as unknown as {
  emailEvent: {
    findFirst: jest.Mock;
    create: jest.Mock;
  };
};

const message = { to: "supporter@example.com", subject: "Hello", html: "<p>hi</p>", text: "hi" };

describe("sendEmail", () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalTimeout = process.env.EMAIL_SEND_TIMEOUT_MS;

  beforeEach(() => {
    mockedPrisma.emailEvent.findFirst.mockResolvedValue(null);
    mockedPrisma.emailEvent.create.mockResolvedValue({});
    process.env.RESEND_API_KEY = "test-key";
    delete process.env.EMAIL_SEND_TIMEOUT_MS;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.RESEND_API_KEY = originalApiKey;
    if (originalTimeout === undefined) {
      delete process.env.EMAIL_SEND_TIMEOUT_MS;
    } else {
      process.env.EMAIL_SEND_TIMEOUT_MS = originalTimeout;
    }
  });

  it("records a SENT event with the provider message id on success", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-123" }),
    }) as unknown as typeof fetch;

    await sendEmail(message);

    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledWith({
      data: {
        recipient: message.to,
        subject: message.subject,
        type: "SENT",
        providerMessageId: "resend-123",
      },
    });
  });

  it("records a FAILED event and rethrows when the provider responds with an error", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => "invalid recipient",
    }) as unknown as typeof fetch;

    await expect(sendEmail(message)).rejects.toThrow("Email provider responded 422");

    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledWith({
      data: {
        recipient: message.to,
        subject: message.subject,
        type: "FAILED",
        errorDetail: "HTTP 422: invalid recipient",
      },
    });
  });

  it("records a FAILED event and rethrows on a network error", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("fetch failed")) as unknown as typeof fetch;

    await expect(sendEmail(message)).rejects.toThrow("fetch failed");

    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledWith({
      data: {
        recipient: message.to,
        subject: message.subject,
        type: "FAILED",
        errorDetail: "fetch failed",
      },
    });
  });

  it("skips sending and does not hit the provider when the recipient is suppressed", async () => {
    mockedPrisma.emailEvent.findFirst.mockResolvedValue({ id: 1 });
    global.fetch = jest.fn() as unknown as typeof fetch;

    await sendEmail(message);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockedPrisma.emailEvent.create).not.toHaveBeenCalled();
  });

  it("only checks for recent BOUNCED/COMPLAINED events, not all history", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-456" }),
    }) as unknown as typeof fetch;

    await sendEmail(message);

    expect(mockedPrisma.emailEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recipient: { equals: message.to, mode: "insensitive" },
          type: { in: ["BOUNCED", "COMPLAINED"] },
        }),
      })
    );
  });

  it("suppresses a mixed-case address case-insensitively (#534)", async () => {
    mockedPrisma.emailEvent.findFirst.mockResolvedValue({ id: 1 });
    global.fetch = jest.fn() as unknown as typeof fetch;

    await sendEmail({ ...message, to: "  Bob@Example.COM " });

    expect(mockedPrisma.emailEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recipient: { equals: "bob@example.com", mode: "insensitive" },
        }),
      })
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("normalizes the recipient to lowercase when recording events (#534)", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-789" }),
    }) as unknown as typeof fetch;

    await sendEmail({ ...message, to: "Bob@Example.COM" });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({ body: expect.stringContaining('"to":["bob@example.com"]') })
    );
    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledWith({
      data: {
        recipient: "bob@example.com",
        subject: message.subject,
        type: "SENT",
        providerMessageId: "resend-789",
      },
    });
  });

  it("aborts a hung provider call within the configured timeout and records a FAILED event (#530)", async () => {
    process.env.EMAIL_SEND_TIMEOUT_MS = "25";
    global.fetch = jest.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal?.reason));
        })
    ) as unknown as typeof fetch;

    await expect(sendEmail(message)).rejects.toThrow("Email provider request timed out after 25ms");

    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledWith({
      data: {
        recipient: message.to,
        subject: message.subject,
        type: "FAILED",
        errorDetail: "Email provider request timed out after 25ms",
      },
    });
  });

  it("logs instead of sending when RESEND_API_KEY is unset", async () => {
    delete process.env.RESEND_API_KEY;
    global.fetch = jest.fn() as unknown as typeof fetch;

    await sendEmail(message);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockedPrisma.emailEvent.create).not.toHaveBeenCalled();
  });
});
