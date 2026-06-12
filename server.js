const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const TIMER_LIMIT = 10;
let auctionTimer = null;

// ---------- DB SETUP ----------
const dbFile = path.join(__dirname, 'db', 'data.json');
if (!fs.existsSync(path.join(__dirname, 'db'))) fs.mkdirSync(path.join(__dirname, 'db'));
const adapter = new FileSync(dbFile);
const db = low(adapter);

db.defaults({
  teams: [],          // {id, name, logo, purse, remaining, ownerName}
  players: [],        // {id, name, photo, basePrice, role, status, soldPrice, soldTo}
  history: [],        // {id, playerId, playerName, teamId, teamName, amount, time}
  auction: {
    currentPlayerId: null,
    currentBid: 0,
    highestBidderId: null,
    status: 'idle',    // idle | live | sold | unsold
    timer: 0
  }
}).write();

function clearAuctionTimer() {
  if (auctionTimer) {
    clearInterval(auctionTimer);
    auctionTimer = null;
  }
}

function broadcastState() {
  io.emit('state', getFullState());
}

function startCountdown() {
  clearAuctionTimer();
  db.set('auction.timer', TIMER_LIMIT).write();
  broadcastState();
  auctionTimer = setInterval(() => {
    const auction = db.get('auction').value();
    if (auction.status !== 'live') {
      clearAuctionTimer();
      return;
    }
    const nextTime = (auction.timer || 0) - 1;
    db.set('auction.timer', nextTime).write();
    broadcastState();
    if (nextTime <= 0) {
      clearAuctionTimer();
      handleAuctionExpire();
    }
  }, 1000);
}

function getFullState() {
  return {
    teams: db.get('teams').value(),
    players: db.get('players').value(),
    history: db.get('history').value(),
    auction: db.get('auction').value()
  };
}

function startAuctionForPlayer(playerId) {
  const player = db.get('players').find({ id: playerId }).value();
  if (!player) return;
  db.set('auction', {
    currentPlayerId: playerId,
    currentBid: player.basePrice,
    highestBidderId: null,
    status: 'live',
    timer: TIMER_LIMIT
  }).write();
  startCountdown();
  broadcastState();
}

function getNextAvailablePlayer() {
  return db.get('players').find({ status: 'available' }).value();
}

function finishAuctionResult(type, player, team, amount) {
  if (type === 'sold') {
    if (player) {
      player.status = 'sold';
      player.soldPrice = amount;
      player.soldTo = team.id;
    }
    if (team) {
      team.remaining -= amount;
    }
    const historyEntry = {
      id: nextId('history'),
      playerId: player.id,
      playerName: player.name,
      teamId: team.id,
      teamName: team.name,
      amount,
      time: new Date().toISOString()
    };
    db.get('history').push(historyEntry).write();
    io.emit('auction-ended', { type: 'sold', player, team, amount });
  } else {
    if (player) {
      player.status = 'unsold';
      db.write();
    }
    io.emit('auction-ended', { type: 'unsold', player, team: null, amount: 0 });
  }
  db.set('auction', {
    currentPlayerId: null,
    currentBid: 0,
    highestBidderId: null,
    status: 'idle',
    timer: 0
  }).write();
  broadcastState();
}

function handleAuctionExpire() {
  const auction = db.get('auction').value();
  const player = db.get('players').find({ id: auction.currentPlayerId }).value();
  const team = db.get('teams').find({ id: auction.highestBidderId }).value();
  if (auction.highestBidderId && player && team) {
    finishAuctionResult('sold', player, team, auction.currentBid);
  } else {
    finishAuctionResult('unsold', player, null, 0);
  }
  const nextPlayer = getNextAvailablePlayer();
  if (nextPlayer) {
    setTimeout(() => {
      startAuctionForPlayer(nextPlayer.id);
    }, 3000);
  }
}

// ---------- UPLOADS ----------
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
  }
});
const upload = multer({ storage });

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- HELPERS ----------
function nextId(collection) {
  const items = db.get(collection).value();
  return items.length ? Math.max(...items.map(i => i.id)) + 1 : 1;
}

// ================= TEAMS =================
app.get('/api/teams', (req, res) => res.json(db.get('teams').value()));

app.post('/api/teams', upload.single('logo'), (req, res) => {
  const { name, purse } = req.body;
  if (!name || !purse) return res.status(400).json({ error: 'name and purse required' });
  const team = {
    id: nextId('teams'),
    name,
    logo: req.file ? '/uploads/' + req.file.filename : null,
    purse: Number(purse),
    remaining: Number(purse),
    ownerName: null
  };
  db.get('teams').push(team).write();
  broadcastState();
  res.json(team);
});

