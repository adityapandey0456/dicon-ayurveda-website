require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

const uploadDir = path.join(ROOT, 'public', 'uploads');
const dataDir = path.join(ROOT, 'data');

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.includes('replace-with')) {
  console.warn('WARNING: Set a unique SESSION_SECRET in .env before production use.');
}

// DATABASE
const db = new Database(path.join(dataDir, 'dicon.sqlite'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 email TEXT UNIQUE NOT NULL,
 phone TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'customer',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 slug TEXT UNIQUE NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 price REAL,
 compare_price REAL,
 image TEXT NOT NULL DEFAULT '/uploads/diacare-front.jpeg',
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 tracking_code TEXT UNIQUE NOT NULL,
 user_id INTEGER,
 customer_name TEXT NOT NULL,
 phone TEXT NOT NULL,
 email TEXT,
 address TEXT NOT NULL,
 product_id INTEGER,
 product_name TEXT NOT NULL,
 quantity INTEGER NOT NULL DEFAULT 1,
 notes TEXT,
 status TEXT NOT NULL DEFAULT 'Enquiry received',
 courier TEXT,
 courier_tracking TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id),
 FOREIGN KEY(product_id) REFERENCES products(id)
);
`);

// SAFE DATABASE MIGRATIONS
// Existing customer orders will not be deleted.

const orderColumns = db.prepare(
  'PRAGMA table_info(orders)'
).all().map(column => column.name);

if (!orderColumns.includes('tracking_url')) {
  db.exec('ALTER TABLE orders ADD COLUMN tracking_url TEXT');
}

if (!orderColumns.includes('tracking_note')) {
  db.exec('ALTER TABLE orders ADD COLUMN tracking_note TEXT');
}

if (!orderColumns.includes('shipped_at')) {
  db.exec('ALTER TABLE orders ADD COLUMN shipped_at TEXT');
}

// DEFAULT PRODUCT
const productCount = db.prepare(
  'SELECT COUNT(*) AS n FROM products'
).get().n;

if (!productCount) {
  db.prepare(`
    INSERT INTO products
    (name,slug,description,price,image,active)
    VALUES (?,?,?,?,?,1)
  `).run(
    'DIACARE Herbal Powder',
    'diacare-herbal-powder',
    'An Ayurvedic herbal powder marketed for glucose-metabolism support. Please read the product label and consult a qualified healthcare professional before use. This product is not a substitute for prescribed diabetes treatment.',
    null,
    '/uploads/diacare-front.jpeg'
  );
}

// ADMIN INITIALIZATION
const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

if (adminEmail && !db.prepare(
  'SELECT id FROM users WHERE email=?'
).get(adminEmail)) {

  const hash = bcrypt.hashSync(
    process.env.ADMIN_PASSWORD || 'ChangeThisStrongPassword123!',
    12
  );

  db.prepare(`
    INSERT INTO users (name,email,phone,password_hash,role)
    VALUES (?,?,?,?,?)
  `).run(
    process.env.ADMIN_NAME || 'Store Admin',
    adminEmail,
    process.env.BUSINESS_PHONE || '917737241466',
    hash,
    'admin'
  );
}

// MIDDLEWARE
app.disable('x-powered-by');

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new SQLiteStore({
    db: 'sessions.sqlite',
    dir: dataDir
  }),
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// Disable automatic index.html so "/" can show portal.html
app.use(express.static(path.join(ROOT, 'public'), { index: false }));

app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
}));

app.use('/api/orders', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
}));

// IMAGE UPLOAD
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    cb(
      null,
      `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${path.extname(file.originalname).toLowerCase()}`
    );
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype));
  }
});

// HELPERS
const publicUser = u => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: 'Please sign in first.'
    });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Admin access required.'
    });
  }
  next();
}

function clean(v, max = 500) {
  return String(v ?? '').trim().slice(0, max);
}

function makeTracking() {
  return `DIC-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

// CONFIG
app.get('/api/config', (_req, res) => {
  res.json({
    businessName: process.env.BUSINESS_NAME || 'DICON AYURVEDA',
    phone: process.env.BUSINESS_PHONE || '917737241466'
  });
});

