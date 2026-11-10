// ============================================================================
// ENCLAVE ARCADE - COMPLETE NODE.JS SERVER (Render / Zero-Dependency)
// ============================================================================

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = process.env.PORT || 8080;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || '';

let globalWordPool = [
  'anchor', 'compass', 'lantern', 'fortress', 'eclipse',
  'glacier', 'phantom', 'harbor', 'catapult', 'obsidian'
];

// ============================================================================
// 1. GOOGLE SHEETS INTEGRATION
// ============================================================================
async function syncDictionaryFromGoogleSheet(difficulty = 'ALL') {
  if (!GOOGLE_SCRIPT_URL.startsWith('http')) return;
  try {
    const url = `${GOOGLE_SCRIPT_URL}?action=words&count=250&difficulty=${encodeURIComponent(difficulty)}`;
    const res = await fetch(url, { redirect: 'follow' });
    const data = await res.json();
    if (data.ok && Array.isArray(data.words) && data.words.length > 0) {
      globalWordPool = data.words;
      console.log(`[Google Sheet] Synced ${globalWordPool.length} words`);
    }
  } catch (err) {
    console.error('[Google Sheet] Sync skipped:', err.message);
  }
}

async function pushScoresToGoogleSheet(players) {
  if (!GOOGLE_SCRIPT_URL.startsWith('http') || players.length === 0) return;
  try {
    const topScore = Math.max(...players.map(p => p.score || 0));
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'recordScores',
        players: players.map(p => ({
          discordId: p.discordId,
          nickname: p.nickname,
          avatarUrl: p.avatarUrl,
          scoreDelta: p.score || 0,
          won: (p.score || 0) === topScore && topScore > 0
        }))
      }),
      redirect: 'follow'
    });
  } catch (err) {
    console.error('[Google Sheet] Score save error:', err.message);
  }
}

// ============================================================================
// 2. DISCORD SLASH COMMAND REGISTRATION
// ============================================================================
async function registerDiscordSlashCommands() {
  if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID) return;
  try {
    const url = `https://discord.com/api/v10/applications/${DISCORD_CLIENT_ID}/commands`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([
        {
          name: 'arcade',
          description: 'Launch Enclave Arcade (Skribbl, Gartic, Hangman & Snake)',
          options: [
            {
              name: 'mode',
              description: 'Choose initial game mode',
              type: 3,
              required: false,
              choices: [
                { name: 'Skribbl Classic', value: 'skribbl' },
                { name: 'Gartic Chain', value: 'gartic' },
                { name: 'Team Hangman', value: 'hangman' },
                { name: 'Live Snake.io', value: 'snake' }
              ]
            }
          ]
        }
      ])
    });
    if (res.ok) {
      console.log('[Discord Bot] /arcade slash command registered successfully!');
    }
  } catch (err) {
    console.error('[Discord Bot] Command registration error:', err.message);
  }
}

// ============================================================================
// 3. HTTP SERVER (OAuth2 Token Exchange & Discord Bot Interactions Endpoint)
// ============================================================================
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Handle Discord Slash Command Interactions Endpoint
  if (req.method === 'POST' && req.url === '/interactions') {
    let rawBody = '';
    req.on('data', chunk => { rawBody += chunk; });
    req.on('end', () => {
      try {
        const interaction = JSON.parse(rawBody || '{}');

        // PING verification
        if (interaction.type === 1) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ type: 1 }));
        }

        // /arcade command execution
        if (interaction.type === 2 && interaction.data.name === 'arcade') {
          const selectedMode = interaction.data.options?.[0]?.value || 'skribbl';
          const frontendUrl = `https://your-github-username.github.io/enclave-arcade/?mode=${selectedMode}`;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            type: 4,
            data: {
              content: `🎮 **Enclave Arcade** lobby created! Click below to join the game:`,
              components: [
                {
                  type: 1,
                  components: [
                    {
                      type: 2,
                      style: 5,
                      label: 'Launch Enclave Arcade',
                      url: frontendUrl
                    }
                  ]
                }
              ]
            }
          }));
        }

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown interaction' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Handle OAuth2 Token & Server Nickname Exchange
  if (req.method === 'POST' && (req.url === '/api/token' || req.url === '/.proxy/api/token')) {
    let rawBody = '';
    req.on('data', chunk => { rawBody += chunk; });
    req.on('end', async () => {
      try {
        const { code, guildId } = JSON.parse(rawBody || '{}');

        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: DISCORD_CLIENT_ID,
            client_secret: DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code
          })
        });
        const tokenData = await tokenRes.json();
        const authHeader = { Authorization: `Bearer ${tokenData.access_token}` };

        const userRes = await fetch('https://discord.com/api/v10/users/@me', { headers: authHeader });
        const user = await userRes.json();

        let member = null;
        if (guildId) {
          const memberRes = await fetch(
            `https://discord.com/api/v10/users/@me/guilds/${guildId}/member`,
            { headers: authHeader }
          );
          if (memberRes.ok) member = await memberRes.json();
        }

        let avatarUrl = 'https://cdn.discordapp.com/embed/avatars/0.png';
        if (member?.avatar && guildId) {
          avatarUrl = `https://cdn.discordapp.com/guilds/${guildId}/users/${user.id}/avatars/${member.avatar}.png?size=128`;
        } else if (user?.avatar) {
          avatarUrl = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: tokenData.access_token, user, member, avatarUrl }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Enclave Arcade Node Server Active');
});

