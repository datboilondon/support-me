import {
  TWITTER_REQUEST_TIMEOUT_MS,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchTwitterProfile,
  generatePkcePair,
  getTwitterOAuthConfig,
} from "../../services/twitterOAuth";
import { AppError } from "../../errors/AppError";

const CONFIG = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://supportme.app/auth/twitter/callback",
};

describe("getTwitterOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when any required env var is missing", () => {
    delete process.env.TWITTER_CLIENT_ID;
    delete process.env.TWITTER_CLIENT_SECRET;
    delete process.env.TWITTER_REDIRECT_URI;
    expect(getTwitterOAuthConfig()).toBeNull();
  });

  it("returns the config when all three env vars are set", () => {
    process.env.TWITTER_CLIENT_ID = "id";
    process.env.TWITTER_CLIENT_SECRET = "secret";
    process.env.TWITTER_REDIRECT_URI = "https://supportme.app/callback";
    expect(getTwitterOAuthConfig()).toEqual({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "https://supportme.app/callback",
    });
  });
});

describe("generatePkcePair", () => {
  it("produces a challenge derived from the verifier via SHA-256/base64url (not equal to it)", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier).not.toBe(challenge);
    expect(verifier.length).toBeGreaterThan(20);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet only
  });

  it("produces a different pair on every call", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes the required OAuth 2.0 + PKCE parameters", () => {
    const url = new URL(buildAuthorizeUrl(CONFIG, "state-123", "challenge-abc"));

    expect(url.origin + url.pathname).toBe("https://twitter.com/i/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("exchangeCodeForToken", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts the authorization code with Basic auth and returns the parsed tokens", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "at-1", refresh_token: "rt-1" }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await exchangeCodeForToken(CONFIG, "auth-code", "verifier-value");

    expect(result).toEqual({ accessToken: "at-1", refreshToken: "rt-1" });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.twitter.com/2/oauth2/token");
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("verifier-value");
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  it("passes a timeout signal to the provider request (#438)", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "at-1" }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await exchangeCodeForToken(CONFIG, "auth-code", "verifier-value");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
    expect(TWITTER_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("maps a rejected code to a 401 without leaking the provider body (#438)", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "invalid_grant: code expired for client-id:secret",
    }) as unknown as typeof fetch;

    const error = await exchangeCodeForToken(CONFIG, "bad-code", "verifier").catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(401);
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.message).not.toMatch(/invalid_grant|client-id|secret/);
  });

  it("maps a provider 5xx to a 502 without leaking the provider body (#438)", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "upstream detail",
    }) as unknown as typeof fetch;

    const error = await exchangeCodeForToken(CONFIG, "auth-code", "verifier").catch((e) => e);

    expect(error.statusCode).toBe(502);
    expect(error.code).toBe("BAD_GATEWAY");
    expect(error.message).not.toMatch(/upstream detail/);
  });

  it("fails with a 502 instead of hanging when the provider never answers (#438)", async () => {
    // A hung endpoint surfaces as the AbortSignal.timeout() abort, i.e. a
    // rejection distinct from any HTTP response.
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    global.fetch = jest.fn().mockRejectedValue(timeout) as unknown as typeof fetch;

    const error = await exchangeCodeForToken(CONFIG, "auth-code", "verifier").catch((e) => e);

    expect(error.statusCode).toBe(502);
    expect(error.message).not.toMatch(/aborted/i);
  });

  it("maps an unparseable success response to a 502 rather than a 500", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }) as unknown as typeof fetch;

    const error = await exchangeCodeForToken(CONFIG, "auth-code", "verifier").catch((e) => e);

    expect(error.statusCode).toBe(502);
  });
});

describe("fetchTwitterProfile", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns the profile fields from a successful response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "12345", username: "alice", name: "Alice" } }),
    }) as unknown as typeof fetch;

    const profile = await fetchTwitterProfile("access-token");

    expect(profile).toEqual({ id: "12345", username: "alice", name: "Alice" });
  });

  it("sends the access token as a Bearer header", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "1", username: "a", name: "A" } }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await fetchTwitterProfile("my-access-token");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer my-access-token");
  });

  it("passes a timeout signal to the provider request (#438)", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "1", username: "a", name: "A" } }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await fetchTwitterProfile("access-token");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps a rejected token to a 401 without leaking the provider body (#438)", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized: token expired",
    }) as unknown as typeof fetch;

    const error = await fetchTwitterProfile("expired-token").catch((e) => e);

    expect(error.statusCode).toBe(401);
    expect(error.message).not.toMatch(/token expired/);
  });

  it("maps a provider 5xx to a 502 (#438)", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "{\"errors\":[{\"detail\":\"internal\"}]}",
    }) as unknown as typeof fetch;

    const error = await fetchTwitterProfile("access-token").catch((e) => e);

    expect(error.statusCode).toBe(502);
    expect(error.message).not.toMatch(/internal/);
  });

  it("fails with a 502 instead of hanging when the provider never answers (#438)", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    global.fetch = jest.fn().mockRejectedValue(timeout) as unknown as typeof fetch;

    const error = await fetchTwitterProfile("access-token").catch((e) => e);

    expect(error.statusCode).toBe(502);
  });
});
