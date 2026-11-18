
require('dotenv').config();

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const COOKIE_NAME = 'dicon_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'product-images';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const sessionSecret = process.env.SESSION_SECRET;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY environment variable.');
  process.exit(1);
}

if (!sessionSecret || sessionSecret.length < 32) {
  console.error('SESSION_SECRET must be set to a random value of at least 32 characters.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});

// MIDDLEWARE

app.disable('x-powered-by');

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR, { index: false }));

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

const upload = multer({
  storage: multer.memoryStorage(),
limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only JPG, PNG and WEBP images are allowed.'));
    }

    cb(null, true);
  }
});

// HELPERS

const clean = (value, max = 500) =>
  String(value ?? '').trim().slice(0, max);

const digits = value =>
  String(value ?? '').replace(/\D/g, '');

const publicUser = user => ({
  id: user.id,
  name: user.name,
  email: user.email,
  phone: user.phone || '',
  role: user.role || 'customer'
});

function signToken(payload) {
  const body = Buffer.from(JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  })).toString('base64url');

  const signature = crypto
    .createHmac('sha256', sessionSecret)
    .update(body)
    .digest('base64url');

  return `${body}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [body, signature] = parts;

  const expected = crypto
    .createHmac('sha256', sessionSecret)
    .update(body)
    .digest();

  let supplied;

  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }

  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8')
    );

    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';

  for (const part of header.split(';')) {
    const index = part.indexOf('=');

    if (index < 0) continue;

    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return '';
      }
    }
  }

  return '';
}

function setLoginCookie(res, user) {
  res.cookie(COOKIE_NAME, signToken(publicUser(user)), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000
  });
}

app.use((req, _res, next) => {
  req.user = verifyToken(readCookie(req, COOKIE_NAME));
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Please sign in first.'
    });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Please sign in first.'
    });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Admin access required.'
    });
  }

  next();
}

function makeTracking() {
  return `DIC-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function slugify(value) {
  return clean(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || `product-${Date.now()}`;
}

function mapProduct(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug || slugify(row.name || 'product'),
    description: row.description || '',
    price: row.price ?? null,
    compare_price: row.compare_price ?? row.comparePrice ?? null,
    image: row.image || row.image_url || '/uploads/diacare-front.jpeg'
  };
}

function mapOrder(row) {
  return {
    ...row,
    tracking_code: row.tracking_code,
    customer_name: row.customer_name,
    product_name: row.product_name || 'Product',
    courier_tracking: row.courier_tracking || null,
    tracking_url: row.tracking_url || null,
    tracking_note: row.tracking_note || null,
    shipped_at: row.shipped_at || null
  };
}

// SUPABASE DATABASE HELPERS

async function getProductById(id) {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('id', id)
    .eq('active', true)
    .maybeSingle();

  if (error) throw error;

  return data;
}

// SUPABASE STORAGE IMAGE UPLOAD

