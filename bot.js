/**
 * ══════════════════════════════════════════════════════════════════════════
 *  QUOTEX 24/7 CLOUD PAYOUT ALERT TELEGRAM BOT
 *  Author: Google Deepmind Antigravity Pair Programmer
 *  User: SHAHRIYAR RAHMAN (@TradeWithShahriyar)
 * ══════════════════════════════════════════════════════════════════════════
 */

const express = require('express');   
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const axios = require('axios');

// ── CONFIGURATION ──────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8823259914:AAH35JLjMeGbBZZcTbykp2Re_Ck5lecb6-M';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '6162849289';
const PORT      = process.env.PORT || 3000;

let currentThreshold = 95;
let isMonitoring = true;
let lastAlerted = {};
const DEBOUNCE_MS = 60 * 1000; // 1 min debounce

// Initialize Telegram Bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ── HTTP HEALTH SERVER (Required for 24/7 Render / Cloud Hosting) ─────────
const app = express();
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Quotex 24/7 Alert Bot</title></head>
      <body style="font-family:sans-serif;background:#0d1117;color:#fff;padding:40px;text-align:center;">
        <h1 style="color:#00d4ff;">Quotex 24/7 Cloud Alert Bot is ACTIVE!</h1>
        <p>Monitoring Quotex payouts for <b>${currentThreshold}%+</b> threshold.</p>
        <p>Notifications are being delivered directly to Telegram Chat ID: <code>${CHAT_ID}</code></p>
        <p style="color:#22c55e;">Status: 24/7 Live Monitoring Running</p>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`[HTTP Server] Health check server running on port ${PORT}`);
});

// ── SEND TELEGRAM MESSAGE HELPER ───────────────────────────────────────────
async function sendTelegram(text) {
  try {
    await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[Telegram Error]', err.message);
  }
}

// ── NOTIFICATION HANDLER ───────────────────────────────────────────────────
function handlePayoutAlert(pair, payout) {
  const now = Date.now();
  if (lastAlerted[pair] && (now - lastAlerted[pair]) < DEBOUNCE_MS) return;
  lastAlerted[pair] = now;

  const msg = `🚨 *QUOTEX ${payout}% PAYOUT ALERT!* 🚨\n\n` +
              `📊 *Pair:* \`${pair}\`\n` +
              `💰 *Payout:* *${payout}%*\n` +
              `⏰ *Time:* ${new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka' })}\n\n` +
              `🚀 *Market reaches your target! Trade now on Quotex!*`;

  console.log(`[ALERT] Fired alert for ${pair} (${payout}%)`);
  sendTelegram(msg);
}

// ── QUOTEX LIVE DATA ENGINE ────────────────────────────────────────────────
const QUOTEX_SOCKET_URLS = [
  'wss://ws2.market-qx.trade/socket.io/?EIO=3&transport=websocket',
  'wss://ws.qxbroker.com/socket.io/?EIO=3&transport=websocket',
  'wss://ws.quotex.com/socket.io/?EIO=3&transport=websocket'
];

let activeWsIndex = 0;
let ws = null;
let currentPairs = {};

function connectWebSocket() {
  const url = QUOTEX_SOCKET_URLS[activeWsIndex];
  console.log(`[WebSocket] Connecting to ${url}...`);

  try {
    ws = new WebSocket(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Origin': 'https://market-qx.info'
      }
    });

    ws.on('open', () => {
      console.log('[WebSocket] Connected successfully to Quotex live stream!');
      // Send initial handshake / ping
      ws.send('40');
    });

    ws.on('message', (data) => {
      const msg = data.toString();

      // Keepalive ping/pong
      if (msg === '2') {
        ws.send('3'); // pong
        return;
      }

      // Parse payout updates
      parseQuotexMessage(msg);
    });

    ws.on('close', () => {
      console.warn('[WebSocket] Connection closed. Reconnecting in 5s...');
      activeWsIndex = (activeWsIndex + 1) % QUOTEX_SOCKET_URLS.length;
      setTimeout(connectWebSocket, 5000);
    });

    ws.on('error', (err) => {
      console.error('[WebSocket Error]', err.message);
      ws.close();
    });

  } catch (err) {
    console.error('[WebSocket Exception]', err.message);
    setTimeout(connectWebSocket, 5000);
  }
}

