'use strict';

const CHANNEL_RULES = [
  ['Sky Sports Main Event', /\bsky\s*(?:sports?|sp)\s*(?:main\s*event|me)\b/i],
  ['Sky Sports Premier League', /\bsky\s*(?:sports?|sp)\s*(?:premier\s*league|pl)\b/i],
  ['Sky Sports Football', /\bsky\s*(?:sports?|sp)\s*football\b/i],
  ['Sky Sports+', /\bsky\s*(?:sports?)?\s*(?:\+|plus)\b/i],
  ['Sky Sports Mix', /\bsky\s*(?:sports?)?\s*mix\b/i],
  ['TNT Sports 1', /\b(?:tnt|bt)\s*sports?\s*1\b/i],
  ['TNT Sports 2', /\b(?:tnt|bt)\s*sports?\s*2\b/i],
  ['TNT Sports 3', /\b(?:tnt|bt)\s*sports?\s*3\b/i],
  ['TNT Sports 4', /\b(?:tnt|bt)\s*sports?\s*4\b/i],
  ['TNT Sports Ultimate', /\btnt\s*sports?\s*ultimate\b/i],
  ['Premier Sports 1', /\b(?:premier\s*sports?\s*(?:1|one)|ps\s*one)\b/i],
  ['Premier Sports 2', /\b(?:premier\s*sports?\s*(?:2|two)|ps\s*two)\b/i],
  ['Premier Sports Extra', /\b(?:premier\s*(?:sports?\s*)?extra|ps\s*extra)\b/i],
  ['BBC One', /\bbbc\s*(?:one|1)\b/i],
  ['BBC Two', /\bbbc\s*(?:two|2)\b/i],
  ['BBC iPlayer', /\bbbc\s*iplayer\b/i],
  ['ITV1', /\bitv\s*(?:1|one)\b/i],
  ['ITV4', /\bitv\s*(?:4|four)\b/i],
  ['ITVX', /\bitvx\b/i],
  ['Channel 4', /\bchannel\s*4\b/i],
  ['S4C', /\bs4c\b/i],
  ['Amazon Prime Video', /\b(?:amazon\s*)?prime\s*video\b/i],
  ['discovery+', /\bdiscovery\s*\+\b/i],
  ['DAZN UK', /\bdazn\s*(?:uk|great\s*britain)\b/i]
];

function cleanChannelText(value) {
  return String(value || '')
    .replace(/📺/g, '')
    .replace(/\s*\([^)]*(?:geo(?:\s*\/\s*r)?|\$)[^)]*\)/gi, '')
    .replace(/\s+(?:\$\s*\/\s*)?geo(?:\s*\/\s*r)?\b/gi, '')
    .replace(/^\s*(?:uk|gb)\s*[:|\-]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalChannelName(value) {
  const cleaned = cleanChannelText(value);
  if (!cleaned) return '';
  const rule = CHANNEL_RULES.find(([, pattern]) => pattern.test(cleaned));
  if (!rule) return cleaned.replace(/\s+(hd|uhd|4k)$/i, (suffix) => suffix.toUpperCase());
  const quality = cleaned.match(/\b(HD|UHD|4K)\b/i)?.[1]?.toUpperCase();
  return quality && !rule[0].endsWith('+') ? `${rule[0]} ${quality}` : rule[0];
}

function extractCanonicalChannels(value) {
  const text = cleanChannelText(value);
  const channels = [];
  for (const [canonical, pattern] of CHANNEL_RULES) {
    if (pattern.test(text)) channels.push(canonical);
  }
  return [...new Set(channels)];
}

function classifyProgramme(value, options = {}) {
  const text = String(value || '').toLowerCase();
  if (/\blive\b/.test(text)) return 'live';
  if (/\b(?:highlights?|replay|repeat|classic|magazine|countdown|greatest|review)\b/.test(text)) return 'highlights/replay';
  if (/\bpreview\b|build[ -]?up/.test(text)) return 'preview';
  if (options.defaultLive === true) return 'live';
  return 'unknown';
}

module.exports = {
  CHANNEL_RULES,
  cleanChannelText,
  canonicalChannelName,
  extractCanonicalChannels,
  classifyProgramme
};