// ============================================================================
// 4. WEBSOCKET ENGINE (Real-Time Drawing, Gartic, Hangman & Snake.io)
// ============================================================================
function sendWsFrame(socket, obj) {
  if (socket.destroyed || !socket.writable) return;
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function decodeWsFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    if (opcode === 0x08) return { close: true, messages, remaining: Buffer.alloc(0) };

    const isMasked = (buffer[offset + 1] & 0x80) !== 0;
    let payloadLen = buffer[offset + 1] & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }

    const maskOffset = headerLen;
    const dataOffset = headerLen + (isMasked ? 4 : 0);
    if (offset + dataOffset + payloadLen > buffer.length) break;

    const payload = Buffer.alloc(payloadLen);
    if (isMasked) {
      const mask = buffer.subarray(offset + maskOffset, offset + dataOffset);
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = buffer[offset + dataOffset + i] ^ mask[i % 4];
      }
    } else {
      buffer.copy(payload, 0, offset + dataOffset, offset + dataOffset + payloadLen);
    }

    if (opcode === 0x01) {
      messages.push(payload.toString('utf8'));
    }
    offset += dataOffset + payloadLen;
  }

  return { close: false, messages, remaining: buffer.subarray(offset) };
}

const rooms = new Map();

function getOrCreateRoom(instanceId) {
  if (!rooms.has(instanceId)) {
    rooms.set(instanceId, {
      instanceId,
      mode: 'skribbl',
      players: new Map(),
      settings: { drawTime: 80, rounds: 3, hangmanMaxGuesses: 10, difficulty: 'ALL' },
      round: 1,
      currentWord: '',
      hangmanLeft: 10,
      guessedIds: new Set(),
      garticChain: [],
      snakeInterval: null,
      snakes: new Map(),
      orbs: []
    });
  }
  return rooms.get(instanceId);
}

function broadcast(room, packet, excludeSocket = null) {
  for (const [sock] of room.players.entries()) {
    if (sock !== excludeSocket) sendWsFrame(sock, packet);
  }
}

function broadcastRoster(room) {
  const players = Array.from(room.players.values()).map(p => ({
    discordId: p.discordId,
    nickname: p.nickname,
    avatarUrl: p.avatarUrl,
    score: p.score || 0,
    team: p.team || 'A'
  }));
  broadcast(room, { type: 'roster', players });
}

function maskWord(word) {
  return word.split('').map(() => '_').join(' ');
}

function startDrawingRound(room) {
  clearInterval(room.snakeInterval);
  const list = Array.from(room.players.values());
  if (list.length === 0) return;

  room.currentWord = (globalWordPool[Math.floor(Math.random() * globalWordPool.length)] || 'enclave').toLowerCase();
  room.guessedIds.clear();
  room.hangmanLeft = room.settings.hangmanMaxGuesses;

  const drawer = list[(room.round - 1) % list.length];
  broadcast(room, { type: 'clearCanvas' });
  broadcast(room, {
    type: 'roundState',
    maskedWord: maskWord(room.currentWord),
    round: room.round,
    maxRounds: room.settings.rounds,
    hangmanLeft: room.hangmanLeft,
    hangmanMax: room.settings.hangmanMaxGuesses
  });

  broadcast(room, {
    type: 'chat',
    nickname: 'Enclave Referee',
    text: `${drawer.nickname} is now drawing!`,
    style: 'system'
  });

  for (const [sock, p] of room.players.entries()) {
    if (p.discordId === drawer.discordId) {
      sendWsFrame(sock, {
        type: 'roundState',
        maskedWord: room.currentWord.toUpperCase().split('').join(' '),
        round: room.round,
        maxRounds: room.settings.rounds,
        hangmanLeft: room.hangmanLeft,
        hangmanMax: room.settings.hangmanMaxGuesses
      });
    }
  }
}