// PRODUCTS
app.get('/api/products', (_req, res) => {
  const rows = db.prepare(`
    SELECT id,name,slug,description,price,compare_price,image
    FROM products
    WHERE active=1
    ORDER BY id DESC
  `).all();

  res.json(rows);
});

// AUTHENTICATION
app.get('/api/auth/me', (req, res) => {
  res.json({
    user: req.session.user || null
  });
});

app.post('/api/auth/register', async (req, res) => {
  const name = clean(req.body.name, 100);
  const email = clean(req.body.email, 160).toLowerCase();
  const phone = clean(req.body.phone, 20);
  const password = String(req.body.password || '');

  if (
    !name ||
    !/^\S+@\S+\.\S+$/.test(email) ||
    phone.replace(/\D/g, '').length < 10 ||
    password.length < 8
  ) {
    return res.status(400).json({
      error: 'Enter valid details. Password must be at least 8 characters.'
    });
  }

  try {
    const hash = await bcrypt.hash(password, 12);

    const info = db.prepare(`
      INSERT INTO users(name,email,phone,password_hash)
      VALUES(?,?,?,?)
    `).run(name, email, phone, hash);

    const u = db.prepare(
      'SELECT * FROM users WHERE id=?'
    ).get(info.lastInsertRowid);

    req.session.user = publicUser(u);

    res.json({
      user: req.session.user
    });

  } catch (e) {
    res.status(409).json({
      error: e.code === 'SQLITE_CONSTRAINT_UNIQUE'
        ? 'This email is already registered.'
        : 'Could not create account.'
    });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = clean(req.body.email, 160).toLowerCase();
  const password = String(req.body.password || '');

  const u = db.prepare(
    'SELECT * FROM users WHERE email=?'
  ).get(email);

  if (!u || !(await bcrypt.compare(password, u.password_hash))) {
    return res.status(401).json({
      error: 'Incorrect email or password.'
    });
  }

  req.session.user = publicUser(u);

  res.json({
    user: req.session.user
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// NOTIFICATIONS
async function sendNotifications(order) {
  const businessPhone = (
    process.env.BUSINESS_PHONE || '917737241466'
  ).replace(/\D/g, '');

  const message = `
New DICON AYURVEDA enquiry

Tracking: ${order.tracking_code}
Product: ${order.product_name}
Qty: ${order.quantity}
Customer: ${order.customer_name}
Phone: ${order.phone}
Address: ${order.address}
`;

  if (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    try {
      await fetch(
        `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: (process.env.WHATSAPP_NOTIFY_TO || businessPhone).replace(/\D/g, ''),
            type: 'text',
            text: { body: message }
          })
        }
      );
    } catch (e) {
      console.error('WhatsApp notification failed:', e.message);
    }
  }

  if (
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.BUSINESS_EMAIL
  ) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE) === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });

      await transporter.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: process.env.BUSINESS_EMAIL,
        subject: `New order enquiry ${order.tracking_code}`,
        text: message
      });

    } catch (e) {
      console.error('Email notification failed:', e.message);
    }
  }

  return {
    businessPhone,
    message
  };
}

// CREATE ORDER
app.post('/api/orders', async (req, res) => {
  const customer_name = clean(req.body.name, 100);
  const phone = clean(req.body.phone, 25);
  const email = clean(req.body.email, 160);
  const address = clean(req.body.address, 500);
  const notes = clean(req.body.notes, 1000);

  const quantity = Math.max(
    1,
    Math.min(99, Number(req.body.quantity) || 1)
  );

  const productId = Number(req.body.productId);

  const product = db.prepare(
    'SELECT * FROM products WHERE id=? AND active=1'
  ).get(productId);

  if (
    !customer_name ||
    phone.replace(/\D/g, '').length < 10 ||
    !address ||
    !product
  ) {
    return res.status(400).json({
      error: 'Please complete your name, valid phone, address and product.'
    });
  }

  const tracking_code = makeTracking();

  const info = db.prepare(`
    INSERT INTO orders(
      tracking_code,user_id,customer_name,phone,email,
      address,product_id,product_name,quantity,notes
    )
    VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    tracking_code,
    req.session.user?.id || null,
    customer_name,
    phone,
    email,
    address,
    product.id,
    product.name,
    quantity,
    notes
  );

  const order = db.prepare(
    'SELECT * FROM orders WHERE id=?'
  ).get(info.lastInsertRowid);

  const notify = await sendNotifications(order);

  res.json({
    ok: true,
    trackingCode: tracking_code,
    whatsappUrl: `https://wa.me/${notify.businessPhone}?text=${encodeURIComponent(
      `Hello DICON AYURVEDA, I submitted an enquiry. My tracking ID is ${tracking_code}.`
    )}`
  });
});

// CUSTOMER ORDER TRACKING
app.post('/api/orders/track', (req, res) => {
  const code = clean(req.body.trackingCode, 40).toUpperCase();
  const phone = clean(req.body.phone, 25).replace(/\D/g, '');

  if (!code || phone.length < 10) {
    return res.status(400).json({
      error: 'Enter tracking ID and the phone number used for the enquiry.'
    });
  }

  const order = db.prepare(`
    SELECT
      tracking_code,
      customer_name,
      product_name,
      quantity,
      status,
      courier,
      courier_tracking,
      tracking_url,
      tracking_note,
      shipped_at,
      created_at,
      updated_at
    FROM orders
    WHERE tracking_code=?
    AND REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'+','') LIKE ?
  `).get(code, `%${phone.slice(-10)}`);

  if (!order) {
    return res.status(404).json({
      error: 'No matching order found. Check your tracking ID and phone number.'
    });
  }

  res.json(order);
});

// CUSTOMER MY ORDERS
app.get('/api/orders/mine', requireAuth, (req, res) => {
  res.json(
    db.prepare(`
      SELECT
        tracking_code,
        product_name,
        quantity,
        status,
        courier,
        courier_tracking,
        tracking_url,
        tracking_note,
        created_at,
        updated_at
      FROM orders
      WHERE user_id=?
      ORDER BY id DESC
    `).all(req.session.user.id)
  );
});

// ADMIN: GET ALL ORDERS
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  res.json(
    db.prepare(
      'SELECT * FROM orders ORDER BY id DESC LIMIT 300'
    ).all()
  );
});

// ADMIN: UPDATE ORDER AND DELIVERY TRACKING
app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const orderId = Number(req.params.id);

  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({
      error: 'Invalid order ID.'
    });
  }

  const status = clean(req.body.status, 50);
  const courier = clean(req.body.courier, 100);
  const courier_tracking = clean(req.body.courierTracking, 200);
  const tracking_url = clean(req.body.trackingUrl, 500);
  const tracking_note = clean(req.body.trackingNote, 300);

  const allowed = [
    'Enquiry received',
    'Confirmed',
    'Processing',
    'Picked up',
    'Shipped',
    'In transit',
    'Out for delivery',
    'Delivery attempted',
    'Delivered',
    'Cancelled',
    'Returned'
  ];

  if (!allowed.includes(status)) {
    return res.status(400).json({
      error: 'Invalid order status.'
    });
  }

  if (tracking_url && !/^https?:\/\//i.test(tracking_url)) {
    return res.status(400).json({
      error: 'Tracking URL must start with http:// or https://.'
    });
  }

  const existing = db.prepare(
    'SELECT id,shipped_at FROM orders WHERE id=?'
  ).get(orderId);

  if (!existing) {
    return res.status(404).json({
      error: 'Order not found.'
    });
  }

  const shipped_at = [
    'Picked up',
    'Shipped',
    'In transit',
    'Out for delivery',
    'Delivered'
  ].includes(status)
    ? (existing.shipped_at || new Date().toISOString())
    : null;

  db.prepare(`
    UPDATE orders
    SET
      status=?,
      courier=?,
      courier_tracking=?,
      tracking_url=?,
      tracking_note=?,
      shipped_at=?,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    status,
    courier,
    courier_tracking,
    tracking_url,
    tracking_note,
    shipped_at,
    orderId
  );

  res.json({ ok: true });
});

// ADMIN: ADD PRODUCT
app.post('/api/admin/products', requireAdmin, upload.single('image'), (req, res) => {
  const name = clean(req.body.name, 120);
  const description = clean(req.body.description, 2000);
  const price = req.body.price === '' ? null : Number(req.body.price);
  const compare = req.body.comparePrice === '' ? null : Number(req.body.comparePrice);

  if (
    !name ||
    !description ||
    (price !== null && (!Number.isFinite(price) || price < 0))
  ) {
    return res.status(400).json({
      error: 'Enter a product name and description, and a valid price.'
    });
  }

  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now()}`;

  const image = req.file
    ? `/uploads/${req.file.filename}`
    : '/uploads/diacare-front.jpeg';

  const info = db.prepare(`
    INSERT INTO products(
      name,slug,description,price,compare_price,image,active
    )
    VALUES(?,?,?,?,?,?,1)
  `).run(name, slug, description, price, compare, image);

  res.json({
    id: info.lastInsertRowid
  });
});

// ADMIN: EDIT PRODUCT
app.put('/api/admin/products/:id', requireAdmin, upload.single('image'), (req, res) => {
  const p = db.prepare(
    'SELECT * FROM products WHERE id=?'
  ).get(Number(req.params.id));

  if (!p) {
    return res.status(404).json({
      error: 'Product not found.'
    });
  }

  const name = clean(req.body.name, 120);
  const description = clean(req.body.description, 2000);
  const price = req.body.price === '' ? null : Number(req.body.price);
  const compare = req.body.comparePrice === '' ? null : Number(req.body.comparePrice);

  const image = req.file
    ? `/uploads/${req.file.filename}`
    : p.image;

  if (!name || !description) {
    return res.status(400).json({
      error: 'Name and description are required.'
    });
  }

  db.prepare(`
    UPDATE products
    SET name=?,description=?,price=?,compare_price=?,image=?
    WHERE id=?
  `).run(name, description, price, compare, image, p.id);

  res.json({ ok: true });
});

// ADMIN: REMOVE PRODUCT
app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  db.prepare(
    'UPDATE products SET active=0 WHERE id=?'
  ).run(Number(req.params.id));

  res.json({ ok: true });
});

