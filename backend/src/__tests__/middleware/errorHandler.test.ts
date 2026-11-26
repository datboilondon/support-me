jest.mock("@sentry/node", () => ({
  captureException: jest.fn(),
}));

jest.mock("../../lib/logger", () => ({
  log: jest.fn(),
}));

import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { z, ZodError } from "zod";
import * as Sentry from "@sentry/node";
import { log } from "../../lib/logger";
import { errorHandler } from "../../middleware/errorHandler";
import { BadRequestError, NotFoundError } from "../../errors/AppError";

function mockReqRes(overrides: Partial<Request> = {}) {
  const req = { method: "GET", path: "/api/test", requestId: "req-123", ...overrides } as Request;
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res = { status } as unknown as Response;
  const next = jest.fn();
  return { req, res, status, json, next };
}

describe("errorHandler middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("maps an AppError to its own statusCode and code, echoing requestId", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = new BadRequestError("bad input");

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "bad input", code: "BAD_REQUEST", requestId: "req-123" });
  });

  it("maps a NotFoundError (404) distinctly from a BadRequestError (400)", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = new NotFoundError("missing");

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: "missing", code: "NOT_FOUND", requestId: "req-123" });
  });

  it("maps a body-parser entity.parse.failed error to a 400 VALIDATION_ERROR shape", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = { type: "entity.parse.failed", status: 400 };

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: [{ path: "", message: "Request body is not valid JSON" }],
      requestId: "req-123",
    });
  });

  it("maps a body-parser entity.too.large error to 413 PAYLOAD_TOO_LARGE without reporting it", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = { type: "entity.too.large", status: 413 };

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      error: "Request body is too large",
      code: "PAYLOAD_TOO_LARGE",
      requestId: "req-123",
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("maps a body-parser charset.unsupported error to 415 without reporting it", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = { type: "charset.unsupported", status: 415 };

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(415);
    expect(json).toHaveBeenCalledWith({
      error: "Unsupported charset in request body",
      code: "UNSUPPORTED_CHARSET",
      requestId: "req-123",
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("honours err.status for other 4xx body-parser errors", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = { type: "encoding.unsupported", status: 415 };

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(415);
    expect(json).toHaveBeenCalledWith({
      error: "Unsupported content encoding in request body",
      code: "UNSUPPORTED_ENCODING",
      requestId: "req-123",
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps a body-parser error with a 5xx status on the Sentry path", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = { type: "stream.not.readable", status: 500 };

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
      requestId: "req-123",
    });
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "error",
      "unhandled error",
      expect.objectContaining({ requestId: "req-123" })
    );
  });

  it("maps a ZodError to a 400 VALIDATION_ERROR with one detail per issue", () => {
    const { req, res, status, json, next } = mockReqRes();
    const schema = z.object({ amount: z.number().positive() });
    let zodError: ZodError;
    try {
      schema.parse({ amount: -5 });
      throw new Error("expected schema.parse to throw");
    } catch (e) {
      zodError = e as ZodError;
    }

    errorHandler(zodError, req, res, next);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: [{ path: "amount", message: expect.any(String) }],
      requestId: "req-123",
    });
  });

  it("maps a Prisma P2002 unique constraint violation to 409 CONFLICT", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["email"] },
    });

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: "A record with these details already exists",
      code: "CONFLICT",
      requestId: "req-123",
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain("email");
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("never exposes Prisma target column names in a P2002 response", () => {
    const { req, res, json, next } = mockReqRes();
    const err = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });

    errorHandler(err, req, res, next);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "A record with these details already exists" })
    );
  });

  it("maps a Prisma P2025 record-not-found error to 404 NOT_FOUND", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = new Prisma.PrismaClientKnownRequestError("Record not found", {
      code: "P2025",
      clientVersion: "test",
    });

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: "Record not found", code: "NOT_FOUND", requestId: "req-123" });
  });

  it("maps Prisma P2003 foreign-key violations to a safe 409 without reporting to Sentry", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = new Prisma.PrismaClientKnownRequestError("Some other failure", {
      code: "P2003",
      clientVersion: "test",
    });

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: "The requested operation conflicts with an existing record",
      code: "CONFLICT",
      requestId: "req-123",
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("maps Prisma P2000 oversized values to 400 without reporting to Sentry", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = new Prisma.PrismaClientKnownRequestError("Value too long", {
      code: "P2000", clientVersion: "test", meta: { column_name: "internal_column" },
    });
    errorHandler(err, req, res, next);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: "One or more submitted values are too long",
      code: "VALIDATION_ERROR",
      requestId: "req-123",
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain("internal_column");
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("maps Prisma P2034 transaction conflicts to retryable 503 without reporting to Sentry", () => {
    const { req, res, status, json, next } = mockReqRes();
    const setHeader = jest.fn();
    (res as unknown as { setHeader: typeof setHeader }).setHeader = setHeader;
    const err = new Prisma.PrismaClientKnownRequestError("Transaction conflict", {
      code: "P2034", clientVersion: "test",
    });
    errorHandler(err, req, res, next);
    expect(setHeader).toHaveBeenCalledWith("Retry-After", "1");
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      error: "The operation could not be completed due to temporary contention. Please retry.",
      code: "SERVICE_UNAVAILABLE",
      requestId: "req-123",
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("maps an unknown/unexpected error to a generic 500, and reports it to Sentry", () => {
    const { req, res, status, json, next } = mockReqRes();
    const err = new Error("something exploded");

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
      requestId: "req-123",
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: { requestId: "req-123", method: "GET", path: "/api/test" },
      })
    );
  });

  it("tags the Sentry report with 'unknown' requestId when none is set on the request", () => {
    const { req, res, next } = mockReqRes({ requestId: undefined });
    const err = new Error("boom");

    errorHandler(err, req, res, next);

    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: expect.objectContaining({ requestId: "unknown" }) })
    );
  });

  it("omits requestId from the response payload when the request has none", () => {
    const { req, res, json, next } = mockReqRes({ requestId: undefined });
    const err = new BadRequestError("no id here");

    errorHandler(err, req, res, next);

    expect(json).toHaveBeenCalledWith({ error: "no id here", code: "BAD_REQUEST" });
  });

  it("does not report a known AppError to Sentry", () => {
    const { req, res, next } = mockReqRes();

    errorHandler(new BadRequestError("handled"), req, res, next);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("extracts the full path from originalUrl (with query string stripped) for Sentry tags (#535)", () => {
    const { req, res, next } = mockReqRes({
      originalUrl: "/api/creators/bob?secret=token&tab=overview",
      path: "/bob",
    });
    const err = new Error("unhandled boom");

    errorHandler(err, req, res, next);

    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({
          path: "/api/creators/bob",
        }),
      })
    );
  });
});
