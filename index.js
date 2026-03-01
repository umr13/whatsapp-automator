import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

export class WhatsAppBot {
    /**
     * @param {Object} options
     * @param {string[]} options.allowedNumbers - Array of phone numbers allowed to trigger the bot (e.g. ['9XXXXXXXXXX'])
     * @param {Function} options.onMessage - Async callback for incoming messages
     */
    constructor(options = {}) {

        this.authFolder = 'auth_info';        
        this.allowedNumbers = Array.isArray(options.allowedNumbers) ? options.allowedNumbers : [];
        this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : (async () => {});
        this.sock = null;

        // Reconnect state: tracks attempts for exponential backoff
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 10;

        // Rate limit map to track the last message timestamp per user
        this.lastMessageTime = new Map();

        // Clean up old entries from the rate limit map periodically to prevent memory leaks
        setInterval(() => {
            const now = Date.now();
            for (const [key, timestamp] of this.lastMessageTime.entries()) {
                // Evict entries older than 1 minute — well beyond the 1 msg/sec rate limit window.
                if (now - timestamp > 60 * 1000) {
                    this.lastMessageTime.delete(key);
                }
            }
        }, 60 * 1000).unref(); // Run every 1 minute, unref to allow process exit

    }

    async start() {
        // Save authentication state in the specified directory
        const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
        
        // Fetch the latest version of WhatsApp Web
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[WhatsAppBot] Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        this.sock = makeWASocket({
            version,
            // To completely silence Baileys internal logs (like SessionEntry), we need to set the logger's level to 'silent'
            // and potentially also disable the underlying stream if pino still outputs anything.
            logger: pino({ level: 'silent'}),
            printQRInTerminal: false,
            auth: state,
        });

        // Save auth credentials whenever they update
        this.sock.ev.on('creds.update', saveCreds);

        // Listen to connection updates
        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // Show QR code in terminal
            if (qr) {
                console.log('\nScan this QR code with WhatsApp:\n');
                qrcode.generate(qr, { small: true });
            }

            // Handle connection close
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(`[WhatsAppBot] You are logged out. Please delete the ${this.authFolder} folder and scan the new QR code.`);
                } else if (statusCode === 440) {
                    // 440 means "Conflict" or "Connection Replaced"
                    console.log('[WhatsAppBot] Connection Conflict! Another instance of this bot is already running. Please kill all other node processes before starting.');
                } else {
                    this._reconnectAttempts++;
                    if (this._reconnectAttempts > this._maxReconnectAttempts) {
                        console.error(`[WhatsAppBot] Max reconnection attempts (${this._maxReconnectAttempts}) reached. Giving up.`);
                        return;
                    }
                    // Exponential backoff: 5s, 10s, 20s ... capped at 5 minutes
                    const delay = Math.min(5000 * Math.pow(2, this._reconnectAttempts - 1), 5 * 60 * 1000);
                    console.log(`[WhatsAppBot] Connection closed due to`, lastDisconnect?.error, `. Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})...`);
                    setTimeout(() => this.start().catch(err => console.error("Reconnect failed:", err)), delay);
                }
            } else if (connection === 'open') {
                this._reconnectAttempts = 0; // Reset backoff counter on successful connection
                console.log('[WhatsAppBot] Successfully connected to WhatsApp!');
            }
        });

        // Listen for new messages
        this.sock.ev.on('messages.upsert', async (m) => {
            if (!m.messages || m.messages.length === 0) return;
            const msg = m.messages[0];
            if (!msg?.key) return;
            


            if (m.type === 'notify') {
                const remoteJid = msg.key.remoteJid || '';
                
                // Handle group vs direct messages correctly
                const isGroup = remoteJid.endsWith('@g.us');
                const participant = isGroup ? (msg.key.participant || '') : remoteJid;
                
                if (!participant) return;

                // Extract raw number by removing the "@s.whatsapp.net" or other suffix
                const senderNumber = participant.split('@')[0];
                const altSenderNumber = msg.key.remoteJidAlt ? msg.key.remoteJidAlt.split('@')[0] : '';
                
                // WhatsApp now sometimes sends messages from an internal "@lid" (Local ID) instead of the actual phone number.
                // If the primary JID is a lid, the actual phone number is usually tucked into remoteJidAlt.
                // We want to prioritize sending replies to the actual phone number.
                let mainSenderKey = senderNumber;
                if (participant.includes('@lid') && altSenderNumber) {
                    mainSenderKey = altSenderNumber;
                } else if (mainSenderKey.length === 0 && altSenderNumber) {
                     mainSenderKey = altSenderNumber;
                }

                // Rate Limiting (1 message per second per user)
                const now = Date.now();
                const lastTime = this.lastMessageTime.get(mainSenderKey) || 0;
                if (now - lastTime < 1000) {
                    console.log(`[WhatsAppBot] Rate limited message from: ${mainSenderKey}`);
                    return;
                }
                this.lastMessageTime.set(mainSenderKey, now);

                // If allowedNumbers is empty, we allow everyone. Otherwise, we filter.
                // Use mainSenderKey (the resolved canonical number) to stay consistent with the rate limiter.
                const isAllowed = this.allowedNumbers.length === 0 || 
                                  this.allowedNumbers.includes(mainSenderKey);

                if (isAllowed) {
                    const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
                    
                    if (messageContent) {
                        // Pass the logic to the consumer's external handler
                        try {
                            await this.onMessage({
                                sock: this.sock,
                                messageContent,
                                senderId: remoteJid,
                                isGroup
                            });
                        } catch (error) {
                            console.error('[WhatsAppBot] Error executing onMessage handler:', error);
                        }
                    }
                } else {
                    console.log(`[WhatsAppBot] Ignored message from unauthorized number: ${senderNumber} / ${altSenderNumber}`);
                }
            }
        });

        return this.sock;
    }
}
