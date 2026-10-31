'use strict';

// A separate, bounded archive of successfully published listings. No Telegram
// tokens, chat identifiers, credentials or internal scrape data enter this file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DEFAULT_DIR = path.join(__dirname, '..', 'storage', 'malri-feed');
const MAX_POSTS = 400;
const MAX_AGE = 7 * 86400000;
const ID = /^[a-f0-9]{32}$/;
const text = (value, max = 16000) => String(value || '').slice(0, max);
const channelKey = channel => crypto.createHash('sha256').update(`channel:${channel.id}`).digest('hex');

function createFeed(directory = DEFAULT_DIR) {
  const index = path.join(directory, 'posts.json');
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(index, 'utf8'));
      if (!Array.isArray(data)) throw new Error('Invalid post archive');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error; // Never silently replace a damaged archive.
    }
  }
  function active(posts, now) {
    return posts.filter(p => ID.test(p.id) && p.postedAt > now - MAX_AGE && p.expiresAt > now)
      .sort((a, b) => b.postedAt - a.postedAt).slice(0, MAX_POSTS);
  }
  function save(input, now = Date.now()) {
    if (!input.channel || input.channel.malriFeed !== true) return null;
    if (!Number.isInteger(Number(input.messageId)) || Number(input.messageId) <= 0) {
      throw new Error('Only successfully published Telegram messages can be archived');
    }
    const id = crypto.createHash('sha256').update(`${input.channel.id}|${input.messageId}`).digest('hex').slice(0, 32);
    const postedAt = now;
    const expiresAt = Math.min(Number(input.expiresAt) || now + 86400000, now + MAX_AGE);
    if (expiresAt <= now) return null;
    fs.mkdirSync(directory, { recursive: true });
    const fixture = input.fixture || {};
    const item = {
      id, channelKey: channelKey(input.channel), kind: input.kind === 'digest' ? 'digest' : 'fixture', postedAt, expiresAt,
      source: text(input.channel.brandName || input.channel.label || 'TV Listings', 100),
      title: text(input.title || fixture.matchTitle || fixture.summary || 'Daily TV listings', 240),
      caption: text(input.caption), homeTeam: text(fixture.homeTeam, 120),
      awayTeam: text(fixture.awayTeam, 120), competition: text(fixture.competition || fixture.league, 160),
      kickoff: Number.isFinite(Date.parse(fixture.start)) ? new Date(fixture.start).toISOString() : null,
      channels: (Array.isArray(fixture.tvByRegion) ? fixture.tvByRegion : []).slice(0, 80)
        .map(c => ({ region: text(c.region, 80), channel: text(c.channel, 150) })),
      updated: input.updated === true, image: null
    };
    // Copy only a locally generated PNG, never a remote URL or arbitrary file.
    if (input.imagePath) {
      const stat = fs.statSync(input.imagePath);
      const signature = Buffer.alloc(8);
      const fd = fs.openSync(input.imagePath, 'r');
      try { fs.readSync(fd, signature, 0, 8, 0); } finally { fs.closeSync(fd); }
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024 || signature.toString('hex') !== '89504e470d0a1a0a') {
        throw new Error('Invalid generated poster image');
      }
      const destination = path.join(directory, `${id}.png`);
      fs.copyFileSync(input.imagePath, destination);
      item.image = `/api/malri/posters/${id}`;
    }
    const posts = active([item, ...read().filter(p => p.id !== id)], now);
    const temp = `${index}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(posts)); fs.renameSync(temp, index); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    const keep = new Set(posts.filter(p => p.image).map(p => `${p.id}.png`));
    for (const name of fs.readdirSync(directory)) {
      if (/^[a-f0-9]{32}\.png$/.test(name) && !keep.has(name)) fs.unlinkSync(path.join(directory, name));
    }
    return item;
  }
  function list(now = Date.now(), enabled = null) {
    const posts = active(read(), now).filter(p => enabled === null || enabled.has(p.channelKey))
      .map(({ channelKey: ignored, ...post }) => post);
    return { success: true, timezone: 'Europe/London', generatedAt: new Date(now).toISOString(), posts };
  }
  function image(id, now = Date.now(), enabled = null) {
    if (!ID.test(id) || !list(now, enabled).posts.some(p => p.id === id && p.image)) return null;
    const file = path.join(directory, `${id}.png`);
    return fs.existsSync(file) ? file : null;
  }
  return { save, list, image };
}

const feed = createFeed();
function registerRoutes(app, loadConfig) {
  function enabledChannels() {
    return new Set((loadConfig().channels || []).filter(c => c.malriFeed === true).map(channelKey));
  }
  app.get('/api/malri/posts', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(feed.list(Date.now(), enabledChannels())); }
    catch (_) { res.status(503).json({ success: false, error: 'Listings temporarily unavailable' }); }
  });
  app.get('/api/malri/posters/:id', (req, res) => {
    try {
      const file = feed.image(req.params.id, Date.now(), enabledChannels());
      if (!file) return res.status(404).end();
      res.set('Cache-Control', 'private, max-age=60');
      res.type('png').sendFile(file);
    } catch (_) { res.status(503).end(); }
  });
  app.get('/malri', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '..', 'assets', 'malri-listings.html'));
  });
}
module.exports = { createFeed, registerRoutes, savePost: feed.save, MAX_POSTS, MAX_AGE };
