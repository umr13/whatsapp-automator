# whatsapp-automator

A simple, hobbyist-friendly WhatsApp automation library built on top of [Baileys](https://github.com/WhiskeySockets/Baileys). Receive and respond to WhatsApp messages programmatically using a clean, event-driven API.

> **Disclaimer:** This library is intended for personal/hobby use only. It is **not** officially affiliated with or endorsed by WhatsApp. Use responsibly and in accordance with WhatsApp's Terms of Service.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [Constructor Options](#constructor-options)
  - [The `onMessage` Callback](#the-onmessage-callback)
  - [`bot.start()`](#botstart)
- [Examples](#examples)
  - [Basic Echo Bot](#basic-echo-bot)
  - [Restricted Numbers (Allowlist)](#restricted-numbers-allowlist)
  - [Sending Text Messages](#sending-text-messages)
  - [Sending Images](#sending-images)
  - [Sending Videos / GIFs](#sending-videos--gifs)
  - [Modular Command Handler](#modular-command-handler)
  - [Group Message Handling](#group-message-handling)
- [First-Run: QR Code Authentication](#first-run-qr-code-authentication)
- [Reconnection & Reliability](#reconnection--reliability)
- [Rate Limiting](#rate-limiting)
- [Known Issues](#known-issues)
- [Project Structure (Recommended)](#project-structure-recommended)
- [Contributors](#contributors)
- [License](#license)

---

## Features

- 📱 **QR code authentication** — scan once, sessions are persisted automatically
- 🔒 **Allowlist filtering** — restrict the bot to specific phone numbers
- ⏱️ **Built-in rate limiting** — 1 message per second per sender, with automatic cleanup
- 🔁 **Auto-reconnect with exponential backoff** — up to 10 attempts, capped at 5 minutes
- 📨 **Group & DM support** — differentiate between group and direct messages
- 🧩 **Minimal, composable API** — bring your own message handler logic

---

## Requirements

- **Node.js** v18 or higher (ESM / `"type": "module"` required)
- A WhatsApp account to authenticate with

---

## Installation

```bash
npm install whatsapp-automator
```

---

## Quick Start

```js
// example.js
import { WhatsAppBot } from 'whatsapp-automator';

const bot = new WhatsAppBot({
    onMessage: async ({ sock, messageContent, senderId, isGroup }) => {
        if (isGroup) return; // ignore group messages

        console.log(`Message from ${senderId}: ${messageContent}`);

        if (messageContent.toLowerCase() === 'ping') {
            await sock.sendMessage(senderId, { text: 'pong 🏓' });
        }
    }
});

bot.start().catch(console.error);
```

Run it:

```bash
node example.js
```

On first run, a QR code will appear in the terminal. Scan it with WhatsApp on your phone (**Settings > Linked Devices > Link a Device**). Your session is then saved in the `auth_info/` folder so you won't need to scan again.

---

## API Reference

### Constructor Options

```js
new WhatsAppBot(options)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `allowedNumbers` | `string[]` | `[]` | Phone numbers (without `+` or country code prefix formatting — just digits, e.g. `'929876543210'`) allowed to interact with the bot. An **empty array allows everyone**. |
| `onMessage` | `async Function` | no-op | Callback invoked for every incoming message that passes the allowlist and rate limiter. |

---

### The `onMessage` Callback

Your `onMessage` handler receives a single object with the following properties:

| Property | Type | Description |
|---|---|---|
| `sock` | `WASocket` | The active Baileys socket. Use this to send messages. |
| `messageContent` | `string` | The plain text content of the received message. |
| `senderId` | `string` | The JID of the chat (e.g. `929876543210@s.whatsapp.net` for DMs, or `<groupid>@g.us` for groups). Use this as the recipient when replying. |
| `isGroup` | `boolean` | `true` if the message was sent in a group chat, `false` for direct messages. |

```js
onMessage: async ({ sock, messageContent, senderId, isGroup }) => {
    // Your logic here
}
```

---

### `bot.start()`

```js
await bot.start()
```

Initializes the WhatsApp connection. Handles QR code display, credential saving, and auto-reconnection internally. Returns the underlying Baileys `sock` object if you need direct access to it.

---

## Examples

### Basic Echo Bot

Replies to every direct message with the same text:

```js
import { WhatsAppBot } from 'whatsapp-automator';

const bot = new WhatsAppBot({
    onMessage: async ({ sock, messageContent, senderId, isGroup }) => {
        if (isGroup) return;
        await sock.sendMessage(senderId, { text: `You said: ${messageContent}` });
    }
});

bot.start().catch(console.error);
```

---

### Restricted Numbers (Allowlist)

Only respond to specific phone numbers:

```js
import { WhatsAppBot } from 'whatsapp-automator';

const bot = new WhatsAppBot({
    allowedNumbers: ['929876543210', '14721123456'], // digits only, no + or spaces
    onMessage: async ({ sock, messageContent, senderId, isGroup }) => {
        if (isGroup) return;
        await sock.sendMessage(senderId, { text: `Hello, trusted user!` });
    }
});

bot.start().catch(console.error);
```

> **Note:** Numbers must be provided as a string of digits matching the full international format **without** the leading `+`. For example, a Pakistani number `+92 98765 43210` should be `'929876543210'`.

---

### Sending Text Messages

```js
await sock.sendMessage(senderId, { text: 'Hello from the bot! 👋' });
```

---

### Sending Images

```js
import fs from 'fs';

await sock.sendMessage(senderId, {
    image: fs.readFileSync('./media/photo.jpg'),
    caption: 'Here is your image!'
});
```

---

### Sending Videos / GIFs

Use `gifPlayback: true` to make a video loop like a GIF:

```js
import fs from 'fs';

await sock.sendMessage(senderId, {
    video: fs.readFileSync('./media/clip.mp4'),
    caption: 'Check this out!',
    gifPlayback: true  // loops the video like a GIF
});
```

---

### Modular Command Handler

For larger projects, split your command logic into a separate file:

**`messageHandler.js`**
```js
export async function handleIncomingMessage(sock, messageContent, senderId) {
    if (!messageContent) return;

    if (messageContent.toLowerCase() === 'ping') {
        await sock.sendMessage(senderId, { text: 'pong 🏓' });
    }

    if (messageContent.toLowerCase() === 'help') {
        await sock.sendMessage(senderId, {
            text: 'Available commands:\n• ping\n• help'
        });
    }
}
```

**`index.js`**
```js
import 'dotenv/config';
import { WhatsAppBot } from 'whatsapp-automator';
import { handleIncomingMessage } from './messageHandler.js';

const allowedNumbers = process.env.ALLOWED_NUMBERS?.split(',') ?? [];

const bot = new WhatsAppBot({
    allowedNumbers,
    onMessage: async ({ sock, messageContent, senderId, isGroup }) => {
        if (isGroup) return;
        await handleIncomingMessage(sock, messageContent, senderId);
    }
});

bot.start().catch(console.error);
```

---

### Group Message Handling

The `isGroup` flag lets you handle group and DM messages differently:

```js
onMessage: async ({ sock, messageContent, senderId, isGroup }) => {
    if (isGroup) {
        // Log group messages but don't reply (to avoid spam)
        console.log(`[Group ${senderId}] ${messageContent}`);
        return;
    }

    // Handle direct messages normally
    await sock.sendMessage(senderId, { text: 'Hello!' });
}
```

---

## First-Run: QR Code Authentication

When you run your bot for the first time (or if your session expires), a QR code will be printed in the terminal:

```
Scan this QR code with WhatsApp:

█████████████████
...
```

1. Open WhatsApp on your phone
2. Go to **Settings → Linked Devices → Link a Device**
3. Scan the QR code

Your credentials are saved in the `auth_info/` folder. **Do not commit this folder to version control** — add it to your `.gitignore`:

```
auth_info/
.env
```

If you get logged out, delete the `auth_info/` folder and re-scan the QR code.

---

## Reconnection & Reliability

The bot handles connection drops automatically with **exponential backoff**:

| Attempt | Delay |
|---|---|
| 1st | 5 seconds |
| 2nd | 10 seconds |
| 3rd | 20 seconds |
| … | … |
| 10th (max) | ~5 minutes (capped) |

After 10 failed attempts, the bot stops trying and logs an error. If another instance of the bot is already connected to the same WhatsApp account, a conflict error (`440`) is detected and the bot will not attempt to reconnect.

---

## Rate Limiting

To prevent flooding, the bot enforces a **1 message per second** limit per sender. Messages arriving faster than this are silently dropped and logged:

```
[WhatsAppBot] Rate limited message from: 929876543210
```

The rate limit map is automatically cleaned up every 60 seconds to prevent memory leaks.

---

## Known Issues

> [!WARNING]
> The following features are known to be unstable or incomplete. Avoid relying on them in production builds.

| Issue | Status |
|---|---|
| **Group chat interaction** | ⚠️ Work in progress — behaviour is unstable. Replying to group messages may fail silently or behave unexpectedly. It is recommended to skip group messages with `if (isGroup) return;` for now. |

---

## Project Structure (Recommended)

```
my-whatsapp-bot/
├── index.js          # Entry point — configures and starts the bot
├── messageHandler.js # Your command/response logic
├── media/            # Images, videos, etc.
├── .env              # Secret config (allowedNumbers, etc.)
├── .gitignore        # Must include auth_info/ and .env
└── auth_info/        # Auto-generated — WhatsApp session credentials
```

---

## Contributors

| Avatar | Name | GitHub |
|---|---|---|
| <img src="https://github.com/umr13.png" width="48" height="48" style="border-radius:50%" /> | **Umar I.** | [@umr13](https://github.com/umr13) |

Contributions, issues and feature requests are welcome! Feel free to open a [GitHub issue](https://github.com/umr13/whatsapp-automator/issues).

---

## License

MIT © [Umar I.](https://github.com/umr13)

This project is intended for **personal and hobbyist use only**. Not officially affiliated with WhatsApp Inc.