app.put('/api/teams/:id', upload.single('logo'), (req, res) => {
  const id = Number(req.params.id);
  const team = db.get('teams').find({ id }).value();
  if (!team) return res.status(404).json({ error: 'not found' });
  const { name, purse } = req.body;
  if (name) team.name = name;
  if (purse) {
    const diff = Number(purse) - team.purse;
    team.purse = Number(purse);
    team.remaining = team.remaining + diff;
  }
  if (req.file) team.logo = '/uploads/' + req.file.filename;
  db.write();
  broadcastState();
  res.json(team);
});

app.post('/api/teams/:id/owner', (req, res) => {
  const id = Number(req.params.id);
  const { ownerName } = req.body;
  if (!ownerName) return res.status(400).json({ error: 'ownerName required' });
  const team = db.get('teams').find({ id }).value();
  if (!team) return res.status(404).json({ error: 'team not found' });
  if (team.ownerName) return res.status(400).json({ error: 'team already has an owner' });
  team.ownerName = ownerName;
  db.write();
  broadcastState();
  res.json(team);
});

app.delete('/api/teams/:id', (req, res) => {
  const id = Number(req.params.id);
  db.get('teams').remove({ id }).write();
  broadcastState();
  res.json({ success: true });
});

// ================= PLAYERS =================
app.get('/api/players', (req, res) => res.json(db.get('players').value()));

app.post('/api/players', upload.single('photo'), (req, res) => {
  const { name, basePrice, role } = req.body;
  if (!name || !basePrice) return res.status(400).json({ error: 'name and basePrice required' });
  const player = {
    id: nextId('players'),
    name,
    photo: req.file ? '/uploads/' + req.file.filename : null,
    basePrice: Number(basePrice),
    role: role || 'All-rounder',
    status: 'available', // available | sold | unsold
    soldPrice: null,
    soldTo: null
  };
  db.get('players').push(player).write();
  broadcastState();
  res.json(player);
});

// Bulk add players (JSON array, no photos)
app.post('/api/players/bulk', (req, res) => {
  const list = req.body.players;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'players array required' });
  const added = [];
  list.forEach(p => {
    const player = {
      id: nextId('players'),
      name: p.name,
      photo: p.photo || null,
      basePrice: Number(p.basePrice) || 1,
      role: p.role || 'All-rounder',
      status: 'available',
      soldPrice: null,
      soldTo: null
    };
    db.get('players').push(player).write();
    added.push(player);
  });
  broadcastState();
  res.json(added);
});

app.put('/api/players/:id', upload.single('photo'), (req, res) => {
  const id = Number(req.params.id);
  const player = db.get('players').find({ id }).value();
  if (!player) return res.status(404).json({ error: 'not found' });
  const { name, basePrice, role } = req.body;
  if (name) player.name = name;
  if (basePrice) player.basePrice = Number(basePrice);
  if (role) player.role = role;
  if (req.file) player.photo = '/uploads/' + req.file.filename;
  db.write();
  broadcastState();
  res.json(player);
});

app.delete('/api/players/:id', (req, res) => {
  const id = Number(req.params.id);
  db.get('players').remove({ id }).write();
  broadcastState();
  res.json({ success: true });
});

// ================= AUCTION ACTIONS =================

// Start auction for a specific player
app.post('/api/auction/start/:playerId', (req, res) => {
  const playerId = Number(req.params.playerId);
  const player = db.get('players').find({ id: playerId }).value();
  if (!player) return res.status(404).json({ error: 'player not found' });

  startAuctionForPlayer(playerId);
  res.json(db.get('auction').value());
});

// Place a bid (increment based)
app.post('/api/auction/bid', (req, res) => {
  const { teamId, increment } = req.body;
  const auction = db.get('auction').value();
  if (auction.status !== 'live') return res.status(400).json({ error: 'no live auction' });

  const team = db.get('teams').find({ id: Number(teamId) }).value();
  if (!team) return res.status(404).json({ error: 'team not found' });

  const newBid = auction.currentBid + Number(increment);
  if (newBid > team.remaining) return res.status(400).json({ error: 'insufficient purse' });

  db.set('auction.currentBid', newBid)
    .set('auction.highestBidderId', team.id)
    .set('auction.timer', TIMER_LIMIT)
    .write();

  startCountdown();
  broadcastState();
  res.json(db.get('auction').value());
});

