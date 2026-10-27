'use strict';

const MAX_NAME_LENGTH = 20;
function normalizeName(raw) {
  if (typeof raw !== 'string') return { error: 'Name is required.' };
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'Name is required.' };
  if (name.length > MAX_NAME_LENGTH) return { error: 'Name must be at most 20 characters.' };
  if (!/^[\p{L}\p{N} _.'-]+$/u.test(name)) return { error: 'Use letters, numbers, spaces or _ . - \'.' };
  return { name };
}
module.exports = { normalizeName, MAX_NAME_LENGTH };