function parseQuotexMessage(rawMsg) {
  try {
    // Quotex socket.io messages often come prefixed with 42["live_rates", {...}] or similar
    if (!rawMsg.startsWith('42')) return;
    const jsonStr = rawMsg.slice(2);
    const parsed = JSON.parse(jsonStr);

    if (Array.isArray(parsed) && parsed.length >= 2) {
      const event = parsed[0];
      const payload = parsed[1];

      // Handle payout / instrument rates
      if (event === 'live_rates' || event === 'instruments' || event === 'payout_rates') {
        processInstruments(payload);
      }
    }
  } catch (e) {
    // Not JSON or partial chunk
  }
}

function processInstruments(data) {
  if (!data) return;
  // If array of assets or dict
  const items = Array.isArray(data) ? data : Object.values(data);
  for (const item of items) {
    if (!item) continue;
    const name = item.name || item.symbol || item.pair;
    const payout = item.payout || item.profit || item.rate;

    if (name && payout && payout >= 50 && payout <= 95) {
      currentPairs[name] = payout;
      if (isMonitoring && payout >= currentThreshold) {
        handlePayoutAlert(name, payout);
      }
    }
  }
}

// ── FALLBACK BACKUP SCRAPER ────────────────────────────────────────────────
// Periodically fetches from Quotex mirror public API endpoints
async function fallbackPoll() {
  try {
    const res = await axios.get('https://market-qx.info/api/v1/instruments/payouts', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 8000
    });
    if (res.data && res.data.data) {
      processInstruments(res.data.data);
    }
  } catch (e) {
    // fallback poll silent
  }
}
setInterval(fallbackPoll, 10000);

// Start connection
connectWebSocket();

// ── TELEGRAM INTERACTIVE COMMANDS ──────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const welcome = `👋 *Welcome Shahriyar bhai!*\n\n` +
                  `🤖 *Quotex 24/7 Cloud Alert Bot is ACTIVE!*\n\n` +
                  `📌 *Current Settings:*\n` +
                  `• Threshold: *${currentThreshold}%*\n` +
                  `• Status: *${isMonitoring ? '🟢 Running 24/7' : '🔴 Stopped'}*\n\n` +
                  `⚙️ *Available Commands:*\n` +
                  `• \`/threshold <number>\` - টার্গেট পরিবর্তন করুন (যেমন: \`/threshold 93\`)\n` +
                  `• \`/status\` - বর্তমান স্ট্যাটাস চেক করুন\n` +
                  `• \`/pairs\` - লাইভ মার্কেট পেয়ার ও পেআউট দেখুন\n` +
                  `• \`/test\` - টেস্ট নোটিফিকেশন চেক করুন`;
  bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'Markdown' });
});

bot.onText(/\/threshold\s*(\d+)/, (msg, match) => {
  const newThreshold = parseInt(match[1]);
  if (newThreshold >= 50 && newThreshold <= 95) {
    currentThreshold = newThreshold;
    bot.sendMessage(msg.chat.id, `✅ *Threshold updated!* এখন থেকে *${currentThreshold}%* বা তার বেশি পেআউট হলে নোটিফিকেশন আসবে।`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(msg.chat.id, `⚠️ অনুগ্রহ করে ৫০ থেকে ৯৫ এর মধ্যে সংখ্যা লিখুন (যেমন: \`/threshold 93\`)`, { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/status/, (msg) => {
  const statusMsg = `📊 *Bot Status Report:*\n\n` +
                    `• 24/7 Cloud Engine: *🟢 Active*\n` +
                    `• Target Threshold: *${currentThreshold}%*\n` +
                    `• Monitoring: *${isMonitoring ? 'Enabled' : 'Disabled'}*\n` +
                    `• Pairs Tracked: *${Object.keys(currentPairs).length} pairs*`;
  bot.sendMessage(msg.chat.id, statusMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/test/, (msg) => {
  handlePayoutAlert('USD/PKR (OTC)', 95);
});

bot.onText(/\/pairs/, (msg) => {
  const sorted = Object.entries(currentPairs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (sorted.length === 0) {
    bot.sendMessage(msg.chat.id, `⏳ ডেটা রিড করা হচ্ছে... কিছুক্ষণ পর আবার চেক করুন।`);
    return;
  }

  let text = `📈 *Top Market Payouts Right Now:*\n\n`;
  sorted.forEach(([name, payout], i) => {
    const icon = payout >= currentThreshold ? '🔥' : '⚡';
    text += `${i + 1}. \`${name}\` ➔ *${payout}%* ${icon}\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

console.log('[Bot] Quotex 24/7 Cloud Alert Bot started successfully ✓');
