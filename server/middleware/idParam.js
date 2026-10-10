/**
 * A route's :id must be a plain positive whole number.
 *
 * Anything else — "abc", "1.5", "1e3", "0x10", a number too long for the column — names a
 * record that does not exist. Without this check the value reaches Postgres, the cast
 * fails, and the caller gets a 500 for what is really a 404.
 *
 *   router.param('id', idParam('Alert not found'));
 */
const ID = /^[1-9]\d{0,8}$/; // up to 999,999,999: inside both INTEGER and BIGINT columns

// Pure: is this a usable record id? Accepts the string a URL gives or a whole number.
function isId(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 && value < 1e9;
  return typeof value === 'string' && ID.test(value);
}

function idParam(notFound = 'Not found') {
  return (req, res, next, value) => (isId(value) ? next() : res.status(404).json({ error: notFound }));
}

module.exports = { idParam, isId };
