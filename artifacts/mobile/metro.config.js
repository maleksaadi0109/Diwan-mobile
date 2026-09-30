const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Metro watches the monorepo root for workspace dependencies. Ignore temporary
// build directories to avoid filesystem watcher races.
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : config.resolver.blockList
      ? [config.resolver.blockList]
      : []),
  /[/\\]target[/\\]/,
];

module.exports = config;
