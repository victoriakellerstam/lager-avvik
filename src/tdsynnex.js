'use strict';

// Send bare innloggingsopplysninger til TD Synnex over HTTPS.
const ALLOWED_HOSTS = [
  'api.tdsynnex.com',
  'test.api.tdsynnex.com'
];

function parseTokenUrl(tokenUrl) {
  const url = new URL(tokenUrl);

  if (
    url.protocol !== 'https:' ||
    !ALLOWED_HOSTS.includes(url.hostname) ||
    url.pathname !== '/eu/auth/token' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Ugyldig TD Synnex token-adresse.');
  }

  return url;
}

// True when all three settings are present (not whether they are valid).
function isConfigured() {
  return Boolean(
    process.env.TD_SYNNEX_CLIENT_ID &&
    process.env.TECH_DATA &&
    process.env.TD_SYNNEX_TOKEN_URL
  );
}

// The API base for the same environment as the token URL, e.g.
// https://api.tdsynnex.com/eu (production) or https://test.api.tdsynnex.com/eu.
function getApiBaseUrl() {
  const tokenUrl = process.env.TD_SYNNEX_TOKEN_URL;

  if (!tokenUrl) {
    throw new Error('Mangler TD_SYNNEX_TOKEN_URL.');
  }

  return `${parseTokenUrl(tokenUrl).origin}/eu`;
}

async function getAccessToken() {
  const clientId = process.env.TD_SYNNEX_CLIENT_ID;
  const clientSecret = process.env.TECH_DATA;
  const tokenUrl = process.env.TD_SYNNEX_TOKEN_URL;

  if (!clientId || !clientSecret || !tokenUrl) {
    throw new Error(
      'Mangler TD_SYNNEX_CLIENT_ID, TECH_DATA eller TD_SYNNEX_TOKEN_URL.'
    );
  }

  const url = parseTokenUrl(tokenUrl);

  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(
      `TD Synnex innlogging feilet: HTTP ${response.status}.`
    );
  }

  const data = await response.json();

  if (
    typeof data.access_token !== 'string' ||
    !data.access_token
  ) {
    throw new Error(
      'TD Synnex svarte uten forventet access_token.'
    );
  }

  return data.access_token;
}

module.exports = { getAccessToken, getApiBaseUrl, isConfigured };
