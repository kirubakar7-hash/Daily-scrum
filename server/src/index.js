import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import './db.js';

import authRoutes from './routes/auth.js';
import teamRoutes from './routes/teams.js';
import userRoutes from './routes/users.js';
import scrumRoutes from './routes/scrum.js';
import leaderRoutes from './routes/leader.js';
import dashboardRoutes from './routes/dashboard.js';
import historyRoutes from './routes/history.js';
import auditRoutes from './routes/audit.js';
import searchRoutes from './routes/search.js';
import taskTypeRoutes from './routes/taskTypes.js';
import recurringTaskRoutes from './routes/recurringTasks.js';
import categoryRoutes from './routes/categories.js';
import mainTaskRoutes from './routes/mainTasks.js';
import requestRoutes from './routes/requests.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Refusing to start with wide-open CORS in production mirrors the JWT_SECRET check below — cheap
// insurance against shipping the wide-open dev default to a publicly reachable deploy by accident.
if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
  console.error('Refusing to start: set a real CORS_ORIGIN environment variable before running in production.');
  process.exit(1);
}

const app = express();
// CORS_ORIGIN lets a production deploy lock this down to its real domain (comma-separated for more than
// one). Left unset, this stays wide-open — fine for local dev, and harmless once frontend+backend share
// one origin (this same server serves the built frontend below), since same-origin calls don't need CORS.
const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) : true;
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// Minimal request logging so a production error can be matched back to the request that caused it —
// no library needed at this app's scale, just a short id, the route, and how long it took.
app.use((req, res, next) => {
  req.id = Math.random().toString(36).slice(2, 8);
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${req.id}] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'daily-scrum-monitoring' }));

app.use('/api/auth', authRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/users', userRoutes);
app.use('/api/scrum', scrumRoutes);
app.use('/api/leader', leaderRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/task-types', taskTypeRoutes);
app.use('/api/recurring-tasks', recurringTaskRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/main-tasks', mainTaskRoutes);
app.use('/api/requests', requestRoutes);

// In production this same server also serves the built React app, so the whole thing is one deployable
// unit with one URL. Locally, the frontend runs separately via Vite's own dev server instead, and this
// directory won't exist — the check just no-ops in that case.
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // Anything not already matched by an /api route or a real static file falls through to index.html,
  // so client-side routes (e.g. /history, /admin) work on a hard refresh instead of 404ing.
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((err, req, res, next) => {
  console.error(`[${req.id || '------'}]`, err);
  res.status(500).json({ error: 'Something went wrong on the server.', request_id: req.id });
});

export { app };

const PORT = process.env.PORT || 4000;
// Only binds a real port when this file is run directly (`node src/index.js`) — not when a test file
// imports `app` to drive it with an in-process HTTP client, which would otherwise fight over the port
// with a real running server (or a second test run) and leak an unclosed listener between test files.
// pathToFileURL handles the Windows drive-letter/backslash conversion correctly, unlike a manual string compare.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, () => {
    console.log(`Daily Scrum Monitoring API running on http://localhost:${PORT}`);
  });
}
