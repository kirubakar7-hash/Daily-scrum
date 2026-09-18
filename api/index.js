// Vercel serverless entry point. Vercel's Node runtime accepts a plain Express app as a request
// handler directly (no adapter package needed) — every existing route file, middleware, and the
// asyncHandler-wrapped error handling in server/src/index.js works completely unchanged. That file
// already guards its own app.listen() to only run when executed directly (`node src/index.js`), so
// importing `app` here for Vercel to call per-request never tries to bind a real port.
import { app } from '../server/src/index.js';

export default app;
