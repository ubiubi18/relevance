function validCap(seconds) {
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 10;
}

function checkNow(now) {
  if (!Number.isFinite(now)) throw new TypeError('Timestamp must be finite milliseconds');
}

function priorMilliseconds(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

export function createDwellTimer({ capSeconds = 10, onRecord = () => {} } = {}) {
  if (!validCap(capSeconds)) throw new RangeError('Dwell cap must be an integer from 1 to 10 seconds');
  if (typeof onRecord !== 'function') throw new TypeError('onRecord must be a function');

  let cap = capSeconds;
  let current = null;
  let lastNow = null;
  const totals = new Map();

  function accept(now) {
    checkNow(now);
    if (lastNow !== null && now < lastNow) return false;
    lastNow = now;
    return true;
  }

  function record(now) {
    if (!current) return;
    const before = totals.get(current.id) ?? 0;
    const after = before < cap * 1000
      ? Math.min(cap * 1000, before + now - current.lastAt)
      : before;
    current.lastAt = now;
    totals.set(current.id, after);
    const seconds = Math.round(after) / 1000;
    if (seconds > Math.round(before) / 1000) onRecord({ id: current.id, seconds });
  }

  function update({ id, active, now, previousSeconds = 0 }) {
    if (!accept(now)) return;
    if (active && !(typeof id === 'string' && id.length > 0)) {
      throw new TypeError('Active post id must be a nonempty string');
    }

    if (current && active && current.id === id) {
      totals.set(id, Math.max(totals.get(id) ?? 0, priorMilliseconds(previousSeconds)));
      record(now);
      return;
    }

    record(now);
    current = null;
    if (!active) return;

    totals.set(id, Math.max(totals.get(id) ?? 0, priorMilliseconds(previousSeconds)));
    current = { id, lastAt: now };
  }

  function stop(now) {
    if (!accept(now)) return;
    record(now);
    current = null;
    totals.clear();
  }

  function setCap(seconds, now) {
    if (!validCap(seconds)) throw new RangeError('Dwell cap must be an integer from 1 to 10 seconds');
    if (!accept(now)) return;
    record(now);
    cap = seconds;
  }

  return { update, stop, setCap };
}
