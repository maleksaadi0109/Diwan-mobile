const {
  withAndroidManifest,
  withGradleProperties,
} = require('expo/config-plugins');

// Expo 57 autolinking scans ./modules by default. The local module's
// expo-module.config.json is picked up without editing the application package.json.
module.exports = function withDiwanDownloader(config) {
  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) throw new Error('DiwanDownloader: missing Android application manifest');
    application.$ = application.$ || {};
    application.$['android:extractNativeLibs'] = 'true';
    const permissions = mod.modResults.manifest['uses-permission'] || [];
    if (!permissions.some((permission) => permission.$?.['android:name'] === 'android.permission.INTERNET')) {
      permissions.push({ $: { 'android:name': 'android.permission.INTERNET' } });
    }
    mod.modResults.manifest['uses-permission'] = permissions;
    return mod;
  });

  return withGradleProperties(config, (mod) => {
    // The Expo app template reads this property in its final packagingOptions block.
    // An earlier Gradle DSL injection can be overridden by that later block.
    const key = 'expo.useLegacyPackaging';
    const existing = mod.modResults.filter((item) => item.type === 'property' && item.key === key);
    if (existing.length) {
      existing[0].value = 'true';
      mod.modResults = mod.modResults.filter((item) => item !== existing[0] && !(item.type === 'property' && item.key === key));
      mod.modResults.push(existing[0]);
    } else {
      mod.modResults.push({ type: 'property', key, value: 'true' });
    }
    return mod;
  });
};