const express = require('express'), { createClient } = require('@libsql/client');
const crypto = require('crypto'), path = require('path'), fs = require('fs');

// Local: file:chores.db. Hosted (Vercel): set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.
const db = createClient({ url: process.env.TURSO_DATABASE_URL || 'file:chores.db', authToken: process.env.TURSO_AUTH_TOKEN });
const TZ = process.env.APP_TZ || 'UTC';
const Q = async (s, a = []) => { const r = await db.execute({ sql: s, args: a }); return r.rows.map(x => Object.fromEntries(r.columns.map((c, i) => [c, x[i]]))); };
const one = async (s, a) => (await Q(s, a))[0];
const run = (s, a = []) => db.execute({ sql: s, args: a });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const A = fn => (q, r, n) => fn(q, r).catch(n);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT DEFAULT '🐻', username TEXT UNIQUE, pw TEXT, is_admin INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS epics(id INTEGER PRIMARY KEY, title TEXT NOT NULL, emoji TEXT DEFAULT '🧺');
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, title TEXT NOT NULL, notes TEXT DEFAULT '', points INTEGER DEFAULT 1,
  status TEXT DEFAULT 'new' CHECK(status IN('new','in_progress','done')), assignee_id INTEGER, epic_id INTEGER,
  recurring INTEGER DEFAULT 0, done_date TEXT, due TEXT);
