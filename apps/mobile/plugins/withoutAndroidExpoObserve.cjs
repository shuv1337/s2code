const { withSettingsGradle } = require("expo/config-plugins");

const ANCHOR = "expoAutolinking.useExpoModules()";
const EXCLUDE = 'expoAutolinking.exclude = ["expo-observe"]';

// expo-observe's Android module requires extra.eas.projectId when it is created, before JS runs.
module.exports = function withoutAndroidExpoObserve(config) {
  return withSettingsGradle(config, (nextConfig) => {
    const contents = nextConfig.modResults.contents;
    if (contents.includes(EXCLUDE)) return nextConfig;
    if (!contents.includes(ANCHOR))
      throw new Error(`withoutAndroidExpoObserve: settings.gradle is missing ${ANCHOR}.`);
    nextConfig.modResults.contents = contents.replace(ANCHOR, `${EXCLUDE}\n${ANCHOR}`);
    return nextConfig;
  });
};
