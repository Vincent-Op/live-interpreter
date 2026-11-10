import type { ConfigContext, ExpoConfig } from 'expo/config';

// Two installable variants from one codebase:
//   APP_VARIANT=dev -> "Interp Dev": development build that loads JS from Metro on the PC
//   (default)       -> "LiveInterpreter": standalone release build with the JS inside the app
// Different bundle IDs and URL schemes, so both can be installed side by side.
export default ({ config }: ConfigContext): ExpoConfig => {
  const dev = process.env.APP_VARIANT === 'dev';
  return {
    ...config,
    name: dev ? 'Interp Dev' : 'LiveInterpreter',
    slug: dev ? 'live-interpreter-dev' : 'live-interpreter',
    scheme: dev ? 'liveinterpreter-dev' : 'liveinterpreter',
    ios: {
      ...config.ios,
      bundleIdentifier: dev ? 'com.vincentop.liveinterpreter.dev' : 'com.vincentop.liveinterpreter',
    },
  };
};