function startSnakeArena(room) {
  clearInterval(room.snakeInterval);
  const colors = ['#5865f2', '#23a55a', '#f23f43', '#f0b232', '#9b59b6', '#e67e22'];
  room.snakes.clear();
  room.orbs = Array.from({ length: 16 }, () => ({
    x: 40 + Math.floor(Math.random() * 880),
    y: 40 + Math.floor(Math.random() * 460)
  }));

  let idx = 0;
  for (const p of room.players.values()) {
    const startX = 160 + (idx * 120) % 640;
    const startY = 140 + (idx * 90) % 280;
    room.snakes.set(p.discordId, {
      discordId: p.discordId,
      nickname: p.nickname,
      color: colors[idx % colors.length],
      dx: 1,
      dy: 0,
      body: [{ x: startX, y: startY }, { x: startX - 14, y: startY }, { x: startX - 28, y: startY }]
    });
    idx++;
  }

  room.snakeInterval = setInterval(() => {
    for (const s of room.snakes.values()) {
      const head = {
        x: (s.body[0].x + s.dx * 10 + 960) % 960,
        y: (s.body[0].y + s.dy * 10 + 540) % 540
      };
      s.body.unshift(head);

      const hit = room.orbs.findIndex(o => Math.hypot(o.x - head.x, o.y - head.y) < 16);
      if (hit !== -1) {
        room.orbs[hit] = { x: 30 + Math.floor(Math.random() * 900), y: 30 + Math.floor(Math.random() * 480) };
        for (const p of room.players.values()) {
          if (p.discordId === s.discordId) p.score = (p.score || 0) + 15;
        }
        broadcastRoster(room);
      } else {
        s.body.pop();
      }
    }
    broadcast(room, { type: 'snakeTick', snakes: Array.from(room.snakes.values()), orbs: room.orbs });
  }, 65);
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  let currentRoom = null;
  let rxBuffer = Buffer.alloc(0);

  socket.on('data', async (chunk) => {
    rxBuffer = Buffer.concat([rxBuffer, chunk]);
    const decoded = decodeWsFrames(rxBuffer);
    rxBuffer = decoded.remaining;

    if (decoded.close) {
      socket.end();
      return;
    }

    for (const raw of decoded.messages) {
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }

      if (msg.type === 'join') {
        currentRoom = getOrCreateRoom(msg.instanceId || 'default');
        const team = currentRoom.players.size % 2 === 0 ? 'A' : 'B';
        currentRoom.players.set(socket, { ...msg.player, score: 0, team });
        broadcastRoster(currentRoom);
        broadcast(currentRoom, {
          type: 'chat',
          nickname: 'System',
          text: `${msg.player.nickname} joined (Team ${team}).`,
          style: 'system'
        });
        continue;
      }

      if (!currentRoom) continue;
      const sender = currentRoom.players.get(socket);
      if (!sender) continue;

      if (msg.type === 'stroke') {
        broadcast(currentRoom, msg, socket);
      } else if (msg.type === 'clearCanvas') {
        broadcast(currentRoom, { type: 'clearCanvas' }, socket);
      } else if (msg.type === 'switchMode') {
        currentRoom.mode = msg.mode;
        clearInterval(currentRoom.snakeInterval);
        broadcastRoster(currentRoom);
        if (msg.mode === 'snake') startSnakeArena(currentRoom);
      } else if (msg.type === 'startGame') {
        if (msg.settings) {
          currentRoom.settings = { ...currentRoom.settings, ...msg.settings };
          currentRoom.mode = msg.settings.mode || currentRoom.mode;
          await syncDictionaryFromGoogleSheet(currentRoom.settings.difficulty);
        }
        currentRoom.round = 1;
        if (currentRoom.mode === 'snake') startSnakeArena(currentRoom);
        else startDrawingRound(currentRoom);
      } else if (msg.type === 'guess') {
        const text = String(msg.text || '').trim();
        if (!text) continue;

        if (
          (currentRoom.mode === 'skribbl' || currentRoom.mode === 'hangman') &&
          currentRoom.currentWord &&
          text.toLowerCase() === currentRoom.currentWord.toLowerCase()
        ) {
          if (!currentRoom.guessedIds.has(sender.discordId)) {
            currentRoom.guessedIds.add(sender.discordId);
            sender.score = (sender.score || 0) + 120;
            broadcastRoster(currentRoom);
            broadcast(currentRoom, { type: 'chat', nickname: sender.nickname, text: 'Guessed the word!', style: 'correct' });

            if (currentRoom.round < currentRoom.settings.rounds) {
              currentRoom.round++;
              setTimeout(() => startDrawingRound(currentRoom), 1500);
            } else {
              pushScoresToGoogleSheet(Array.from(currentRoom.players.values()));
            }
          }
          continue;
        }

        if (currentRoom.mode === 'hangman' && currentRoom.currentWord) {
          currentRoom.hangmanLeft = Math.max(0, currentRoom.hangmanLeft - 1);
          broadcast(currentRoom, {
            type: 'roundState',
            maskedWord: maskWord(currentRoom.currentWord),
            round: currentRoom.round,
            maxRounds: currentRoom.settings.rounds,
            hangmanLeft: currentRoom.hangmanLeft,
            hangmanMax: currentRoom.settings.hangmanMaxGuesses
          });
        }

        broadcast(currentRoom, { type: 'chat', nickname: sender.nickname, text, style: '' });
      } else if (msg.type === 'snakeDir') {
        const s = currentRoom.snakes.get(sender.discordId);
        if (s && (s.dx !== -msg.dx || s.dy !== -msg.dy)) {
          s.dx = msg.dx;
          s.dy = msg.dy;
        }
      }
    }
  });

  socket.on('close', () => {
    if (currentRoom) {
      currentRoom.players.delete(socket);
      broadcastRoster(currentRoom);
    }
  });
});

server.listen(PORT, async () => {
  console.log(`Enclave Arcade Server listening on port ${PORT}`);
  await syncDictionaryFromGoogleSheet('ALL');
  await registerDiscordSlashCommands();
});
