/**
 * The caller's mistakes, answered as such.
 *
 * Express and its parsers raise an error for a request they cannot read: a body that is
 * not JSON, one that is too large, a path with a broken %-escape ("/%E0%A4%A"). Each
 * carries a 4xx status of its own. Without this handler they fell through to the last one,
 * which answered 500 and logged a stack for what is a bad request.
 *
 * Nothing is logged here: the JSON parser attaches the raw body to its error, and on a
 * sign-in request that body holds a password.
 */
const MESSAGES = {
  400: 'Bad request',
  404: 'Not found',
  413: 'That request is too large',
  415: 'Unsupported content type',
};

function clientErrors(err, req, res, next) {
  if (!err) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: MESSAGES[413] });
  if (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
    return res.status(400).json({ error: 'The request body is not valid JSON' });
  }
  // A path that cannot be decoded (URIError from the router or from the static files).
  if (err instanceof URIError) return res.status(400).json({ error: 'That address is not valid' });
  // Any other error an Express component raised with a client status of its own.
  const status = Number(err.status || err.statusCode);
  if (err.expose === true && status >= 400 && status < 500) return res.status(status).json({ error: MESSAGES[status] || MESSAGES[400] });
  next(err);
}

module.exports = { clientErrors };
