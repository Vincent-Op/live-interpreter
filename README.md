# LiveInterpreter

Personal iPhone app for live Mandarin ↔ English conversations (Taiwan). Push-to-talk: tap **Them (中文)** and hear English in your AirPods; tap **Me (English)** and the phone speaker plays Mandarin. Uses OpenAI `gpt-realtime-translate`.

- `app/`: Expo (React Native + TypeScript) app with expo-dev-client
- `spike/`: Node scripts used to test the translation API from Windows
- `.github/workflows/ios.yml`: builds an unsigned dev-client `.ipa` on a macOS runner; install it with Sideloadly

No secrets are stored in this repo. The OpenAI key is entered in the app and kept in the iOS Keychain.
