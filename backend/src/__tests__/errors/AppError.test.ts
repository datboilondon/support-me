import {
  AppError,
  BadGatewayError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  UnprocessableEntityError,
} from "../../errors/AppError";

describe("AppError subclasses", () => {
  it("sets statusCode, code and message on the base AppError", () => {
    const err = new AppError("Something went wrong", 418, "TEAPOT");

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Something went wrong");
    expect(err.statusCode).toBe(418);
    expect(err.code).toBe("TEAPOT");
    expect(err.name).toBe("AppError");
  });

  it("BadRequestError maps to 400/BAD_REQUEST", () => {
    const err = new BadRequestError("bad input");
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toBe("bad input");
  });

  it("UnauthorizedError maps to 401/UNAUTHORIZED with a default message", () => {
    const err = new UnauthorizedError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toBe("Authentication required");
  });

  it("UnauthorizedError accepts a custom message", () => {
    const err = new UnauthorizedError("Invalid signature");
    expect(err.message).toBe("Invalid signature");
  });

  it("NotFoundError maps to 404/NOT_FOUND", () => {
    const err = new NotFoundError("Creator not found");
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("ConflictError maps to 409/CONFLICT", () => {
    const err = new ConflictError("Username already exists");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("CONFLICT");
  });

  it("BadGatewayError maps to 502/BAD_GATEWAY", () => {
    const err = new BadGatewayError("Twitter token exchange failed, please try again");
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe("BAD_GATEWAY");
  });

  it("UnprocessableEntityError maps to 422/UNPROCESSABLE_ENTITY", () => {
    const err = new UnprocessableEntityError("Request body changed");
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("UNPROCESSABLE_ENTITY");
    expect(err.message).toBe("Request body changed");
  });
});
