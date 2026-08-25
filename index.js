import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

export class WhatsAppBot {
    /**
     * @param {Object} options
     * @param {string[]} options.allowedNumbers - Array of phone numbers allowed to trigger the bot (e.g. ['9XXXXXXXXXX'])
     * @param {Function} options.onMessage - Async callback for incoming messages
     * @param {number} options.rateLimitMs - Minimum delay between messages from the same sender. Set to 0 to disable (default: 200)
     * @param {number} options.maxQueueSize - Maximum number of waiting messages per sender (default: 50)
     */
    constructor(options = {}) {

        this.authFolder = 'auth_info';        
        this.allowedNumbers = Array.isArray(options.allowedNumbers) ? options.allowedNumbers : [];
        this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : (async () => {});
        this.rateLimitMs = Number.isFinite(options.rateLimitMs) && options.rateLimitMs >= 0
            ? options.rateLimitMs
            : 200;
        this.maxQueueSize = Number.isInteger(options.maxQueueSize) && options.maxQueueSize >= 0
            ? options.maxQueueSize
            : 50;
        this.sock = null;

        // Reconnect state: tracks attempts for exponential backoff
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 10;

        // Rate limit map to track the last message timestamp per user
        this.lastMessageTime = new Map();
        this._messageQueues = new Map();
        this._delayTimers = new Set();

        // Lifecycle state
        this._startPromise = null;
        this._reconnectTimer = null;
        this._cleanupInterval = null;
        this._shouldReconnect = false;
        this._lifecycleGeneration = 0;

        // Clean up old entries from the rate limit map periodically to prevent memory leaks
        this._startCleanupInterval();

    }

    _startCleanupInterval() {
        if (this._cleanupInterval) return;

        this._cleanupInterval = setInterval(() => {
            const now = Date.now();
            const staleAfterMs = Math.max(60 * 1000, this.rateLimitMs);
            for (const [key, timestamp] of this.lastMessageTime.entries()) {
                // Keep entries for at least the configured cooldown so long limits remain effective.
                if (now - timestamp > staleAfterMs) {
                    this.lastMessageTime.delete(key);
                }
            }
        }, 60 * 1000).unref(); // Run every 1 minute, unref to allow process exit
    }

    _clearReconnectTimer() {
        if (!this._reconnectTimer) return;

        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
    }

    async start() {
        if (this.sock) return this.sock;
        if (this._startPromise) return this._startPromise;

        this._shouldReconnect = true;
        this._reconnectAttempts = 0;
        this._clearReconnectTimer();
        this._startCleanupInterval();

        return this._beginConnection();
    }

    async _beginConnection() {
        if (this.sock) return this.sock;
        if (this._startPromise) return this._startPromise;

        const generation = this._lifecycleGeneration;
        const startPromise = this._connect(generation);
        this._startPromise = startPromise;

        try {
            return await startPromise;
        } finally {
            if (this._startPromise === startPromise) {
                this._startPromise = null;
            }
        }
    }

    async _connect(generation) {
        // Save authentication state in the specified directory
        const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);

        if (!this._shouldReconnect || generation !== this._lifecycleGeneration) return null;
        
        // Fetch the latest version of WhatsApp Web
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[WhatsAppBot] Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        if (!this._shouldReconnect || generation !== this._lifecycleGeneration) return null;

        const socket = makeWASocket({
            version,
            // To completely silence Baileys internal logs (like SessionEntry), we need to set the logger's level to 'silent'
            // and potentially also disable the underlying stream if pino still outputs anything.
            logger: pino({ level: 'silent'}),
            printQRInTerminal: false,
            auth: state,
        });
        this.sock = socket;

        // Save auth credentials whenever they update
        socket.ev.on('creds.update', saveCreds);

        // Listen to connection updates
        socket.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // Show QR code in terminal
            if (qr) {
                console.log('\nScan this QR code with WhatsApp:\n');
                qrcode.generate(qr, { small: true });
            }