async function uploadProductImage(file) {
  if (!file) return null;

  const ext = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  }[file.mimetype];

  if (!ext) {
    throw new Error('Unsupported image type.');
  }

  const filename =
    `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;

  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(filename, file.buffer, {
      contentType: file.mimetype,
      upsert: false
    });

  if (error) throw error;

  const { data } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(filename);

  return data.publicUrl;
}

async function insertProduct(payload) {
  const { imageUrl, ...fields } = payload;

  let result = await supabase
    .from('products')
    .insert({
      ...fields,
      image: imageUrl
    })
    .select('id')
    .single();

  if (result.error && /image/i.test(result.error.message || '')) {
    result = await supabase
      .from('products')
      .insert({
        ...fields,
        image_url: imageUrl
      })
      .select('id')
      .single();
  }

  if (result.error) throw result.error;

  return result.data;
}

async function updateProductImage(id, payload) {
  const { imageUrl, ...fields } = payload;

  let result = await supabase
    .from('products')
    .update({
      ...fields,
      image: imageUrl
    })
    .eq('id', id);

  if (result.error && /image/i.test(result.error.message || '')) {
    result = await supabase
      .from('products')
      .update({
        ...fields,
        image_url: imageUrl
      })
      .eq('id', id);
  }

  if (result.error) throw result.error;
}

// DEFAULT PRODUCT

async function ensureDefaultProduct() {
  const { data, error } = await supabase
    .from('products')
    .select('id')
    .limit(1);

  if (error) throw error;

  if (data && data.length) return;

  await insertProduct({
    name: 'DIACARE Herbal Powder',
    slug: 'diacare-herbal-powder',
    description: 'An Ayurvedic herbal powder marketed for glucose-metabolism support. Please read the product label and consult a qualified healthcare professional before use. This product is not a substitute for prescribed diabetes treatment.',
    price: null,
    compare_price: null,
    active: true,
    imageUrl: '/uploads/diacare-front.jpeg'
  });

  console.log('Default DIACARE product created.');
}

// ADMIN INITIALIZATION

async function ensureAdmin() {
  const email = clean(process.env.ADMIN_EMAIL, 160).toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');

  if (!email || !password) {
    console.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set; admin account was not initialized.');
    return;
  }

  const { data: existing, error: lookupError } = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (lookupError) throw lookupError;

  if (existing) {
    console.log('Configured admin account already exists.');
    return;
  }

  const password_hash = await bcrypt.hash(password, 12);

  const { error } = await supabase
    .from('users')
    .insert({
      name: clean(process.env.ADMIN_NAME || 'Store Admin', 100),
      email,
      phone: clean(process.env.BUSINESS_PHONE || '917737241466', 25),
      password_hash,
      role: 'admin'
    });

  if (error) throw error;

  console.log('Initial admin account created.');
}

// PUBLIC BUSINESS CONFIGURATION

app.get('/api/config', (_req, res) => {
  res.json({
    businessName: process.env.BUSINESS_NAME || 'DICON AYURVEDA',
    phone: process.env.BUSINESS_PHONE || '917737241466'
  });
});

// PUBLIC PRODUCTS

app.get('/api/products', async (_req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('active', true)
      .order('id', { ascending: false });

    if (error) throw error;

    res.json((data || []).map(mapProduct));
  } catch (error) {
    next(error);
  }
});

// AUTHENTICATION

app.get('/api/auth/me', (req, res) => {
  res.json({
    user: req.user ? publicUser(req.user) : null
  });
});

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = clean(req.body.name, 100);
    const email = clean(req.body.email, 160).toLowerCase();
    const phone = clean(req.body.phone, 25);
    const password = String(req.body.password || '');

    if (
      !name ||
      !/^\S+@\S+\.\S+$/.test(email) ||
      digits(phone).length < 10 ||
      password.length < 8
    ) {
      return res.status(400).json({
        error: 'Enter valid details. Password must be at least 8 characters.'
      });
    }

    const password_hash = await bcrypt.hash(password, 12);

    const { data, error } = await supabase
      .from('users')
      .insert({
        name,
        email,
        phone,
        password_hash,
        role: 'customer'
      })
      .select('id,name,email,phone,role')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          error: 'This email is already registered.'
        });
      }

      throw error;
    }

    setLoginCookie(res, data);

    res.json({
      user: publicUser(data)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = clean(req.body.email, 160).toLowerCase();
    const password = String(req.body.password || '');

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (error) throw error;

    if (
      !user ||
      !user.password_hash ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      return res.status(401).json({
        error: 'Incorrect email or password.'
      });
    }

    setLoginCookie(res, user);

    res.json({
      user: publicUser(user)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });

  res.json({ ok: true });
});

// WHATSAPP AND EMAIL NOTIFICATIONS

async function sendNotifications(order) {
  const businessPhone = digits(
    process.env.BUSINESS_PHONE || '917737241466'
  );

  const message = [
    'New DICON AYURVEDA enquiry',
    `Tracking: ${order.tracking_code}`,
    `Product: ${order.product_name}`,
    `Qty: ${order.quantity}`,
    `Customer: ${order.customer_name}`,
    `Phone: ${order.phone}`,
    `Address: ${order.address}`
  ].join('\n');

  if (
    process.env.WHATSAPP_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID
  ) {
    try {
      const response = await fetch(
        `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: digits(process.env.WHATSAPP_NOTIFY_TO || businessPhone),
            type: 'text',
            text: { body: message }
          })
        }
      );

      if (!response.ok) {
        console.error('WhatsApp notification returned HTTP', response.status);
      }
    } catch (error) {
      console.error('WhatsApp notification failed:', error.message);
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
    } catch (error) {
      console.error('Email notification failed:', error.message);
    }
  }

  return { businessPhone };
}

// CREATE ORDER

