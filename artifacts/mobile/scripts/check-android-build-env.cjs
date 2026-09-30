// EAS uploads source and builds it in the cloud. Refuse to produce an APK
// that points to a temporary development URL or has no API server at all.
const domain = process.env.EXPO_PUBLIC_DOMAIN;
if (
  !domain ||
  !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(domain) ||
  domain.includes('..') ||
  domain.endsWith('.replit.dev') ||
  domain === 'localhost'
) {
  console.error(
    'Set EXPO_PUBLIC_DOMAIN to the published HTTPS API host (hostname only, no https://) in the EAS preview environment before building an APK.',
  );
  process.exit(1);
}