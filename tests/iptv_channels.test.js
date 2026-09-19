'use strict';

const assert = require('assert');
const channels = require('../lib/iptv_channels');

assert.strictEqual(channels.canonicalChannelName('UK: Sky Sp PL HD'), 'Sky Sports Premier League HD');
assert.strictEqual(channels.canonicalChannelName('BT Sport 1'), 'TNT Sports 1');
assert.strictEqual(channels.canonicalChannelName('PS One'), 'Premier Sports 1');
assert.strictEqual(channels.canonicalChannelName('DAZN Great Britain (geo/R)'), 'DAZN UK');
assert.strictEqual(channels.cleanChannelText('DAZN Ireland ($/geo/R)'), 'DAZN Ireland');
assert.deepStrictEqual(channels.extractCanonicalChannels('Sky Sports Main Event / Sky Sports Football'), ['Sky Sports Main Event', 'Sky Sports Football']);
assert.strictEqual(channels.classifyProgramme('LIVE: Arsenal v Chelsea'), 'live');
assert.strictEqual(channels.classifyProgramme('Premier League highlights'), 'highlights/replay');
assert.strictEqual(channels.classifyProgramme('Match preview'), 'preview');

console.log('✓ IPTV aliases, access-marker cleanup and programme classification');