app.post('/api/orders', async (req, res, next) => {
  try {
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

    if (
      !customer_name ||
      digits(phone).length < 10 ||
      !address ||
      !Number.isInteger(productId) ||
      productId < 1
    ) {
      return res.status(400).json({
        error: 'Please complete your name, valid phone, address and product.'
      });
    }

    const product = await getProductById(productId);

    if (!product) {
      return res.status(400).json({
        error: 'Selected product is not available.'
      });
    }

    const tracking_code = makeTracking();

    const orderPayload = {
      tracking_code,
      user_id: req.user?.id || null,
      customer_name,
      phone,
      email: email || null,
      address,
      product_id: product.id,
      product_name: product.name,
      quantity,
      notes: notes || null,
      status: 'Enquiry received'
    };

    const { data: order, error } = await supabase
      .from('orders')
      .insert(orderPayload)
      .select('*')
      .single();

    if (error) throw error;

    const notify = await sendNotifications(order);

    res.json({
      ok: true,
      trackingCode: tracking_code,
      whatsappUrl: `https://wa.me/${notify.businessPhone}?text=${encodeURIComponent(
        `Hello DICON AYURVEDA, I submitted an enquiry. My tracking ID is ${tracking_code}.`
      )}`
    });
  } catch (error) {
    next(error);
  }
});

// CUSTOMER ORDER TRACKING

app.post('/api/orders/track', async (req, res, next) => {
  try {
    const code = clean(req.body.trackingCode, 40).toUpperCase();
    const phone = digits(req.body.phone);

    if (!code || phone.length < 10) {
      return res.status(400).json({
        error: 'Enter tracking ID and the phone number used for the enquiry.'
      });
    }

    const { data, error } = await supabase
      .from('orders')
      .select(
        'tracking_code,customer_name,product_name,quantity,status,courier,courier_tracking,tracking_url,tracking_note,shipped_at,created_at,updated_at,phone'
      )
      .eq('tracking_code', code)
      .maybeSingle();

    if (error) throw error;

    if (!data || digits(data.phone).slice(-10) !== phone.slice(-10)) {
      return res.status(404).json({
        error: 'No matching order found. Check your tracking ID and phone number.'
      });
    }

    const result = mapOrder(data);
    delete result.phone;

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// CUSTOMER MY ORDERS

app.get('/api/orders/mine', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select(
        'tracking_code,product_name,quantity,status,courier,courier_tracking,tracking_url,tracking_note,created_at,updated_at'
      )
      .eq('user_id', req.user.id)
      .order('id', { ascending: false });

    if (error) throw error;

    res.json((data || []).map(mapOrder));
  } catch (error) {
    next(error);
  }
});

// ADMIN: GET ALL ORDERS

app.get('/api/admin/orders', requireAdmin, async (_req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('id', { ascending: false })
      .limit(300);

    if (error) throw error;

    res.json((data || []).map(mapOrder));
  } catch (error) {
    next(error);
  }
});

// ADMIN: UPDATE ORDER

