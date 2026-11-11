
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const SESSION_SECRET = process.env.SESSION_SECRET;
const BUCKET = 'product-images';

const STATUSES = [
  'Enquiry received', 'Confirmed', 'Processing', 'Picked up',
  'Shipped', 'In transit', 'Out for delivery',
  'Delivery attempted', 'Delivered', 'Cancelled', 'Returned'
];

function json(statusCode, data, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders
    },
    body: JSON.stringify(data)
  };
}

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function cookieOptions() {
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=604800',
    ...(process.env.NODE_ENV === 'production' ? ['Secure'] : [])
  ].join('; ');
}

function makeToken(user) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    user,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
  })).toString('base64url');

  const input = `${header}.${payload}`;
  const signature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(input)
    .digest('base64url');

  return `${input}.${signature}`;
}

function getUser(event) {
  if (!SESSION_SECRET) return null;

  const cookieHeader = event.headers?.cookie || event.headers?.Cookie || '';
  const token = cookieHeader.match(/dicon_session=([^;]+)/)?.[1];

  if (!token) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const input = `${parts[0]}.${parts[1]}`;
    const expected = crypto
      .createHmac('sha256', SESSION_SECRET)
      .update(input)
      .digest();

    const actual = Buffer.from(parts[2], 'base64url');

    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    ) return null;

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload.user || null;
  } catch {
    return null;
  }
}

function getBody(event) {
  if (!event.body) return {};

  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;

    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function parseMultipart(event) {
  const contentType = event.headers?.['content-type'] ||
    event.headers?.['Content-Type'] || '';

  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundary) throw new Error('Invalid image upload.');

  const marker = Buffer.from(`--${boundary[1] || boundary[2]}`);
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64')
    : Buffer.from(event.body || '', 'utf8');

  const fields = {};
  let file = null;
  let cursor = 0;

  while (true) {
    const start = raw.indexOf(marker, cursor);
    if (start < 0) break;

    let partStart = start + marker.length;

    if (raw[partStart] === 45 && raw[partStart + 1] === 45) break;
    if (raw[partStart] === 13 && raw[partStart + 1] === 10) partStart += 2;

    const headerEnd = raw.indexOf(Buffer.from('\r\n\r\n'), partStart);
    if (headerEnd < 0) break;

    const headers = raw.slice(partStart, headerEnd).toString('utf8');
    const next = raw.indexOf(marker, headerEnd + 4);
    if (next < 0) break;

    let contentEnd = next;
    if (raw[contentEnd - 2] === 13 && raw[contentEnd - 1] === 10) {
      contentEnd -= 2;
    }

    const content = raw.slice(headerEnd + 4, contentEnd);
    const fieldName = headers.match(/name="([^"]+)"/i)?.[1];
    const filename = headers.match(/filename="([^"]*)"/i)?.[1];

    if (fieldName && filename) {
      const mime = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();

      if (content.length > 5 * 1024 * 1024) {
        throw new Error('Image must be smaller than 5 MB.');
      }

      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
        throw new Error('Only JPG, PNG and WEBP images are allowed.');
      }

      file = { buffer: content, mime, filename };
    } else if (fieldName) {
      fields[fieldName] = content.toString('utf8');
    }

    cursor = next;
  }

  return { fields, file };
}

