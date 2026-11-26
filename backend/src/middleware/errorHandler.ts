import { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppError } from "../errors/AppError";
import { log } from "../lib/logger";
import * as Sentry from "@sentry/node";
import { getRequestPath } from "./requestLogger";

interface BodyParserError {
  type: string;
  status: number;
}

/**
 * body-parser attaches a `type` and a `status` to every error it produces.
 * Only 4xx statuses are client errors (#519): a body-parser error with a 5xx
 * status is still a server fault and must keep flowing to the Sentry path.
 */
function isBodyParserError(err: unknown): err is BodyParserError {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as Partial<BodyParserError>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.status === "number" &&
    Number.isInteger(candidate.status) &&
    candidate.status >= 400 &&
    candidate.status < 500
  );
}

// Stable client-facing codes, keyed by body-parser's error type. The status
// fallback keeps other 4xx body-parser errors in the same error vocabulary.
const BODY_PARSER_CODES: Record<string, string> = {
  "entity.parse.failed": "VALIDATION_ERROR",
  "entity.too.large": "PAYLOAD_TOO_LARGE",
  "charset.unsupported": "UNSUPPORTED_CHARSET",
  "encoding.unsupported": "UNSUPPORTED_ENCODING",
  "request.aborted": "REQUEST_ABORTED",
  "request.size.invalid": "INVALID_CONTENT_LENGTH",
  "parameters.too.many": "TOO_MANY_PARAMETERS",
  "entity.verify.failed": "REQUEST_REJECTED",
};

const STATUS_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "UNPROCESSABLE_ENTITY",
  429: "TOO_MANY_REQUESTS",
  499: "REQUEST_ABORTED",
};

// Fixed messages only: body-parser error messages can quote charset names or
// other request details, so never pass them through to the client.
const BODY_PARSER_MESSAGES: Record<string, string> = {
  "entity.too.large": "Request body is too large",
  "charset.unsupported": "Unsupported charset in request body",
  "encoding.unsupported": "Unsupported content encoding in request body",
  "request.aborted": "Request aborted",
  "request.size.invalid": "Invalid content length",
  "parameters.too.many": "Too many request parameters",
  "entity.verify.failed": "Request body rejected",
};

function bodyParserCode(err: BodyParserError): string {
  return BODY_PARSER_CODES[err.type] ?? STATUS_CODES[err.status] ?? "BAD_REQUEST";
}

// Adds the request's id to a response payload so a failed request can be
// cross-referenced against the request log line that shares the same id.
function withRequestId(
  req: Request,
  payload: Record<string, unknown>
): Record<string, unknown> {
  return req.requestId ? { ...payload, requestId: req.requestId } : payload;
}

// Extracts a safe, single-line description of an error without serializing
// bodies, headers or stack traces, which could contain sensitive data.
function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err ?? "unknown");
}

/**
 * Single place where every error thrown or forwarded via `next(err)` in the
 * app ends up. Keeping this centralized means every route gets the same
 * response shape and log format instead of ad-hoc `res.status(...).json(...)`
 * calls scattered across route files.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(withRequestId(req, { error: err.message, code: err.code }));
  }

  // express.json() rejects malformed, oversized and mis-encoded bodies before
  // any route schema runs. These are client errors (#519): honour the status
  // body-parser assigned, keep the standard error shape, and return before the
  // error-level log and Sentry capture below. An unparseable body keeps the
  // schema-failure shape so clients only handle one validation format.
  if (isBodyParserError(err)) {
    if (err.type === "entity.parse.failed") {
      return res.status(err.status).json(
        withRequestId(req, {
          error: "Validation failed",
          code: "VALIDATION_ERROR",
          details: [{ path: "", message: "Request body is not valid JSON" }],
        })
      );
    }

    return res.status(err.status).json(
      withRequestId(req, {
        error: BODY_PARSER_MESSAGES[err.type] ?? "Invalid request body",
        code: bodyParserCode(err),
      })
    );
  }

  if (err instanceof ZodError) {
    return res.status(400).json(
      withRequestId(req, {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: err.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    );
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      // Keep database identifiers in server logs only; never expose them in API responses.
      log("warn", "Prisma unique constraint conflict", {
        requestId: req.requestId,
        target: err.meta?.target,
      });
      return res.status(409).json(
        withRequestId(req, {
          error: "A record with these details already exists",
          code: "CONFLICT",
        })
      );
    }
    if (err.code === "P2003") {
      log("warn", "Prisma foreign key constraint violation", {
        requestId: req.requestId,
        fieldName: err.meta?.field_name,
      });
      return res.status(409).json(
        withRequestId(req, {
          error: "The requested operation conflicts with an existing record",
          code: "CONFLICT",
        })
      );
    }
    if (err.code === "P2000") {
      log("warn", "Prisma value exceeds column length", {
        requestId: req.requestId,
        columnName: err.meta?.column_name,
      });
      return res.status(400).json(
        withRequestId(req, {
          error: "One or more submitted values are too long",
          code: "VALIDATION_ERROR",
        })
      );
    }
    if (err.code === "P2034") {
      log("warn", "Prisma transaction conflict; client may retry", {
        requestId: req.requestId,
      });
      res.setHeader("Retry-After", "1");
      return res.status(503).json(
        withRequestId(req, {
          error: "The operation could not be completed due to temporary contention. Please retry.",
          code: "SERVICE_UNAVAILABLE",
        })
      );
    }
    if (err.code === "P2025") {
      return res.status(404).json(withRequestId(req, { error: "Record not found", code: "NOT_FOUND" }));
    }
  }

  const path = getRequestPath(req);

  log("error", "unhandled error", {
    requestId: req.requestId,
    method: req.method,
    path,
    error: safeErrorMessage(err),
  });

  // Report unexpected 500 errors to Sentry (#273)
  Sentry.captureException(err, {
    tags: {
      requestId: req.requestId || "unknown",
      method: req.method,
      path,
    },
  });

  return res.status(500).json(withRequestId(req, { error: "Internal server error", code: "INTERNAL_ERROR" }));
}