// Set bid to exact amount (manual override)
app.post('/api/auction/set-bid', (req, res) => {
  const { teamId, amount } = req.body;
  const auction = db.get('auction').value();
  if (auction.status !== 'live') return res.status(400).json({ error: 'no live auction' });

  const team = db.get('teams').find({ id: Number(teamId) }).value();
  if (!team) return res.status(404).json({ error: 'team not found' });
  if (Number(amount) > team.remaining) return res.status(400).json({ error: 'insufficient purse' });

  db.set('auction.currentBid', Number(amount))
    .set('auction.highestBidderId', team.id)
    .set('auction.timer', TIMER_LIMIT)
    .write();

  startCountdown();
  broadcastState();
  res.json(db.get('auction').value());
});

// Mark current player SOLD
app.post('/api/auction/sold', (req, res) => {
  const auction = db.get('auction').value();
  if (auction.status !== 'live') return res.status(400).json({ error: 'no live auction' });
  if (!auction.highestBidderId) return res.status(400).json({ error: 'no bidder' });

  const player = db.get('players').find({ id: auction.currentPlayerId }).value();
  const team = db.get('teams').find({ id: auction.highestBidderId }).value();
  if (!player || !team) return res.status(404).json({ error: 'data not found' });

  // Update player
  player.status = 'sold';
  player.soldPrice = auction.currentBid;
  player.soldTo = team.id;

  // Update team purse
  team.remaining -= auction.currentBid;

  // Add to history
  const historyEntry = {
    id: nextId('history'),
    playerId: player.id,
    playerName: player.name,
    teamId: team.id,
    teamName: team.name,
    amount: auction.currentBid,
    time: new Date().toISOString()
  };
  db.get('history').push(historyEntry).write();

  // Reset auction
  clearAuctionTimer();
  db.set('auction', {
    currentPlayerId: null,
    currentBid: 0,
    highestBidderId: null,
    status: 'idle',
    timer: 0
  }).write();

  db.write();
  broadcastState();
  io.emit('auction-ended', { type: 'sold', player, team, amount: historyEntry.amount });
  res.json({ player, team, history: historyEntry });
});

// Mark current player UNSOLD
app.post('/api/auction/unsold', (req, res) => {
  const auction = db.get('auction').value();
  if (auction.status !== 'live') return res.status(400).json({ error: 'no live auction' });

  const player = db.get('players').find({ id: auction.currentPlayerId }).value();
  if (player) {
    player.status = 'unsold';
    db.write();
  }

  clearAuctionTimer();
  db.set('auction', {
    currentPlayerId: null,
    currentBid: 0,
    highestBidderId: null,
    status: 'idle',
    timer: 0
  }).write();

  broadcastState();
  res.json({ success: true });
});

// Undo last sale
app.post('/api/auction/undo', (req, res) => {
  const history = db.get('history').value();
  if (!history.length) return res.status(400).json({ error: 'nothing to undo' });

  const last = history[history.length - 1];
  const player = db.get('players').find({ id: last.playerId }).value();
  const team = db.get('teams').find({ id: last.teamId }).value();

  if (player) {
    player.status = 'available';
    player.soldPrice = null;
    player.soldTo = null;
  }
  if (team) {
    team.remaining += last.amount;
  }

  db.get('history').pop().write();
  db.write();

  broadcastState();
  res.json({ success: true });
});

// Get full state
app.get('/api/state', (req, res) => res.json(getFullState()));

// Reset entire auction (keep teams/players, clear sales)
app.post('/api/auction/reset', (req, res) => {
  clearAuctionTimer();
  db.get('players').value().forEach(p => {
    p.status = 'available';
    p.soldPrice = null;
    p.soldTo = null;
  });
  db.get('teams').value().forEach(t => {
    t.remaining = t.purse;
  });
  db.set('history', []).write();
  db.set('auction', {
    currentPlayerId: null,
    currentBid: 0,
    highestBidderId: null,
    status: 'idle',
    timer: 0
  }).write();
  db.write();
  broadcastState();
  res.json({ success: true });
});
// Home Route
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>IPL Auction Backend</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          text-align: center;
          padding: 50px;
          background: #f5f5f5;
        }
        h1 {
          color: #333;
        }
        a {
          display: block;
          margin: 10px;
          color: blue;
          text-decoration: none;
        }
      </style>
    </head>
    <body>
      <h1>🏏 IPL Auction Backend Running Successfully</h1>
      <p>Available APIs</p>

      <a href="/api/state">View Auction State</a>
      <a href="/api/teams">View Teams</a>
      <a href="/api/players">View Players</a>

    </body>
    </html>
  `);
});

// ---------- SOCKET.IO ----------
io.on('connection', (socket) => {
  socket.emit('state', getFullState());
  socket.on('disconnect', () => {});
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