// COMMON LANDING PAGE: choose Admin or Customer
app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/account');
  }
  res.sendFile(path.join(ROOT, 'public', 'portal.html'));
});

app.get('/portal', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/account');
  }
  res.sendFile(path.join(ROOT, 'public', 'portal.html'));
});

// PUBLIC CUSTOMER STOREFRONT
app.get('/store', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

// COMMON LOGIN / REGISTER PAGE
app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/account');
  }
  res.sendFile(path.join(ROOT, 'public', 'login.html'));
});

// CUSTOMER DASHBOARD - CUSTOMER ONLY
app.get('/account', (req, res) => {
  if (!req.session.user) return res.redirect('/login?role=customer');
  if (req.session.user.role === 'admin') return res.redirect('/admin');
  res.sendFile(path.join(ROOT, 'public', 'account.html'));
});

// ADMIN DASHBOARD - ADMIN ONLY
app.get('/admin', (req, res) => {
  if (!req.session.user) return res.redirect('/login?role=admin');
  if (req.session.user.role !== 'admin') return res.redirect('/account');
  res.sendFile(path.join(ROOT, 'public', 'admin.html'));
});

// Unknown page fallback
app.get('*', (_req, res) => {
  res.status(404).sendFile(path.join(ROOT, 'public', 'portal.html'));
});

// ERROR HANDLER
app.use((err, _req, res, _next) => {
  console.error(err);

  res.status(500).json({
    error: 'Something went wrong. Please try again.'
  });
});

// START SERVER
app.listen(PORT, () => {
  console.log(`DICON AYURVEDA running on http://localhost:${PORT}`);
});