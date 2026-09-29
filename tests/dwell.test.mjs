import test from 'node:test';
import assert from 'node:assert/strict';
import { createDwellTimer } from '../dwell.mjs';

test('records fractional seconds from a short glance and stops at ten seconds', () => {
  const records = [];
  const timer = createDwellTimer({ onRecord: (record) => records.push(record) });

  timer.update({ id: 'a', active: true, now: 100 });
  timer.update({ id: 'a', active: true, now: 225 });
  timer.update({ id: 'a', active: true, now: 235 });
  timer.update({ id: 'a', active: true, now: 10100 });
  timer.update({ id: 'a', active: true, now: 3600100 });

  assert.deepEqual(records, [
    { id: 'a', seconds: 0.125 },
    { id: 'a', seconds: 0.135 },
    { id: 'a', seconds: 10 },
  ]);
});

test('resumes cumulative time after inactive gaps without counting duplicate updates', () => {
  const records = [];
  const timer = createDwellTimer({ onRecord: (record) => records.push(record) });

  timer.update({ id: 'a', active: true, now: 0 });
  timer.update({ id: 'a', active: false, now: 125 });
  timer.update({ id: 'a', active: false, now: 60000 });
  timer.update({ id: 'a', active: true, now: 60000 });
  timer.update({ id: 'a', active: true, now: 60375 });
  timer.update({ id: 'a', active: false, now: 60375 });
  timer.update({ id: 'a', active: true, now: 120000 });
  timer.stop(120250);

  assert.deepEqual(records, [
    { id: 'a', seconds: 0.125 },
    { id: 'a', seconds: 0.5 },
    { id: 'a', seconds: 0.75 },
  ]);
});

test('switching posts keeps each post’s accumulated visible time separate', () => {
  const records = [];
  const timer = createDwellTimer({ onRecord: (record) => records.push(record) });

  timer.update({ id: 'a', active: true, now: 0 });
  timer.update({ id: 'b', active: true, now: 350 });
  timer.update({ id: 'b', active: true, now: 500 });
  timer.update({ id: 'a', active: true, now: 1000 });
  timer.stop(1125);

  assert.deepEqual(records, [
    { id: 'a', seconds: 0.35 },
    { id: 'b', seconds: 0.15 },
    { id: 'b', seconds: 0.65 },
    { id: 'a', seconds: 0.475 },
  ]);
});

test('resumes from a saved total and clears local totals on stop for Reset', () => {
  const records = [];
  const timer = createDwellTimer({ onRecord: (record) => records.push(record) });

  timer.update({ id: 'a', active: true, now: 0, previousSeconds: 2.5 });
  timer.stop(125);
  timer.update({ id: 'a', active: true, now: 1000, previousSeconds: 2.625 });
  timer.stop(1125);
  timer.update({ id: 'a', active: true, now: 2000, previousSeconds: 0 });
  timer.stop(2125);

  assert.deepEqual(records, [
    { id: 'a', seconds: 2.625 },
    { id: 'a', seconds: 2.75 },
    { id: 'a', seconds: 0.125 },
  ]);
});

test('cap changes use their timestamp boundary and never fill old time on an increase', () => {
  const records = [];
  const timer = createDwellTimer({ capSeconds: 2, onRecord: (record) => records.push(record) });

  timer.update({ id: 'a', active: true, now: 0 });
  timer.update({ id: 'a', active: true, now: 2500 });
  timer.setCap(4, 5000);
  timer.update({ id: 'a', active: true, now: 5125 });
  timer.setCap(1, 6000);
  timer.update({ id: 'a', active: true, now: 7000 });
  timer.setCap(4, 7000);
  timer.stop(7125);

  assert.deepEqual(records, [
    { id: 'a', seconds: 2 },
    { id: 'a', seconds: 2.125 },
    { id: 'a', seconds: 3 },
    { id: 'a', seconds: 3.125 },
  ]);
});

test('cap increases during inactivity do not award background time', () => {
  const records = [];
  const timer = createDwellTimer({ capSeconds: 3, onRecord: (record) => records.push(record) });

  timer.update({ id: 'a', active: true, now: 0 });
  timer.update({ id: 'a', active: false, now: 3000 });
  timer.setCap(10, 3600000);
  timer.update({ id: 'a', active: true, now: 3600000, previousSeconds: 3 });
  timer.stop(3600250);

  assert.deepEqual(records, [
    { id: 'a', seconds: 3 },
    { id: 'a', seconds: 3.25 },
  ]);
});

test('rejects invalid caps and timestamps and ignores backwards timestamps', () => {
  for (const cap of [0, 11, 1.5, NaN, Infinity]) {
    assert.throws(() => createDwellTimer({ capSeconds: cap }), RangeError);
  }
  const records = [];
  const timer = createDwellTimer({ onRecord: (record) => records.push(record) });
  assert.throws(() => timer.update({ id: 'a', active: true, now: NaN }), TypeError);
  assert.throws(() => timer.stop(Infinity), TypeError);
  assert.throws(() => timer.setCap(0, 0), RangeError);
  assert.throws(() => timer.setCap(2, undefined), TypeError);

  timer.update({ id: 'a', active: true, now: 1000 });
  timer.update({ id: 'b', active: true, now: 500 });
  timer.stop(500);
  timer.setCap(1, 500);
  timer.stop(3000);
  assert.deepEqual(records, [{ id: 'a', seconds: 2 }]);
});
