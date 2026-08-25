import test from 'node:test';
import assert from 'node:assert/strict';

import { WhatsAppBot } from '../index.js';

function incomingMessage(text, overrides = {}) {
    const { key = {}, ...rest } = overrides;
    return {
        key: {
            remoteJid: '923001234567@s.whatsapp.net',
            fromMe: false,
            ...key
        },
        message: text === null ? {} : { conversation: text },
        ...rest
    };
}

function runningBot(options = {}) {
    const bot = new WhatsAppBot({ rateLimitMs: 0, ...options });
    const socket = { end() {} };
    bot.sock = socket;
    bot._shouldReconnect = true;
    return { bot, socket };
}

test('uses backward-compatible defaults and accepts queue configuration', async () => {
    const defaults = new WhatsAppBot();
    const configured = new WhatsAppBot({ rateLimitMs: 0, maxQueueSize: 0 });

    assert.equal(defaults.rateLimitMs, 200);
    assert.equal(defaults.maxQueueSize, 50);
    assert.equal(configured.rateLimitMs, 0);
    assert.equal(configured.maxQueueSize, 0);

    await defaults.stop();
    await configured.stop();
});

test('processes every message in an upsert batch in sender order', async () => {
    const received = [];
    const { bot, socket } = runningBot({
        onMessage: async ({ messageContent }) => received.push(messageContent)
    });

    await bot._handleMessageUpsert({
        type: 'notify',
        messages: [incomingMessage('first'), incomingMessage('second'), incomingMessage('third')]
    }, socket, bot._lifecycleGeneration);

    assert.deepEqual(received, ['first', 'second', 'third']);
    await bot.stop();
});

test('filters own, unauthorized, and unsupported messages before queuing', async () => {
    const received = [];
    const { bot, socket } = runningBot({
        allowedNumbers: ['923009999999'],
        onMessage: async ({ messageContent }) => received.push(messageContent)
    });

    await bot._handleMessageUpsert({
        type: 'notify',
        messages: [
            incomingMessage('own', { key: { fromMe: true } }),
            incomingMessage('unauthorized'),
            incomingMessage(null)
        ]
    }, socket, bot._lifecycleGeneration);

    assert.deepEqual(received, []);
    assert.equal(bot._messageQueues.size, 0);
    assert.equal(bot.lastMessageTime.size, 0);
    await bot.stop();
});

test('queues bursts instead of dropping messages inside the rate-limit interval', async () => {
    const received = [];
    const { bot, socket } = runningBot({
        rateLimitMs: 10,
        onMessage: async ({ messageContent }) => received.push(messageContent)
    });

    await bot._handleMessageUpsert({
        type: 'notify',
        messages: [incomingMessage('one'), incomingMessage('two'), incomingMessage('three')]
    }, socket, bot._lifecycleGeneration);

    assert.deepEqual(received, ['one', 'two', 'three']);
    await bot.stop();
});

test('bounds each sender queue and drops only overflow', async () => {
    let releaseFirst;
    const firstCanFinish = new Promise((resolve) => { releaseFirst = resolve; });
    const received = [];
    const { bot } = runningBot({ maxQueueSize: 1 });

    const first = bot._enqueueMessage('sender', bot._lifecycleGeneration, async () => {
        received.push('first');
        await firstCanFinish;
    });
    const second = bot._enqueueMessage('sender', bot._lifecycleGeneration, async () => {
        received.push('second');
    });
    const overflow = bot._enqueueMessage('sender', bot._lifecycleGeneration, async () => {
        received.push('overflow');
    });

    assert.equal(await overflow, false);
    releaseFirst();
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.deepEqual(received, ['first', 'second']);
    await bot.stop();
});

test('start is idempotent when a socket exists and stop tears it down', async () => {
    let endCalls = 0;
    const bot = new WhatsAppBot();
    const socket = { end: () => { endCalls++; } };
    bot.sock = socket;
    bot._shouldReconnect = true;

    assert.equal(await bot.start(), socket);
    assert.equal(await bot.start(), socket);

    await bot.stop();

    assert.equal(endCalls, 1);
    assert.equal(bot.sock, null);
    assert.equal(bot._shouldReconnect, false);
    assert.equal(bot._cleanupInterval, null);
});
