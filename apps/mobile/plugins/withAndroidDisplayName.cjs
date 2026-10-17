"use strict";

const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function withAndroidDisplayName(config) {
  return withAndroidManifest(config, (nextConfig) => {
    const application = nextConfig.modResults.manifest.application?.[0];
    if (!application) throw new Error("Android application manifest entry is missing.");
    application.$["android:label"] = config.extra?.displayName ?? config.name;
    return nextConfig;
  });
};