app.patch('/api/admin/orders/:id', requireAdmin, async (req, res, next) => {
  try {
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

    const { data: existing, error: findError } = await supabase
      .from('orders')
      .select('id,shipped_at')
      .eq('id', orderId)
      .maybeSingle();

    if (findError) throw findError;

    if (!existing) {
      return res.status(404).json({
        error: 'Order not found.'
      });
    }

    const shippingStatuses = [
      'Picked up',
      'Shipped',
      'In transit',
      'Out for delivery',
      'Delivered'
    ];

    const shipped_at = shippingStatuses.includes(status)
      ? (existing.shipped_at || new Date().toISOString())
      : null;

    const { error } = await supabase
      .from('orders')
      .update({
        status,
        courier: courier || null,
        courier_tracking: courier_tracking || null,
        tracking_url: tracking_url || null,
        tracking_note: tracking_note || null,
        shipped_at,
        updated_at: new Date().toISOString()
      })
      .eq('id', orderId);

    if (error) throw error;

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ADMIN: ADD PRODUCT

app.post(
  '/api/admin/products',
  requireAdmin,
  upload.single('image'),
  async (req, res, next) => {
    try {
      const name = clean(req.body.name, 120);
      const description = clean(req.body.description, 2000);

      const price =
        req.body.price === '' || req.body.price == null
          ? null
          : Number(req.body.price);

      const compare =
        req.body.comparePrice === '' || req.body.comparePrice == null
          ? null
          : Number(req.body.comparePrice);

      if (
        !name ||
        !description ||
        (price !== null && (!Number.isFinite(price) || price < 0)) ||
        (compare !== null && (!Number.isFinite(compare) || compare < 0))
      ) {
        return res.status(400).json({
          error: 'Enter a product name and description, and valid prices.'
        });
      }

      const imageUrl =
        await uploadProductImage(req.file) ||
        '/uploads/diacare-front.jpeg';

      const payload = {
        name,
        slug: `${slugify(name)}-${Date.now()}`,
        description,
        price,
        compare_price: compare,
        active: true,
        imageUrl
      };

      const inserted = await insertProduct(payload);

      res.json({
        id: inserted.id
      });
    } catch (error) {
      next(error);
    }
  }
);

// ADMIN: EDIT PRODUCT

app.put(
  '/api/admin/products/:id',
  requireAdmin,
  upload.single('image'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({
          error: 'Invalid product ID.'
        });
      }

      const { data: current, error: findError } = await supabase
        .from('products')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (findError) throw findError;

      if (!current) {
        return res.status(404).json({
          error: 'Product not found.'
        });
      }

      const name = clean(req.body.name, 120);
      const description = clean(req.body.description, 2000);

      const price =
        req.body.price === '' || req.body.price == null
          ? null
          : Number(req.body.price);

      const compare =
        req.body.comparePrice === '' || req.body.comparePrice == null
          ? null
          : Number(req.body.comparePrice);

      if (
        !name ||
        !description ||
        (price !== null && (!Number.isFinite(price) || price < 0)) ||
        (compare !== null && (!Number.isFinite(compare) || compare < 0))
      ) {
        return res.status(400).json({
          error: 'Enter a product name, description and valid prices.'
        });
      }

      const imageUrl =
        await uploadProductImage(req.file) ||
        current.image ||
        current.image_url ||
        '/uploads/diacare-front.jpeg';

      await updateProductImage(id, {
        name,
        description,
        price,
        compare_price: compare,
        imageUrl
      });

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

// ADMIN: REMOVE PRODUCT

app.delete('/api/admin/products/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        error: 'Invalid product ID.'
      });
    }

    const { error } = await supabase
      .from('products')
      .update({ active: false })
      .eq('id', id);

    if (error) throw error;

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// PAGE ROUTES

app.get('/', (req, res) => {
  if (req.user) {
    return res.redirect(
      req.user.role === 'admin' ? '/admin' : '/account'
    );
  }

  res.sendFile(path.join(PUBLIC_DIR, 'portal.html'));
});

app.get('/portal', (req, res) => {
  if (req.user) {
    return res.redirect(
      req.user.role === 'admin' ? '/admin' : '/account'
    );
  }

  res.sendFile(path.join(PUBLIC_DIR, 'portal.html'));
});

app.get('/store', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/login', (req, res) => {
  if (req.user) {
    return res.redirect(
      req.user.role === 'admin' ? '/admin' : '/account'
    );
  }

  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/account', (req, res) => {
  if (!req.user) {
    return res.redirect('/login?role=customer');
  }

  if (req.user.role === 'admin') {
    return res.redirect('/admin');
  }

  res.sendFile(path.join(PUBLIC_DIR, 'account.html'));
});

app.get('/admin', (req, res) => {
  if (!req.user) {
    return res.redirect('/login?role=admin');
  }

  if (req.user.role !== 'admin') {
    return res.redirect('/account');
  }

  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// UNKNOWN PAGE

app.get('*', (_req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'portal.html'));
});

// ERROR HANDLER

app.use((err, _req, res, _next) => {
  console.error('Request error:', err);

  if (res.headersSent) return;

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'Image size must be less than 10 MB.'
    });
  }

  res.status(500).json({
    error: err.message || 'Something went wrong. Please try again.'
  });
});app.use((err, _req, res, _next) => {
  console.error('Request error:', err);

  if (res.headersSent) return;

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'Image size must be less than 10 MB.'
    });
  }

  res.status(500).json({
    error: err.message || 'Something went wrong. Please try again.'
  });
});

// START SERVER

async function start() {
  try {
    await ensureAdmin();
    await ensureDefaultProduct();

    app.listen(PORT, () => {
      console.log(`DICON AYURVEDA server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error(
      'Startup failed. Check Supabase connection and table columns:',
      error.message || error
    );

    process.exit(1);
  }
}

start();
