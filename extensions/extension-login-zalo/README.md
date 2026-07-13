# Markee Zalo Personal Connector

Chrome extension used by Markee Chat to connect a personal Zalo Web session to the Zalo bridge service.

## Purpose

Zalo personal accounts do not provide the same official webhook flow as Zalo OA. This extension lets the account owner sign in to `chat.zalo.me` in their own browser, then sends the required session payload to the configured Markee Zalo bridge.

## Local Install

1. Open Chrome and go to `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this folder: `extension-login-zalo`.
5. Open Markee Chat and start the `Zalo ca nhan` connection flow.

## Runtime Flow

1. User opens the Zalo personal connector page in Markee Chat.
2. The extension opens or reuses `chat.zalo.me`.
3. User signs in with QR if needed.
4. The extension sends the Zalo Web session to the bridge.
5. The bridge listens for Zalo messages and syncs them into the selected Chatwoot inbox.

## Security Notes

- Do not commit real Zalo cookies or exported browser sessions.
- Keep the bridge protected with `BRIDGE_API_KEY`.
- Keep host permissions limited to Zalo, local development, and Markee domains.
