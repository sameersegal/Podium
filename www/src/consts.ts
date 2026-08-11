/**
 * Every outbound link in one place.
 *
 * The app's own code deliberately does not know what hostname it is served on
 * — it takes `PUBLIC_BASE_URL` at deploy time. This site is the one place that
 * does know, because pointing at the app is its job. Keeping the value here
 * rather than inline in the markup means the marketing site has exactly one
 * fact to change if the app ever moves again, and `public/_redirects` is the
 * other. There is no third.
 */
export const APP_URL = "https://app.podiumstack.com";
export const SIGN_IN_URL = `${APP_URL}/login`;

export const GITHUB_URL = "https://github.com/sameersegal/Podium";
export const DOMAIN_MODEL_URL = `${GITHUB_URL}/blob/main/docs/domain/README.md`;

export const SITE_TITLE = "Podium";
export const SITE_DESCRIPTION =
  "Open-source conference program management — submissions, review, speaker onboarding and a public schedule. An alternative to SessionBoard, built for Cloudflare.";