            // Handle connection close
            if (connection === 'close') {
                const isCurrentSocket = this.sock === socket;
                if (isCurrentSocket) this.sock = null;

                // Ignore close events from replaced sockets and intentional shutdowns.
                if (!isCurrentSocket || !this._shouldReconnect || generation !== this._lifecycleGeneration) {
                    return;
                }

                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    this._shouldReconnect = false;
                    console.log(`[WhatsAppBot] You are logged out. Please delete the ${this.authFolder} folder and scan the new QR code.`);
                } else if (statusCode === 440) {
                    // 440 means "Conflict" or "Connection Replaced"
                    this._shouldReconnect = false;
                    console.log('[WhatsAppBot] Connection Conflict! Another instance of this bot is already running. Please kill all other node processes before starting.');
                } else {
                    this._reconnectAttempts++;
                    if (this._reconnectAttempts > this._maxReconnectAttempts) {
                        this._shouldReconnect = false;
                        console.error(`[WhatsAppBot] Max reconnection attempts (${this._maxReconnectAttempts}) reached. Giving up.`);
                        return;
                    }
                    // Exponential backoff: 5s, 10s, 20s ... capped at 5 minutes
                    const delay = Math.min(5000 * Math.pow(2, this._reconnectAttempts - 1), 5 * 60 * 1000);
                    console.log(`[WhatsAppBot] Connection closed due to`, lastDisconnect?.error, `. Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})...`);
                    this._scheduleReconnect(delay, generation);
                }
            } else if (connection === 'open') {
                this._reconnectAttempts = 0; // Reset backoff counter on successful connection
                console.log('[WhatsAppBot] Successfully connected to WhatsApp!');
            }
        });

        // Listen for new messages
        socket.ev.on('messages.upsert', (m) => this._handleMessageUpsert(m, socket, generation));

        return socket;
    }

    async _handleMessageUpsert(event, socket, generation) {
        if (event.type !== 'notify' || !Array.isArray(event.messages)) return;

        await Promise.allSettled(
            event.messages.map((msg) => this._handleIncomingMessage(msg, socket, generation))
        );
    }

    async _handleIncomingMessage(msg, socket, generation) {
        if (socket !== this.sock || generation !== this._lifecycleGeneration) return;
        if (!msg?.key || msg.key.fromMe) return;

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
        let mainSenderKey = senderNumber;
        if (participant.includes('@lid') && altSenderNumber) {
            mainSenderKey = altSenderNumber;
        } else if (mainSenderKey.length === 0 && altSenderNumber) {
            mainSenderKey = altSenderNumber;
        }

        // Filter unsupported and unauthorized messages before they consume queue capacity.
        const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
        if (!messageContent) return;

        const isAllowed = this.allowedNumbers.length === 0 || this.allowedNumbers.includes(mainSenderKey);
        if (!isAllowed) {
            console.log(`[WhatsAppBot] Ignored message from unauthorized number: ${senderNumber} / ${altSenderNumber}`);
            return;
        }

        await this._enqueueMessage(mainSenderKey, generation, async () => {
            try {
                await this.onMessage({
                    sock: socket,
                    messageContent,
                    senderId: remoteJid,
                    isGroup
                });
            } catch (error) {
                console.error('[WhatsAppBot] Error executing onMessage handler:', error);
            }
        });
    }

    _enqueueMessage(senderKey, generation, handler) {
        return new Promise((resolve) => {
            let queue = this._messageQueues.get(senderKey);
            if (!queue) {
                queue = { items: [], processing: false };
                this._messageQueues.set(senderKey, queue);
            }

            // maxQueueSize counts waiting messages; the currently running one is not included.
            if (queue.processing && queue.items.length >= this.maxQueueSize) {
                console.warn(`[WhatsAppBot] Message queue full for: ${senderKey}`);
                resolve(false);
                return;
            }

            queue.items.push({ generation, handler, resolve });
            void this._drainMessageQueue(senderKey, queue);
        });
    }

    async _drainMessageQueue(senderKey, queue) {
        if (queue.processing) return;
        queue.processing = true;

        try {
            while (queue.items.length > 0) {
                const item = queue.items.shift();
                if (!this._shouldReconnect || item.generation !== this._lifecycleGeneration) {
                    item.resolve(false);
                    continue;
                }

                const elapsed = Date.now() - (this.lastMessageTime.get(senderKey) || 0);
                const delay = Math.max(0, this.rateLimitMs - elapsed);
                if (delay > 0) await this._delay(delay);

                if (!this._shouldReconnect || item.generation !== this._lifecycleGeneration) {
                    item.resolve(false);
                    continue;
                }

                this.lastMessageTime.set(senderKey, Date.now());
                await item.handler();
                item.resolve(true);
            }
        } finally {
            queue.processing = false;
            if (queue.items.length === 0 && this._messageQueues.get(senderKey) === queue) {
                this._messageQueues.delete(senderKey);
            }
        }
    }

    _delay(ms) {
        return new Promise((resolve) => {
            const entry = { timer: null, resolve };
            entry.timer = setTimeout(() => {
                this._delayTimers.delete(entry);
                resolve();
            }, ms);
            this._delayTimers.add(entry);
        });
    }

    _scheduleReconnect(delay, generation) {
        this._clearReconnectTimer();
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (!this._shouldReconnect || generation !== this._lifecycleGeneration) return;

            this._beginConnection().catch((error) => {
                console.error('[WhatsAppBot] Reconnect failed:', error);
                if (this._shouldReconnect && generation === this._lifecycleGeneration) {
                    this._reconnectAttempts++;
                    if (this._reconnectAttempts <= this._maxReconnectAttempts) {
                        const retryDelay = Math.min(5000 * Math.pow(2, this._reconnectAttempts - 1), 5 * 60 * 1000);
                        this._scheduleReconnect(retryDelay, generation);
                    } else {
                        this._shouldReconnect = false;
                        console.error(`[WhatsAppBot] Max reconnection attempts (${this._maxReconnectAttempts}) reached. Giving up.`);
                    }
                }
            });
        }, delay);
        this._reconnectTimer.unref?.();
    }

    async stop() {
        this._shouldReconnect = false;
        this._lifecycleGeneration++;
        this._clearReconnectTimer();

        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }

        for (const entry of this._delayTimers) {
            clearTimeout(entry.timer);
            entry.resolve();
        }
        this._delayTimers.clear();

        for (const queue of this._messageQueues.values()) {
            for (const item of queue.items) item.resolve(false);
            queue.items.length = 0;
        }
        this._messageQueues.clear();
        this.lastMessageTime.clear();

        const socket = this.sock;
        this.sock = null;
        this._startPromise = null;

        if (socket?.end) {
            try {
                socket.end(new Error('WhatsAppBot stopped'));
            } catch (error) {
                console.error('[WhatsAppBot] Error stopping socket:', error);
            }
        }
    }
}
