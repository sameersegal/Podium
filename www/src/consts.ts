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
  "Run your conference program without the spreadsheets. Podium handles the call for proposals, review, sponsor sessions, speaker onboarding and the schedule on your website. Open source, and it runs on infrastructure you own.";
