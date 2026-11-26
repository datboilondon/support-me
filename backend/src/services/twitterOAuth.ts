import { randomBytes, createHash } from "crypto";
import { BadGatewayError, UnauthorizedError } from "../errors/AppError";

/**
 * Twitter/X OAuth 2.0 (Authorization Code + PKCE) integration (#14). Kept
 * to plain `fetch` calls with no SDK, the same house style as the Soroban
 * RPC client (sorobanEventListener.ts) and the email provider
 * (mailer.ts) — one module owns knowing the provider's API shape, so
 * swapping or mocking it never touches a caller.
 */

const AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const PROFILE_URL = "https://api.twitter.com/2/users/me";

/**
 * Hard ceiling on a provider round-trip (#438). Without it a hung Twitter
 * endpoint holds the request (and its socket) open indefinitely, so the
 * sign-in never fails and the client never gets a response.
 */
export const TWITTER_REQUEST_TIMEOUT_MS = 10_000;

/** Provider statuses that mean "this code or token is not acceptable". */
const AUTH_REJECTION_STATUSES = new Set([400, 401, 403]);

/**
 * Maps a failed provider call to the status our API returns, without
 * copying the provider's response body: it can echo the authorization code,
 * the client secret or the access token into logs and error responses.
 * Twitter refusing the code/token is our caller's sign-in failing (401);
 * anything else — a provider 5xx, a timeout, a malformed body — is Twitter
 * being unavailable from this API's point of view (502).
 */
function twitterFailure(operation: string, status?: number): UnauthorizedError | BadGatewayError {
  if (status !== undefined && AUTH_REJECTION_STATUSES.has(status)) {
    return new UnauthorizedError(`Twitter rejected the ${operation}, please try again`);
  }
  return new BadGatewayError(`Twitter ${operation} failed, please try again`);
}

async function readJson<T>(response: Response, operation: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw twitterFailure(operation);
  }
}

export interface TwitterOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getTwitterOAuthConfig(): TwitterOAuthConfig | null {
  const clientId = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  const redirectUri = process.env.TWITTER_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** S256 PKCE, per RFC 7636 (the only method Twitter's OAuth 2.0 accepts). */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  config: TwitterOAuthConfig,
  state: string,
  codeChallenge: string
): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  // "users.read" for the profile fetch below, "tweet.read" because
  // Twitter's API requires it alongside users.read, "offline.access" only
  // if a refresh token is ever needed later (not used today, kept for
  // forward-compatibility with the OAuthIdentity.refreshToken column).
  url.searchParams.set("scope", "users.read tweet.read");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface TwitterTokenResponse {
  accessToken: string;
  refreshToken?: string;
}

export async function exchangeCodeForToken(
  config: TwitterOAuthConfig,
  code: string,
  codeVerifier: string
): Promise<TwitterTokenResponse> {
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(TWITTER_REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Timeout (TimeoutError), connection failure, DNS failure: all mean the
    // provider is unreachable from here, never that the code was bad.
    throw twitterFailure("token exchange");
  }

  if (!response.ok) {
    throw twitterFailure("token exchange", response.status);
  }

  const data = await readJson<{ access_token?: string; refresh_token?: string }>(
    response,
    "token exchange"
  );
  if (!data.access_token) {
    throw twitterFailure("token exchange");
  }

  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

export interface TwitterProfile {
  id: string;
  username: string;
  name: string;
}

export async function fetchTwitterProfile(accessToken: string): Promise<TwitterProfile> {
  let response: Response;
  try {
    response = await fetch(`${PROFILE_URL}?user.fields=username,name`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TWITTER_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw twitterFailure("profile fetch");
  }

  if (!response.ok) {
    throw twitterFailure("profile fetch", response.status);
  }

  const data = await readJson<{ data?: { id?: string; username?: string; name?: string } }>(
    response,
    "profile fetch"
  );
  const profile = data.data;
  if (!profile?.id) {
    throw twitterFailure("profile fetch");
  }

  return { id: profile.id, username: profile.username ?? "", name: profile.name ?? "" };
}
