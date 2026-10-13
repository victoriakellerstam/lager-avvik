'use strict';

async function getAccessToken() {
  const clientId = process.env.TD_SYNNEX_CLIENT_ID;
  const clientSecret = process.env.TECH_DATA;
  const tokenUrl = process.env.TD_SYNNEX_TOKEN_URL;

  if (!clientId || !clientSecret || !tokenUrl) {
    throw new Error(
      'Mangler TD_SYNNEX_CLIENT_ID, TECH_DATA eller TD_SYNNEX_TOKEN_URL.'
    );
  }

  // Send bare innloggingsopplysninger til TD Synnex over HTTPS.
  const url = new URL(tokenUrl);
  const allowedHosts = [
    'api.tdsynnex.com',
    'test.api.tdsynnex.com'
  ];

  if (
    url.protocol !== 'https:' ||
    !allowedHosts.includes(url.hostname) ||
    url.pathname !== '/eu/auth/token' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Ugyldig TD Synnex token-adresse.');
  }

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

module.exports = { getAccessToken };
