/* ============================================================
   Google OAuth — authorization code flow with offline access.

   No googleapis SDK. That package pulls in tens of megabytes to wrap
   three HTTP calls, and this runs on a box with ~120GB of disk shared
   across every CommandHQ app.

   Scope is gmail.readonly and nothing else. Warden never needs to send,
   label, or delete — and a token that cannot write is a token that
   cannot be turned against the mailbox it came from.
   ============================================================ */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/** Needed only to learn which address the user just authorised, so two
 *  accounts can be told apart. */
const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

export class GoogleAuthError extends Error {}

function creds() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GoogleAuthError(
      "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI must all be set in .env.local",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export function isConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REDIRECT_URI,
  );
}

/** `state` is a CSRF guard: generated before the redirect, checked on
 *  the way back. */
export function authorizeUrl(state: string): string {
  const { clientId, redirectUri } = creds();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: `${GMAIL_SCOPE} ${EMAIL_SCOPE}`,
    // Both are required to be handed a refresh token: offline asks for
    // one, and consent forces a fresh grant even if the user has
    // authorised before — otherwise Google returns only an access token
    // on the second run and the sync silently cannot resume.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GoogleAuthError(
      `Google token endpoint ${res.status}: ${data?.error ?? ""} ${data?.error_description ?? ""}`.trim(),
    );
  }
  return data as TokenResponse;
}

export async function exchangeCode(code: string) {
  const { clientId, clientSecret, redirectUri } = creds();
  const t = await tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (!t.refresh_token) {
    throw new GoogleAuthError(
      "Google returned no refresh token. Revoke Warden at " +
        "myaccount.google.com/permissions and authorise again — without one " +
        "the sync stops working the moment the access token expires.",
    );
  }
  return t as TokenResponse & { refresh_token: string };
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = creds();
  const t = await tokenRequest({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  return t.access_token;
}

/** Which mailbox did we just get access to? */
export async function whoAmI(accessToken: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new GoogleAuthError(`userinfo ${res.status}`);
  const data = await res.json();
  if (!data?.email) throw new GoogleAuthError("userinfo returned no email address");
  return String(data.email).toLowerCase();
}
