export function createClock(start = 0) {
  let current = start;
  return {
    now() { return current; },
    set(value) { current = value; },
    advance(milliseconds) { current += milliseconds; },
  };
}

export function systemClock() {
  return {
    now() { return Date.now(); },
    set() {},
    advance() {},
  };
}
