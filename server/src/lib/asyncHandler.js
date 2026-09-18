// Express 4 does not automatically catch a rejected promise thrown inside an async route handler — without
// this wrapper, a failed database query would leave the request hanging with no response instead of
// reaching index.js's global error handler. Wrap every route handler that awaits anything with this.
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
