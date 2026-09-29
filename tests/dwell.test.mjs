import test from 'node:test';
import assert from 'node:assert/strict';
import { createDwellTimer } from '../dwell.mjs';

test('records whole seconds once as the longest view grows, up to the default cap', () => {
  const records = [];
  const timer = createDwellTimer({ onRecord: (record) => records.push(record) });

  timer.update({ id: 'a', active: true, now: 100 });
  timer.update({ id: 'a', active: true, now: 1099 });
  timer.update({ id: 'a', active: true, now: 1100 });
  timer.update({ id: 'a', active: true, now: 1600 });
  timer.update({ id: 'a', active: true, now: 10100 });
  timer.update({ id: 'a', active: true, now: 30100 });

  assert.deepEqual(records, [
    { id: 'a', seconds: 1 },
    { id: 'a', seconds: 10 },
  ]);
});

test('inactive periods do not count toward either view', () => {
  const records = [];
  const timer = createDwellTimer({ onRecord: (record) => records.push(record) });

  timer.update({ id: 'a', active: true, now: 0 });
  timer.update({ id: 'a', active: false, now: 2000 });
  timer.update({ id: 'a', active: false, now: 20000 });
  timer.update({ id: 'a', active: true, now: 20000, previousSeconds: 2 });
  timer.update({ id: 'a', active: true, now: 21000, previousSeconds: 2 });
  timer.stop(22000);

  assert.deepEqual(records, [{ id: 'a', seconds: 2 }]);
});

test('switching posts finishes the old view and starts the new view at the boundary', () => {
  const records = [];
  const timer = createDwellTimer({ onRecord: (record) => records.push(record) });

  timer.update({ id: 'a', active: true, now: 0 });
  timer.update({ id: 'b', active: true, now: 3500 });
  timer.update({ id: 'b', active: true, now: 5500 });
  timer.stop(6500);

  assert.deepEqual(records, [
    { id: 'a', seconds: 3 },
    { id: 'b', seconds: 2 },
    { id: 'b', seconds: 3 },
  ]);
});

test('revisits compare their uninterrupted duration with the stored best, never add durations', () => {
  const records = [];
  let stored = 0;
  const timer = createDwellTimer({ onRecord: (record) => {
    records.push(record);
    stored = record.seconds;
  } });

  timer.update({ id: 'a', active: true, now: 0, previousSeconds: stored });
  timer.stop(4000);
  timer.update({ id: 'a', active: true, now: 10000, previousSeconds: stored });
  timer.stop(13000);
  timer.update({ id: 'a', active: true, now: 20000, previousSeconds: stored });
  timer.stop(25000);

  assert.equal(stored, 5);
  assert.deepEqual(records, [{ id: 'a', seconds: 4 }, { id: 'a', seconds: 5 }]);
});

test('stop clears the cached best so a caller reset can lower the stored value', () => {
  const records = [];
  const timer = createDwellTimer({ onRecord: (record) => records.push(record) });

  timer.update({ id: 'a', active: true, now: 0, previousSeconds: 8 });
  timer.stop(1000);
  timer.update({ id: 'a', active: true, now: 2000, previousSeconds: 0 });
  timer.stop(3000);

  assert.deepEqual(records, [{ id: 'a', seconds: 1 }]);
});

test('cap changes respect the boundary and the current view duration', () => {
  const records = [];
  const timer = createDwellTimer({ capSeconds: 10, onRecord: (record) => records.push(record) });

  timer.update({ id: 'a', active: true, now: 0 });
  timer.setCap(3, 6000);
  timer.update({ id: 'a', active: true, now: 8000 });
  timer.setCap(12, 12000);

  assert.deepEqual(records, [
    { id: 'a', seconds: 6 },
    { id: 'a', seconds: 12 },
  ]);
});

test('rejects invalid caps and timestamps and ignores backwards timestamps', () => {
  for (const cap of [0, 61, 1.5, NaN, Infinity]) {
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
