import test from 'node:test';
import assert from 'node:assert/strict';
import { captionLines, srtLines } from '../scripts/video/text.mjs';

test('YouTube captions are joined into lines at pauses and full stops', () => {
  const j = {
    events: [
      { tStartMs: 180000, segs: [{ utf8: 'After' }, { utf8: ' 300', tOffsetMs: 300 }, { utf8: ' yards,', tOffsetMs: 600 }] },
      { tStartMs: 181200, segs: [{ utf8: 'turn' }, { utf8: ' left.', tOffsetMs: 200 }] },
      { tStartMs: 181500, aAppend: 1, segs: [{ utf8: '\n' }] },
      { tStartMs: 182000, segs: [{ utf8: 'Then' }, { utf8: ' keep', tOffsetMs: 300 }] },
      { tStartMs: 190000, segs: [{ utf8: 'Pull' }, { utf8: ' up', tOffsetMs: 200 }] },
    ],
  };
  assert.deepEqual(captionLines(j), [
    { t: 180, text: 'After 300 yards, turn left.' },
    { t: 182, text: 'Then keep' },
    { t: 190, text: 'Pull up' },
  ]);
});

test('Whisper SubRip output is read with its start times', () => {
  const srt = '0\r\n00:03:00,120 --> 00:03:04,500\r\nAfter 300 yards, turn left,\r\nNorthfield Avenue.\r\n\r\n1\r\n01:02:03,000 --> 01:02:05,000\r\nTurn right.\r\n';
  assert.deepEqual(srtLines(srt), [
    { t: 180.12, text: 'After 300 yards, turn left, Northfield Avenue.' },
    { t: 3723, text: 'Turn right.' },
  ]);
});
