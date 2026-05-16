const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const http = require('http');
const WebSocket = require('ws');
const ExcelJS = require('exceljs');
const cron = require('node-cron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ====== إعداد قاعدة البيانات ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_key';
const EXCHANGE_API_KEY = process.env.EXCHANGE_API_KEY || '';

// ====== WebSocket ======
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ====== تسجيل الحركات Audit Log ======
async function logAction(client, user_id, action, table_name, record_id, old_data, new_data) {
  await client.query(
    'INSERT INTO audit_logs (user_id, action, table_name, record_id, old_data, new_data) VALUES ($1,$2,$3,$4,$5,$6)',
    [user_id, action, table_name, record_id, old_data? JSON.stringify(old_data) : null, new_data? JSON.stringify(new_data) : null]
  );
}

// ====== Middleware المصادقة ======
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'التوكن منتهي أو غير صالح' });
    req.user = user;
    next();
  });
};

// ====== تهيئة قاعدة البيانات ======
app.get('/init', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS branches (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        limit_amount NUMERIC DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT CHECK(role IN ('cashier', 'manager', 'super_admin', 'viewer')) NOT NULL,
        branch_id INT REFERENCES branches(id),
        max_transaction_amount NUMERIC DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        session_token TEXT,
        created_by INT REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS exchange_rates (
        id SERIAL PRIMARY KEY,
        currency TEXT UNIQUE NOT NULL,
        buy_min NUMERIC NOT NULL,
        buy_max NUMERIC NOT NULL,
        sell_min NUMERIC NOT NULL,
        sell_max NUMERIC NOT NULL,
        updated_by INT REFERENCES users(id),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS treasuries (
        id SERIAL PRIMARY KEY,
        branch_id INT REFERENCES branches(id),
        currency TEXT NOT NULL,
        balance NUMERIC DEFAULT 0,
        UNIQUE(branch_id, currency)
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        account_number TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        phone TEXT,
        id_number TEXT,
        allow_negative BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS account_balances (
        id SERIAL PRIMARY KEY,
        account_id INT REFERENCES accounts(id),
        currency TEXT NOT NULL,
        balance NUMERIC DEFAULT 0,
        UNIQUE(account_id, currency)
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id BIGSERIAL PRIMARY KEY,
        transaction_number BIGSERIAL UNIQUE,
        type TEXT CHECK(type IN ('buy', 'sell', 'deposit', 'withdraw', 'cancel')) NOT NULL,
        branch_id INT REFERENCES branches(id),
        user_id INT REFERENCES users(id),
        account_id INT REFERENCES accounts(id),
        currency TEXT NOT NULL,
        amount NUMERIC NOT NULL,
        rate NUMERIC NOT NULL,
        total_yer NUMERIC NOT NULL,
        notes TEXT,
        is_cancelled BOOLEAN DEFAULT FALSE,
        cancelled_by INT REFERENCES users(id),
        cancelled_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE SEQUENCE IF NOT EXISTS account_seq START 400000;
      

      CREATE TABLE IF NOT EXISTS transfers (
  id BIGSERIAL PRIMARY KEY,
  transfer_number BIGINT UNIQUE NOT NULL,
  type TEXT CHECK(type IN ('send', 'receive', 'other_company_pay', 'other_company_collect')) NOT NULL,
  branch_id INT REFERENCES branches(id),
  user_id INT REFERENCES users(id),
  sender_name TEXT,
  receiver_name TEXT,
  currency TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  fee NUMERIC DEFAULT 0,
  account_id INT REFERENCES accounts(id),
  status TEXT CHECK(status IN ('pending', 'received', 'expired', 'cancelled')) DEFAULT 'pending',
  notes TEXT,
  expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '7 days'),
  received_at TIMESTAMP,
  received_by INT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

      CREATE INDEX IF NOT EXISTS idx_transfer_number ON transfers(transfer_number);
      CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_branch ON transactions(branch_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);

      CREATE TABLE IF NOT EXISTS agents (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        location TEXT,
        can_send BOOLEAN DEFAULT FALSE,
        can_receive BOOLEAN DEFAULT FALSE,
        commission_type TEXT CHECK(commission_type IN ('fixed', 'percent', 'tiered')) DEFAULT 'fixed',
        commission_value NUMERIC DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS agent_commissions (
        id SERIAL PRIMARY KEY,
        agent_id INT REFERENCES agents(id),
        min_amount NUMERIC DEFAULT 0,
        max_amount NUMERIC DEFAULT 999,
        commission_type TEXT CHECK(commission_type IN ('fixed', 'percent')) NOT NULL,
        commission_value NUMERIC NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGSERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        action TEXT NOT NULL,
        table_name TEXT,
        record_id INT,
        old_data JSONB,
        new_data JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_by INT REFERENCES users(id),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS reconciliations (
        id BIGSERIAL PRIMARY KEY,
        reconciliation_number BIGSERIAL UNIQUE,
        branch_id INT REFERENCES branches(id),
        user_id INT REFERENCES users(id),
        currency TEXT NOT NULL,
        actual_balance NUMERIC NOT NULL,
        system_balance NUMERIC NOT NULL,
        difference NUMERIC NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      INSERT INTO users (id, name, password_hash, role)
      VALUES (1, 'admin', '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.u0FfR', 'super_admin')
      ON CONFLICT (id) DO NOTHING;
    `);
    res.json({ success: true, message: 'Database initialized. Default password is password' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====== المصادقة ======
app.post('/auth/login', async (req, res) => {
  const { name, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE name = $1 AND is_active = TRUE', [name]);
  if (result.rows.length === 0) return res.status(401).json({ error: 'اسم المستخدم غير صحيح' });

  const user = result.rows[0];
  const validPass = await bcrypt.compare(password, user.password_hash);
  if (!validPass) return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });

  if (user.session_token) {
    await pool.query('UPDATE users SET session_token = NULL WHERE id = $1', [user.id]);
  }

  const token = jwt.sign({ id: user.id, role: user.role, branch_id: user.branch_id }, JWT_SECRET, { expiresIn: '24h' });
  await pool.query('UPDATE users SET session_token = $1 WHERE id = $2', [token, user.id]);

  res.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, branch_id: user.branch_id, max_transaction_amount: user.max_transaction_amount }
  });
});

// ====== إدارة المستخدمين ======
app.get('/users/by-branch/:branch_id', authenticateToken, async (req, res) => {
  const { branch_id } = req.params;
  const result = await pool.query('SELECT id, name FROM users WHERE branch_id = $1 AND is_active = TRUE ORDER BY name', [branch_id]);
  res.json(result.rows);
});

app.get('/users', authenticateToken, async (req, res) => {
  if (req.user.role!== 'super_admin') return res.status(403).json({ error: 'غير مصرح' });
  const result = await pool.query(
    'SELECT u.id, u.name, u.role, u.branch_id, u.is_active, b.name as branch_name FROM users u LEFT JOIN branches b ON u.branch_id = b.id ORDER BY u.id'
  );
  res.json(result.rows);
});

app.post('/users', authenticateToken, async (req, res) => {
  if (req.user.role!== 'super_admin') return res.status(403).json({ error: 'غير مصرح' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { name, password, role, branch_id } = req.body;
    const password_hash = await bcrypt.hash(password, 10);
    const result = await client.query(
      'INSERT INTO users (name, password_hash, role, branch_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, password_hash, role, branch_id, req.user.id]
    );
    await logAction(client, req.user.id, 'CREATE_USER', 'users', result.rows[0].id, null, result.rows[0]);
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/users/:id/toggle', authenticateToken, async (req, res) => {
  if (req.user.role!== 'super_admin') return res.status(403).json({ error: 'غير مصرح' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    if (parseInt(id) === 1) return res.status(403).json({ error: 'لا يمكن إيقاف المدير العام' });
    const old = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    const result = await client.query('UPDATE users SET is_active = NOT is_active, session_token = NULL WHERE id = $1 RETURNING *', [id]);
    await logAction(client, req.user.id, 'TOGGLE_USER', 'users', id, old.rows[0], result.rows[0]);
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ====== إدارة الفروع ======
app.get('/branches', authenticateToken, async (req, res) => {
  const result = await pool.query('SELECT * FROM branches ORDER BY id');
  res.json(result.rows);
});

app.post('/branches', authenticateToken, async (req, res) => {
  if (req.user.role!== 'super_admin') return res.status(403).json({ error: 'غير مصرح' });
  const { name, limit_amount } = req.body;
  const result = await pool.query('INSERT INTO branches (name, limit_amount) VALUES ($1, $2) RETURNING *', [name, limit_amount]);
  res.json(result.rows[0]);
});

// ====== أسعار الصرف ======
app.get('/exchange-rates', authenticateToken, async (req, res) => {
  const result = await pool.query('SELECT * FROM exchange_rates ORDER BY currency');
  res.json(result.rows);
});

app.put('/exchange-rates/:currency', authenticateToken, async (req, res) => {
  if (!['super_admin', 'manager'].includes(req.user.role)) return res.status(403).json({ error: 'غير مصرح' });
  const { currency } = req.params;
  const { buy_min, buy_max, sell_min, sell_max } = req.body;
  const result = await pool.query(
    `INSERT INTO exchange_rates (currency, buy_min, buy_max, sell_min, sell_max, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (currency) DO UPDATE SET buy_min = $2, buy_max = $3, sell_min = $4, sell_max = $5, updated_by = $6, updated_at = NOW()
     RETURNING *`,
    [currency, buy_min, buy_max, sell_min, sell_max, req.user.id]
  );
  broadcast({ type: 'RATE_UPDATED', data: result.rows[0] });
  res.json(result.rows[0]);
});

// ====== أسعار الصرف التلقائية ======
async function updateExchangeRatesAuto() {
  if (!EXCHANGE_API_KEY) return;
  try {
    const res = await axios.get(`https://v6.exchangerate-api.com/v6/${EXCHANGE_API_KEY}/latest/USD`);
    const rates = res.data.conversion_rates;
    const currencies = ['SAR', 'AED', 'EUR', 'GBP'];
    for (let cur of currencies) {
      const rate = rates[cur];
      if (rate) {
        await pool.query(
          `INSERT INTO exchange_rates (currency, buy_min, buy_max, sell_min, sell_max, updated_by)
           VALUES ($1, $2, $3, $4, $5, 1)
           ON CONFLICT (currency) DO UPDATE SET buy_min = $2, buy_max = $3, sell_min = $4, sell_max = $5, updated_at = NOW()`,
          [cur, rate * 0.98, rate * 1.02, rate * 0.98, rate * 1.02]
        );
      }
    }
    broadcast({ type: 'RATE_UPDATED', message: 'تم تحديث الأسعار تلقائياً' });
  } catch (err) {
    console.log('Exchange rate update failed:', err.message);
  }
}
cron.schedule('0 *', updateExchangeRatesAuto);

// ====== العمليات المالية ======
app.post('/transactions/buy', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { currency, amount, rate, notes } = req.body;
    const branch_id = req.user.branch_id;
    const user_id = req.user.id;
    const total_yer = amount * rate;

    const user = await client.query('SELECT max_transaction_amount FROM users WHERE id = $1', [user_id]);
    if (user.rows[0].max_transaction_amount > 0 && total_yer > user.rows[0].max_transaction_amount) {
      throw new Error('تجاوزت سقف العملية المسموح. يحتاج موافقة المدير');
    }

    const rateCheck = await client.query('SELECT buy_min, buy_max FROM exchange_rates WHERE currency = $1', [currency]);
    if (!rateCheck.rows[0]) throw new Error('العملة غير موجودة');
    if (rate < rateCheck.rows[0].buy_min || rate > rateCheck.rows[0].buy_max) {
      throw new Error('السعر خارج النطاق المسموح');
    }

    const transResult = await client.query(
      'INSERT INTO transactions (type, branch_id, user_id, currency, amount, rate, total_yer, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      ['buy', branch_id, user_id, currency, amount, rate, total_yer, notes]
    );

    await client.query('INSERT INTO treasuries (branch_id, currency, balance) VALUES ($1, $2, $3) ON CONFLICT (branch_id, currency) DO UPDATE SET balance = treasuries.balance + $3', [branch_id, currency, amount]);
    await client.query('INSERT INTO treasuries (branch_id, currency, balance) VALUES ($1, $2, $3) ON CONFLICT (branch_id, currency) DO UPDATE SET balance = treasuries.balance - $3', [branch_id, 'YER', total_yer]);

    await logAction(client, user_id, 'BUY', 'transactions', transResult.rows[0].id, null, transResult.rows[0]);
    await client.query('COMMIT');
    broadcast({ type: 'NEW_TRANSACTION', data: transResult.rows[0] });
    res.json({ success: true, transaction: transResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/transactions/sell', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { currency, amount, rate, notes } = req.body;
    const branch_id = req.user.branch_id;
    const user_id = req.user.id;
    const total_yer = amount * rate;

    const treasuryCheck = await client.query('SELECT balance FROM treasuries WHERE branch_id = $1 AND currency = $2 FOR UPDATE', [branch_id, currency]);
    if (!treasuryCheck.rows[0] || treasuryCheck.rows[0].balance < amount) {
      throw new Error('رصيد الخزينة لا يكفي');
    }

    const transResult = await client.query(
      'INSERT INTO transactions (type, branch_id, user_id, currency, amount, rate, total_yer, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      ['sell', branch_id, user_id, currency, amount, rate, total_yer, notes]
    );

    await client.query('UPDATE treasuries SET balance = balance - $1 WHERE branch_id = $2 AND currency = $3', [amount, branch_id, currency]);
    await client.query('UPDATE treasuries SET balance = balance + $1 WHERE branch_id = $2 AND currency = $3', [total_yer, branch_id, 'YER']);

    await logAction(client, user_id, 'SELL', 'transactions', transResult.rows[0].id, null, transResult.rows[0]);
    await client.query('COMMIT');
    broadcast({ type: 'NEW_TRANSACTION', data: transResult.rows[0] });
    res.json({ success: true, transaction: transResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/transactions', authenticateToken, async (req, res) => {
  const { branch_id, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  let query = 'SELECT t.*, u.name as user_name FROM transactions t LEFT JOIN users u ON t.user_id = u.id WHERE t.is_cancelled = FALSE';
  const params = [];
  if (branch_id) { query += ' AND t.branch_id = $1'; params.push(branch_id); }
  if (req.user.role === 'cashier') { query += ' AND t.user_id = $1'; params.push(req.user.id); }
  query += ' ORDER BY t.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
  params.push(limit, offset);
  const result = await pool.query(query, params);
  res.json(result.rows);
});

// ====== إلغاء عملية ======
app.post('/transactions/:id/cancel', authenticateToken, async (req, res) => {
  if (!['super_admin', 'manager'].includes(req.user.role)) return res.status(403).json({ error: 'غير مصرح' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const trans = await client.query('SELECT * FROM transactions WHERE id = $1 AND is_cancelled = FALSE FOR UPDATE', [id]);
    if (trans.rows.length === 0) throw new Error('العملية غير موجودة أو ملغية مسبقاً');

    const t = trans.rows[0];
    if (t.type === 'buy') {
      await client.query('UPDATE treasuries SET balance = balance - $1 WHERE branch_id = $2 AND currency = $3', [t.amount, t.branch_id, t.currency]);
      await client.query('UPDATE treasuries SET balance = balance + $1 WHERE branch_id = $2 AND currency = $3', [t.total_yer, t.branch_id, 'YER']);
    }
    if (t.type === 'sell') {
      await client.query('UPDATE treasuries SET balance = balance + $1 WHERE branch_id = $2 AND currency = $3', [t.amount, t.branch_id, t.currency]);
      await client.query('UPDATE treasuries SET balance = balance - $1 WHERE branch_id = $2 AND currency = $3', [t.total_yer, t.branch_id, 'YER']);
    }

    const cancelTrans = await client.query(
      'INSERT INTO transactions (type, branch_id, user_id, currency, amount, rate, total_yer, notes, is_cancelled, cancelled_by, cancelled_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,NOW()) RETURNING *',
      ['cancel', t.branch_id, req.user.id, t.currency, t.amount, t.rate, t.total_yer, `إلغاء عملية ${t.id}`, req.user.id]
    );

    await client.query('UPDATE transactions SET is_cancelled = TRUE, cancelled_by = $1, cancelled_at = NOW() WHERE id = $2', [req.user.id, id]);
    await logAction(client, req.user.id, 'CANCEL_TRANSACTION', 'transactions', id, t, cancelTrans.rows[0]);

    await client.query('COMMIT');
    broadcast({ type: 'TRANSACTION_CANCELLED', data: cancelTrans.rows[0] });
    res.json({ success: true, transaction: cancelTrans.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ====== الحسابات ======
app.post('/accounts', authenticateToken, async (req, res) => {
  const { name, phone, id_number, allow_negative } = req.body;
  const result = await pool.query(
    'INSERT INTO accounts (account_number, name, phone, id_number, allow_negative) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    ['400' + Math.floor(Math.random() * 900000 + 100000), name, phone, id_number, allow_negative]
  );
  res.json(result.rows[0]);
});

app.get('/accounts/search', authenticateToken, async (req, res) => {
  const { q } = req.query;
  const result = await pool.query(
    'SELECT a.*, json_agg(json_build_object(\'currency\', ab.currency, \'balance\', ab.balance)) as balances FROM accounts a LEFT JOIN account_balances ab ON a.id = ab.account_id WHERE a.is_active = TRUE AND (a.name ILIKE $1 OR a.account_number = $1) GROUP BY a.id LIMIT 20',
    [`%${q}%`]
  );
  res.json(result.rows);
});

app.post('/accounts/deposit', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { account_id, currency, amount, depositor_name } = req.body;
    await client.query(
      'INSERT INTO account_balances (account_id, currency, balance) VALUES ($1, $2, $3) ON CONFLICT (account_id, currency) DO UPDATE SET balance = account_balances.balance + $3',
      [account_id, currency, amount]
    );
    const transResult = await client.query(
      'INSERT INTO transactions (type, branch_id, user_id, account_id, currency, amount, rate, total_yer, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
      ['deposit', req.user.branch_id, req.user.id, account_id, currency, amount, 1, amount, `إيداع من: ${depositor_name}`]
    );
    await logAction(client, req.user.id, 'DEPOSIT', 'transactions', transResult.rows[0].id, null, transResult.rows[0]);
    await client.query('COMMIT');
    res.json({ success: true, transaction: transResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/accounts/withdraw', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { account_id, currency, amount, receiver_name } = req.body;
    await client.query('UPDATE account_balances SET balance = balance - $1 WHERE account_id = $2 AND currency = $3', [amount, account_id, currency]);
    const transResult = await client.query(
      'INSERT INTO transactions (type, branch_id, user_id, account_id, currency, amount, rate, total_yer, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
      ['withdraw', req.user.branch_id, req.user.id, account_id, currency, amount, 1, amount, `صرف لـ: ${receiver_name}`]
    );
    await logAction(client, req.user.id, 'WITHDRAW', 'transactions', transResult.rows[0].id, null, transResult.rows[0]);
    await client.query('COMMIT');
    res.json({ success: true, transaction: transResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ====== الحوالات ======
app.post('/transfers/send', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { sender_name, receiver_name, currency, amount, fee, notes } = req.body;

    // توليد رقم عشوائي 6 أرقام يبدأ بـ 77
    let transfer_number;
    let exists = true;
    while (exists) {
      transfer_number = parseInt('77' + Math.floor(1000 + Math.random() * 9000));
      const check = await client.query('SELECT 1 FROM transfers WHERE transfer_number = $1', [transfer_number]);
      exists = check.rows.length > 0;
    }

    const transferResult = await client.query(
      'INSERT INTO transfers (transfer_number, type, branch_id, user_id, sender_name, receiver_name, currency, amount, fee, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
      [transfer_number, 'send', req.user.branch_id, req.user.id, sender_name, receiver_name, currency, amount, fee, notes]
    );

    await logAction(client, req.user.id, 'SEND_TRANSFER', 'transfers', transferResult.rows[0].id, null, transferResult.rows[0]);
    await client.query('COMMIT');
    res.json({ success: true, transfer: transferResult.rows[0], transfer_number });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/transfers/receive', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { transfer_number, receiver_name } = req.body;
    const transferCheck = await client.query('SELECT * FROM transfers WHERE transfer_number = $1 FOR UPDATE', [transfer_number]);
    if (transferCheck.rows.length === 0) throw new Error('الحوالة غير موجودة');
    if (transferCheck.rows[0].status!== 'pending') throw new Error('الحوالة مستلمة أو منتهية');

    await client.query('UPDATE transfers SET status = $1, received_at = NOW(), received_by = $2, receiver_name = $3 WHERE id = $4', ['received', req.user.id, receiver_name, transferCheck.rows[0].id]);
    await logAction(client, req.user.id, 'RECEIVE_TRANSFER', 'transfers', transferCheck.rows[0].id, transferCheck.rows[0], { status: 'received' });
    await client.query('COMMIT');
    res.json({ success: true, message: 'تم استلام الحوالة' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/transfers/search/:number', authenticateToken, async (req, res) => {
  const { number } = req.params;
  const result = await pool.query('SELECT * FROM transfers WHERE transfer_number = $1', [number]);
  res.json(result.rows[0] || {});
});

app.get('/transfers/:number/qr', authenticateToken, async (req, res) => {
  const { number } = req.params;
  const result = await pool.query('SELECT * FROM transfers WHERE transfer_number = $1', [number]);
  if (!result.rows[0]) return res.status(404).json({ error: 'الحوالة غير موجودة' });
  const qrData = JSON.stringify({ number, amount: result.rows[0].amount, currency: result.rows[0].currency });
  const qrImage = await QRCode.toDataURL(qrData);
  res.json({ qr: qrImage });
});

// ====== Dashboard ======
app.get('/dashboard', authenticateToken, async (req, res) => {
  const branch_id = req.user.role === 'super_admin'? req.query.branch_id : req.user.branch_id;
  const stats = await pool.query(
    `SELECT
      COALESCE(SUM(CASE WHEN type = 'buy' THEN total_yer ELSE 0 END), 0) as buy_total,
      COALESCE(SUM(CASE WHEN type = 'sell' THEN total_yer ELSE 0 END), 0) as sell_total,
      COUNT(*) as transactions_count,
      (SELECT name FROM users WHERE id = (SELECT user_id FROM transactions WHERE branch_id = $1 ORDER BY created_at DESC LIMIT 1)) as last_cashier
     FROM transactions WHERE branch_id = $1 AND created_at >= CURRENT_DATE AND is_cancelled = FALSE`,
    [branch_id]
  );
  const treasury = await pool.query('SELECT currency, balance FROM treasuries WHERE branch_id = $1', [branch_id]);
  const recent = await pool.query('SELECT * FROM transactions WHERE branch_id = $1 AND is_cancelled = FALSE ORDER BY created_at DESC LIMIT 5', [branch_id]);
  res.json({ stats: stats.rows[0], treasury: treasury.rows, recent: recent.rows });
});

// ====== تصدير Excel ======
app.get('/export/transactions', authenticateToken, async (req, res) => {
  const result = await pool.query('SELECT * FROM transactions WHERE is_cancelled = FALSE ORDER BY created_at DESC LIMIT 5000');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('العمليات');
  worksheet.columns = [
    { header: 'رقم العملية', key: 'transaction_number' },
    { header: 'النوع', key: 'type' },
    { header: 'العملة', key: 'currency' },
    { header: 'المبلغ', key: 'amount' },
    { header: 'السعر', key: 'rate' },
    { header: 'المبلغ بالريال', key: 'total_yer' },
    { header: 'التاريخ', key: 'created_at' }
  ];
  worksheet.addRows(result.rows);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=transactions.xlsx');
  await workbook.xlsx.write(res);
  res.end();
});

// ====== النسخ الاحتياطي والاسترجاع ======
app.get('/backup', authenticateToken, async (req, res) => {
  if (req.user.role!== 'super_admin') return res.status(403).json({ error: 'غير مصرح' });
  const backupPath = `/tmp/backup_${Date.now()}.sql`;
  const cmd = `pg_dump ${process.env.DATABASE_URL} > ${backupPath}`;
  exec(cmd, (error) => {
    if (error) return res.status(500).json({ error: error.message });
    res.download(backupPath, 'backup.sql', () => {
      fs.unlinkSync(backupPath);
    });
  });
});

app.post('/restore', authenticateToken, async (req, res) => {
  if (req.user.role!== 'super_admin') return res.status(403).json({ error: 'غير مصرح' });
  res.json({ message: 'يحتاج multer لرفع ملف SQL. فعّلها إذا تبغى الاستعادة من الواجهة' });
});

// ====== Cron Job للحوالات المنتهية ======
cron.schedule('0 *', async () => {
  await pool.query("UPDATE transfers SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW()");
  console.log('Checked expired transfers');
});

server.listen(process.env.PORT || 3000, () => console.log('Server running on port', process.env.PORT || 3000));