CREATE TABLE IF NOT EXISTS rewards(id INTEGER PRIMARY KEY, title TEXT NOT NULL, emoji TEXT DEFAULT '🎁', period TEXT CHECK(period IN('week','month','quarter')), target INTEGER DEFAULT 30);
CREATE TABLE IF NOT EXISTS points_log(id INTEGER PRIMARY KEY, user_id INTEGER, task_id INTEGER, points INTEGER, day TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER);`;
const SEED = `
INSERT INTO epics(title,emoji) VALUES('Kitchen deep clean','🍳');
INSERT INTO tasks(title,points,epic_id) VALUES('Scrub the oven',8,1),('Wipe cupboards',5,1),('Mop the floor',4,1);
INSERT INTO tasks(title,points,recurring) VALUES('Feed the cat 🐱',2,1),('Water the plants',1,1);
INSERT INTO rewards(title,emoji,period,target) VALUES('Movie night pick','🎬','week',30),('Pizza dinner out','🍕','month',100),('Weekend trip','🏖️','quarter',300);`;
let ready;
const init = () => ready || (ready = (async () => {
  await db.executeMultiple(SCHEMA);
  const n = await one('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM tasks) t');
  if (!n.u && !n.t) await db.executeMultiple(SEED);
})().catch(e => { ready = null; throw e; }));

const app = express();
app.use(express.json());
const page = path.join(__dirname, 'public', 'index.html');
app.get('/', (q, r, n) => fs.existsSync(page) ? r.sendFile(page) : n());
app.use(express.static(path.join(__dirname, 'public')));

const hash = (p, s = crypto.randomBytes(16).toString('hex')) => s + ':' + crypto.scryptSync(p, s, 32).toString('hex');
const check = (p, h) => { const g = hash(p, h.split(':')[0]); return g.length === h.length && crypto.timingSafeEqual(Buffer.from(g), Buffer.from(h)); };
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const pub = u => u && { id: u.id, name: u.name, emoji: u.emoji, username: u.username, is_admin: u.is_admin };
const needSetup = async () => !(await one('SELECT 1 x FROM users WHERE username IS NOT NULL'));
const row = (t, id) => one(`SELECT * FROM ${t} WHERE id=?`, [id]);

app.use(async (q, r, n) => {
  try {
    await init();
    q.sid = (q.headers.cookie || '').match(/(?:^|;\s*)sid=(\w+)/)?.[1];
    q.user = q.sid && await one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?', [q.sid]);
    n();
  } catch (e) { n(e); }
});
const setCookie = (q, r, t) => r.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${q.secure || q.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);
const startSession = async (q, r, u) => {
  const t = crypto.randomBytes(24).toString('hex');
  await run('INSERT INTO sessions VALUES(?,?)', [t, u.id]);
  setCookie(q, r, t);
};
async function mkUser(b, admin) {
  if (!b.name?.trim() || !b.username?.trim() || (b.password || '').length < 4) throw fail(400, 'Please add a name, a username and a password of at least 4 characters');
  const x = await run('INSERT INTO users(name,emoji,username,pw,is_admin) VALUES(?,?,?,?,?)',
    [b.name.trim(), b.emoji || '🐻', b.username.trim().toLowerCase(), hash(b.password), admin ? 1 : 0]);
  return row('users', Number(x.lastInsertRowid));
}
app.get('/api/auth/me', A(async (q, r) => {
  if (q.user) setCookie(q, r, q.sid); // stay logged in: renew for another year on every visit
  r.json({ user: pub(q.user) || null, setup: await needSetup(), code: !!process.env.HOUSEHOLD_CODE });
}));
app.post('/api/auth/register', A(async (q, r) => {
  const first = await needSetup(), code = process.env.HOUSEHOLD_CODE; // first account = admin
  if (!first && code && String(q.body.code || '').trim() !== code) throw fail(403, 'That household code isn’t right');
  const u = await mkUser(q.body, first ? 1 : 0); await startSession(q, r, u); r.json(pub(u));
}));
app.post('/api/auth/login', A(async (q, r) => {
  const u = await one('SELECT * FROM users WHERE username=?', [String(q.body.username || '').trim().toLowerCase()]);
  if (!u || !u.pw || !check(String(q.body.password || ''), u.pw)) throw fail(401, 'Wrong username or password');
  await startSession(q, r, u); r.json(pub(u));
}));
app.post('/api/auth/logout', A(async (q, r) => {
  await run('DELETE FROM sessions WHERE token=?', [q.sid || '']);
  r.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0'); r.sendStatus(204);
}));
app.use('/api', (q, r, n) => q.user ? n() : r.status(401).json({ error: 'Please log in again' }));

app.get('/api/users', A(async (q, r) => r.json((await Q('SELECT * FROM users ORDER BY id')).map(pub))));
app.post('/api/users', A(async (q, r) => {
  if (!q.user.is_admin) throw fail(403, 'Only the admin can add people');
  r.json(pub(await mkUser(q.body, 0)));
}));
app.put('/api/users/:id', A(async (q, r) => {
  const id = +q.params.id, b = q.body, u = await row('users', id);
  if (!u) throw fail(404, 'Person not found');
  if (id !== q.user.id && !q.user.is_admin) throw fail(403, 'You can only edit your own profile');
  const s = { name: b.name?.trim() || u.name, emoji: b.emoji || u.emoji };
  if (b.username?.trim()) s.username = b.username.trim().toLowerCase();
  if (b.password) { if (b.password.length < 4) throw fail(400, 'Password needs at least 4 characters'); s.pw = hash(b.password); }
  const k = Object.keys(s);
  await run(`UPDATE users SET ${k.map(x => x + '=?')} WHERE id=?`, [...k.map(x => s[x]), id]);
  r.json(pub(await row('users', id)));
}));
app.delete('/api/users/:id', A(async (q, r) => {
  if (!q.user.is_admin) throw fail(403, 'Only the admin can remove people');
  const id = +q.params.id;
  if (id === q.user.id) throw fail(400, 'You can’t remove yourself');
  await run('DELETE FROM sessions WHERE user_id=?', [id]); await run('DELETE FROM points_log WHERE user_id=?', [id]);
  await run('UPDATE tasks SET assignee_id=NULL WHERE assignee_id=?', [id]); await run('DELETE FROM users WHERE id=?', [id]);
  r.sendStatus(204);
}));

function crud(name, table, cols, after, before) {
  app.get(`/api/${name}`, A(async (q, r) => {
    if (table === 'tasks') // recurring tasks come back fresh each new day
      await run(`UPDATE tasks SET status='new',done_date=NULL WHERE recurring=1 AND status!='new' AND (done_date IS NULL OR done_date<?)`, [today()]);
    r.json(await Q(`SELECT * FROM ${table} ORDER BY id`));
  }));
  app.post(`/api/${name}`, A(async (q, r) => {
    const c = cols.filter(k => k in q.body);
    const x = await run(`INSERT INTO ${table}(${c}) VALUES(${c.map(() => '?')})`, c.map(k => q.body[k]));
    r.json(await row(table, Number(x.lastInsertRowid)));
  }));
  app.put(`/api/${name}/:id`, A(async (q, r) => {
    const old = await row(table, q.params.id);
    if (!old) throw fail(404, 'Not found');
    const c = cols.filter(k => k in q.body);
    if (c.length) await run(`UPDATE ${table} SET ${c.map(k => k + '=?')} WHERE id=?`, [...c.map(k => q.body[k]), old.id]);
    if (after) await after(old, await row(table, old.id), q);
    r.json(await row(table, old.id));
  }));
  app.delete(`/api/${name}/:id`, A(async (q, r) => {
    if (before) await before(q.params.id);
    await run(`DELETE FROM ${table} WHERE id=?`, [q.params.id]); r.sendStatus(204);
  }));
}
crud('epics', 'epics', ['title', 'emoji'], null, id => run('DELETE FROM tasks WHERE epic_id=?', [id]));
crud('rewards', 'rewards', ['title', 'emoji', 'period', 'target']);
crud('tasks', 'tasks', ['title', 'notes', 'points', 'status', 'assignee_id', 'epic_id', 'recurring', 'due'], async (old, now, q) => {
  if (old.status === now.status) return;
  if (now.status === 'done') {
    await run('UPDATE tasks SET done_date=? WHERE id=?', [today(), now.id]);
    let who = now.assignee_id; // nobody assigned? whoever finishes it gets the points
    if (!who) { who = q.user.id; await run('UPDATE tasks SET assignee_id=? WHERE id=?', [who, now.id]); }
    await run('INSERT INTO points_log(user_id,task_id,points,day) VALUES(?,?,?,?)', [who, now.id, now.points, today()]);
  } else if (old.status === 'done') { // un-done: take the points back
    await run('UPDATE tasks SET done_date=NULL WHERE id=?', [now.id]);
    await run('DELETE FROM points_log WHERE id=(SELECT MAX(id) FROM points_log WHERE task_id=?)', [now.id]);
  }
});

// points per user this week (Mon start), month and quarter
app.get('/api/stats', A(async (q, r) => {
  const t = today(), d = new Date(t + 'T00:00:00Z'), mo = +t.slice(5, 7);
  const w = new Date(+d - ((d.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
  const qs = t.slice(0, 5) + String(mo - (mo - 1) % 3).padStart(2, '0') + '-01';
  const s = 'COALESCE(SUM(CASE WHEN l.day>=? THEN l.points END),0)';
  r.json(await Q(`SELECT u.id user_id, ${s} week, ${s} month, ${s} quarter FROM users u LEFT JOIN points_log l ON l.user_id=u.id GROUP BY u.id`, [w, t.slice(0, 8) + '01', qs]));
}));

app.use((e, q, r, n) => {
  const dup = /UNIQUE/.test(e.message), bad = /NOT NULL|CHECK/.test(e.message);
  r.status(e.status || (dup ? 409 : bad ? 400 : 500)).json({ error: e.status ? e.message
    : dup ? 'That username is already taken' : bad ? 'Please fill in all the required fields' : 'Something went wrong on the server' });
});
module.exports = app;
