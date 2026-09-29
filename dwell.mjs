function validCap(seconds) {
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 60;
}

function checkNow(now) {
  if (!Number.isFinite(now)) throw new TypeError('Timestamp must be finite milliseconds');
}

function priorBest(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

export function createDwellTimer({ capSeconds = 10, onRecord = () => {} } = {}) {
  if (!validCap(capSeconds)) throw new RangeError('Dwell cap must be an integer from 1 to 60 seconds');
  if (typeof onRecord !== 'function') throw new TypeError('onRecord must be a function');

  let cap = capSeconds;
  let current = null;
  let lastNow = null;

  function accept(now) {
    checkNow(now);
    if (lastNow !== null && now < lastNow) return false;
    lastNow = now;
    return true;
  }

  function record(now) {
    if (!current) return;
    const seconds = Math.min(cap, Math.floor((now - current.startedAt) / 1000));
    if (seconds > current.bestSeconds) {
      current.bestSeconds = seconds;
      onRecord({ id: current.id, seconds });
    }
  }

  function update({ id, active, now, previousSeconds = 0 }) {
    if (!accept(now)) return;
    if (active && !(typeof id === 'string' && id.length > 0)) {
      throw new TypeError('Active post id must be a nonempty string');
    }

    if (current && (!active || current.id !== id)) {
      record(now);
      current = null;
    }
    if (!active) return;

    if (!current) current = { id, startedAt: now, bestSeconds: priorBest(previousSeconds) };
    else current.bestSeconds = Math.max(current.bestSeconds, priorBest(previousSeconds));
    record(now);
  }

  function stop(now) {
    if (!accept(now)) return;
    record(now);
    current = null;
  }

  function setCap(seconds, now) {
    if (!validCap(seconds)) throw new RangeError('Dwell cap must be an integer from 1 to 60 seconds');
    if (!accept(now)) return;
    record(now);
    cap = seconds;
    record(now);
  }

  return { update, stop, setCap };
}