function makeTracking() {
  return `DIC-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function dbError(result) {
  if (result.error) {
    console.error('Supabase error:', result.error.message);
    throw new Error('Database request failed. Please check the Supabase table columns.');
  }
  return result.data;
}

async function requireAdmin(event) {
  const user = getUser(event);
  return user?.role === 'admin' ? user : null;
}

async function sendNotifications(order) {
  const businessPhone = (process.env.BUSINESS_PHONE || '917737241466').replace(/\D/g, '');

  const message = [
    'New DICON AYURVEDA enquiry',
    `Tracking: ${order.tracking_code}`,
    `Product: ${order.product_name}`,
    `Qty: ${order.quantity}`,
    `Customer: ${order.customer_name}`,
    `Phone: ${order.phone}`,
    `Address: ${order.address}`
  ].join('\n');

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
    } catch (error) {
      console.error('WhatsApp notification failed:', error.message);
    }
  }

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.BUSINESS_EMAIL) {
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

  return businessPhone;
}

async function ensureAdmin() {
  const email = clean(process.env.ADMIN_EMAIL, 160).toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) return;

  const found = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (found.error) throw found.error;
  if (found.data) return;

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await supabase.from('users').insert({
    name: process.env.ADMIN_NAME || 'Store Admin',
    email,
    phone: process.env.BUSINESS_PHONE || '917737241466',
    password_hash: passwordHash,
    role: 'admin'
  });

  if (result.error) throw result.error;
}

exports.handler = async event => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY || !SESSION_SECRET) {
      return json(500, {
        error: 'Server configuration is incomplete. Check Netlify environment variables.'
      });
    }

    const method = event.httpMethod;
    let pathname = event.path || new URL(event.rawUrl).pathname;

    pathname = pathname
      .replace(/^\/\.netlify\/functions\/api/, '')
      .replace(/^\/api/, '') || '/';

    const user = getUser(event);
    const body = getBody(event);

    // PUBLIC CONFIG
    if (method === 'GET' && pathname === '/config') {
      return json(200, {
        businessName: process.env.BUSINESS_NAME || 'DICON AYURVEDA',
        phone: process.env.BUSINESS_PHONE || '917737241466'
      });
    }

    // PUBLIC PRODUCTS
    if (method === 'GET' && pathname === '/products') {
      const result = await supabase
        .from('products')
        .select('id,name,slug,description,price,compare_price,image')
        .eq('active', true)
        .order('created_at', { ascending: false });

      return json(200, await dbError(result) || []);
    }

    // CURRENT USER
    if (method === 'GET' && pathname === '/auth/me') {
      return json(200, { user: user || null });
    }

    // REGISTER
    if (method === 'POST' && pathname === '/auth/register') {
      const name = clean(body.name, 100);
      const email = clean(body.email, 160).toLowerCase();
      const phone = clean(body.phone, 20);
      const password = String(body.password || '');

      if (
        !name ||
        !/^\S+@\S+\.\S+$/.test(email) ||
        phone.replace(/\D/g, '').length < 10 ||
        password.length < 8
      ) {
        return json(400, {
          error: 'Enter valid details. Password must be at least 8 characters.'
        });
      }

      const password_hash = await bcrypt.hash(password, 12);

      const result = await supabase
        .from('users')
        .insert({ name, email, phone, password_hash, role: 'customer' })
        .select('id,name,email,phone,role')
        .single();

      if (result.error) {
        return json(409, {
          error: result.error.code === '23505'
            ? 'This email is already registered.'
            : 'Could not create account. Check your users table.'
        });
      }

      const token = makeToken(result.data);

      return json(200, { user: result.data }, {
        'Set-Cookie': `dicon_session=${token}; ${cookieOptions()}`
      });
    }
await ensureAdmin();
    // LOGIN
    if (method === 'POST' && pathname === '/auth/login') {
      const email = clean(body.email, 160).toLowerCase();
      const password = String(body.password || '');

      const result = await supabase
        .from('users')
        .select('id,name,email,phone,password_hash,role')
        .eq('email', email)
        .maybeSingle();

      if (result.error) throw result.error;

      if (
        !result.data ||
        !(await bcrypt.compare(password, result.data.password_hash))
      ) {
        return json(401, { error: 'Incorrect email or password.' });
      }

      const { password_hash, ...publicUser } = result.data;
      const token = makeToken(publicUser);

      return json(200, { user: publicUser }, {
        'Set-Cookie': `dicon_session=${token}; ${cookieOptions()}`
      });
    }

    // LOGOUT
    if (method === 'POST' && pathname === '/auth/logout') {
      return json(200, { ok: true }, {
        'Set-Cookie': 'dicon_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
      });
    }

    // CREATE ORDER ENQUIRY
    if (method === 'POST' && pathname === '/orders') {
      const customer_name = clean(body.name, 100);
      const phone = clean(body.phone, 25);
      const email = clean(body.email, 160);
      const address = clean(body.address, 500);
      const notes = clean(body.notes, 1000);
      const quantity = Math.max(1, Math.min(99, Number(body.quantity) || 1));
      const productId = body.productId;

      if (!customer_name || phone.replace(/\D/g, '').length < 10 || !address || !productId) {
        return json(400, { error: 'Please complete your name, valid phone, address and product.' });
      }

      const productResult = await supabase
        .from('products')
        .select('*')
        .eq('id', productId)
        .eq('active', true)
        .maybeSingle();

      const product = await dbError(productResult);

      if (!product) return json(400, { error: 'Selected product is unavailable.' });

      const tracking_code = makeTracking();

      const orderResult = await supabase
        .from('orders')
        .insert({
          tracking_code,
          user_id: user?.id || null,
          customer_name,
          phone,
          email: email || null,
          address,
          product_id: product.id,
          product_name: product.name,
          quantity,
          notes,
          total_amount: Number(product.price || 0) * quantity,
          status: 'Enquiry received'
        })
        .select('*')
        .single();

      const order = await dbError(orderResult);
      const businessPhone = await sendNotifications(order);

      return json(200, {
        ok: true,
        trackingCode: tracking_code,
        whatsappUrl: `https://wa.me/${businessPhone}?text=${encodeURIComponent(
          `Hello DICON AYURVEDA, I submitted an enquiry. My tracking ID is ${tracking_code}.`
        )}`
      });
    }

    // TRACK ORDER
    if (method === 'POST' && pathname === '/orders/track') {
      const code = clean(body.trackingCode, 40).toUpperCase();
      const phone = clean(body.phone, 25).replace(/\D/g, '');

      if (!code || phone.length < 10) {
        return json(400, { error: 'Enter tracking ID and the phone number used for the enquiry.' });
      }

      const result = await supabase
        .from('orders')
        .select('tracking_code,customer_name,product_name,quantity,status,courier,courier_tracking,tracking_url,tracking_note,shipped_at,created_at,updated_at,phone')
        .eq('tracking_code', code)
        .maybeSingle();

      const order = await dbError(result);

      if (!order || order.phone.replace(/\D/g, '').slice(-10) !== phone.slice(-10)) {
        return json(404, { error: 'No matching order found. Check your tracking ID and phone number.' });
      }

      delete order.phone;
      return json(200, order);
    }

    // CUSTOMER ORDERS
    if (method === 'GET' && pathname === '/orders/mine') {
      if (!user) return json(401, { error: 'Please sign in first.' });

      const result = await supabase
        .from('orders')
        .select('tracking_code,product_name,quantity,status,courier,courier_tracking,tracking_url,tracking_note,created_at,updated_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      return json(200, await dbError(result) || []);
    }

    // ADMIN ROUTES
    if (pathname.startsWith('/admin/')) {
      if (!user) return json(401, { error: 'Please sign in first.' });
      if (user.role !== 'admin') return json(403, { error: 'Admin access required.' });
    }

    // ADMIN: ALL ORDERS
    if (method === 'GET' && pathname === '/admin/orders') {
      const result = await supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(300);

      return json(200, await dbError(result) || []);
    }

    // ADMIN: UPDATE ORDER
    const updateMatch = pathname.match(/^\/admin\/orders\/([^/]+)$/);

    if (method === 'PATCH' && updateMatch) {
      const status = clean(body.status, 50);
      const courier = clean(body.courier, 100);
      const courier_tracking = clean(body.courierTracking, 200);
      const tracking_url = clean(body.trackingUrl, 500);
      const tracking_note = clean(body.trackingNote, 300);

      if (!STATUSES.includes(status)) return json(400, { error: 'Invalid order status.' });

      if (tracking_url && !/^https?:\/\//i.test(tracking_url)) {
        return json(400, { error: 'Tracking URL must start with http:// or https://.' });
      }

      const existingResult = await supabase
        .from('orders')
        .select('id,shipped_at')
        .eq('id', updateMatch[1])
        .maybeSingle();

      const existing = await dbError(existingResult);
      if (!existing) return json(404, { error: 'Order not found.' });

      const shipped = ['Picked up', 'Shipped', 'In transit', 'Out for delivery', 'Delivered'].includes(status);

      const result = await supabase
        .from('orders')
        .update({
          status,
          courier,
          courier_tracking,
          tracking_url,
          tracking_note,
          shipped_at: shipped ? (existing.shipped_at || new Date().toISOString()) : null,
          updated_at: new Date().toISOString()
        })
        .eq('id', updateMatch[1]);

      await dbError(result);
      return json(200, { ok: true });
    }

    // ADMIN: ADD PRODUCT (multipart form)
    if (method === 'POST' && pathname === '/admin/products') {
      const { fields, file } = parseMultipart(event);
      const name = clean(fields.name, 120);
      const description = clean(fields.description, 2000);
      const price = fields.price === '' || fields.price == null ? null : Number(fields.price);
      const compare_price = fields.comparePrice === '' || fields.comparePrice == null
        ? null : Number(fields.comparePrice);

      if (!name || !description ||
          (price !== null && (!Number.isFinite(price) || price < 0)) ||
          (compare_price !== null && (!Number.isFinite(compare_price) || compare_price < 0))) {
        return json(400, { error: 'Enter a product name, description and valid prices.' });
      }

      let image = '/uploads/diacare-front.jpeg';

      if (file) {
        const extension = file.mime === 'image/png' ? 'png' :
          file.mime === 'image/webp' ? 'webp' : 'jpg';

        const filename = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${extension}`;

        const uploadResult = await supabase.storage
          .from(BUCKET)
          .upload(filename, file.buffer, {
            contentType: file.mime,
            upsert: false
          });

        if (uploadResult.error) throw uploadResult.error;

        image = supabase.storage.from(BUCKET).getPublicUrl(filename).data.publicUrl;
      }

      const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;

      const result = await supabase
        .from('products')
        .insert({ name, slug, description, price, compare_price, image, active: true })
        .select('id')
        .single();

      return json(200, { id: (await dbError(result)).id });
    }

    // ADMIN: EDIT PRODUCT
    const productMatch = pathname.match(/^\/admin\/products\/([^/]+)$/);

    if (method === 'PUT' && productMatch) {
      const { fields, file } = parseMultipart(event);

      const existingResult = await supabase
        .from('products')
        .select('*')
        .eq('id', productMatch[1])
        .maybeSingle();

      const existing = await dbError(existingResult);
      if (!existing) return json(404, { error: 'Product not found.' });

      const name = clean(fields.name, 120);
      const description = clean(fields.description, 2000);
      const price = fields.price === '' || fields.price == null ? null : Number(fields.price);
      const compare_price = fields.comparePrice === '' || fields.comparePrice == null
        ? null : Number(fields.comparePrice);

      if (!name || !description ||
          (price !== null && (!Number.isFinite(price) || price < 0)) ||
          (compare_price !== null && (!Number.isFinite(compare_price) || compare_price < 0))) {
        return json(400, { error: 'Enter a valid product name, description and price.' });
      }

      let image = existing.image || existing.image_url || '/uploads/diacare-front.jpeg';

      if (file) {
        const extension = file.mime === 'image/png' ? 'png' :
          file.mime === 'image/webp' ? 'webp' : 'jpg';
        const filename = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${extension}`;

        const uploadResult = await supabase.storage
          .from(BUCKET)
          .upload(filename, file.buffer, { contentType: file.mime, upsert: false });

        if (uploadResult.error) throw uploadResult.error;

        image = supabase.storage.from(BUCKET).getPublicUrl(filename).data.publicUrl;
      }

      const result = await supabase
        .from('products')
        .update({ name, description, price, compare_price, image })
        .eq('id', productMatch[1]);

      await dbError(result);
      return json(200, { ok: true });
    }

    // ADMIN: REMOVE PRODUCT
    if (method === 'DELETE' && productMatch) {
      const result = await supabase
        .from('products')
        .update({ active: false })
        .eq('id', productMatch[1]);

      await dbError(result);
      return json(200, { ok: true });
    }

    return json(404, { error: 'API endpoint not found.' });

  } catch (error) {
    console.error('API error:', error);
    return json(500, { error: 'Something went wrong. Please check your Supabase configuration and table columns.' });
  }
};
