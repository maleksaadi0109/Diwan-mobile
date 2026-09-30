// Android downloads YouTube audio locally. A server is optional for that flow,
// but if configured it must be a stable published host (used for alignment).
const domain = process.env.EXPO_PUBLIC_DOMAIN;
if (!domain) {
  console.log('No audio API configured: Android on-device YouTube downloads remain available; server-based alignment/upload processing will be unavailable.');
  process.exit(0);
}
if (
  !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(domain) ||
  domain.includes('..') ||
  domain.endsWith('.replit.dev') ||
  domain === 'localhost'
) {
  console.error(
    'EXPO_PUBLIC_DOMAIN, when supplied, must be a published HTTPS API hostname only (no https:// or temporary development host).',
  );
  process.exit(1);
}