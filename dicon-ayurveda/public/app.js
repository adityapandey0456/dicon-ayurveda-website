
const $ = s => document.querySelector(s);

let products = [];
let selectedProduct = null;
let authMode = 'login';

async function api(url, opts = {}) {
  const r = await fetch(url, {
    credentials: 'same-origin',
    ...opts,
    headers: {
      ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(opts.headers || {})
    }
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) throw new Error(data.error || 'Request failed');

  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function safeUrl(value) {
  try {
    const url = new URL(value, window.location.origin);

    if (!['http:', 'https:'].includes(url.protocol)) return '';

    return esc(url.href);
  } catch {
    return '';
  }
}

function money(v) {
  return v == null
    ? 'Price shared on enquiry'
    : new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0
      }).format(v);
}

function openModal(id) {
  $('#' + id).classList.add('open');
}

function closeModal(id) {
  $('#' + id).classList.remove('open');
}

document.querySelectorAll('[data-close]').forEach(b => {
  b.addEventListener('click', () => closeModal(b.dataset.close));
});

document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', e => {
    if (e.target === m) m.classList.remove('open');
  });
});

$('#menuBtn').addEventListener('click', () => {
  $('nav').classList.toggle('show');
});

document.querySelectorAll('nav a').forEach(a => {
  a.addEventListener('click', () => $('nav').classList.remove('show'));
});

// PRODUCTS

async function loadProducts() {
  products = await api('/api/products');

  if (!products.length) return;

  selectedProduct = products[0];

  $('#productName').textContent = selectedProduct.name;
  $('#productDescription').textContent = selectedProduct.description;
  $('#productPrice').textContent = money(selectedProduct.price);
  $('#mainProductImage').src = selectedProduct.image;
  $('#orderProductId').value = selectedProduct.id;
}

document.querySelectorAll('.thumb').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.thumb').forEach(x => {
      x.classList.remove('active');
    });

    b.classList.add('active');
    $('#mainProductImage').src = b.dataset.image;
  });
});

// QUANTITY

$('#qtyMinus').onclick = () => {
  $('#quantity').value = Math.max(
    1,
    (Number($('#quantity').value) || 1) - 1
  );
};

$('#qtyPlus').onclick = () => {
  $('#quantity').value = Math.min(
    99,
    (Number($('#quantity').value) || 1) + 1
  );
};

// ORDER FORM

$('#orderBtn').onclick = () => {
  if (!selectedProduct) return;

  $('#orderForm').elements.quantity.value = $('#quantity').value;

  openModal('orderModal');
};

$('#orderForm').addEventListener('submit', async e => {
  e.preventDefault();

  const f = e.currentTarget;
  const d = Object.fromEntries(new FormData(f));

  $('#orderMessage').textContent = 'Submitting…';

  try {
    const r = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify(d)
    });

    const whatsappUrl = safeUrl(r.whatsappUrl);

    $('#orderMessage').innerHTML = `
      <div class="success">
        Enquiry submitted successfully!

        <br><br>
        Your tracking ID is:

        <br>
        <b>${esc(r.trackingCode)}</b>

        <br><br>
        Save this ID to check your order progress.

        ${
          whatsappUrl
            ? `<br><a class="text-link" href="${whatsappUrl}" target="_blank" rel="noopener noreferrer">Continue on WhatsApp →</a>`
            : ''
        }
      </div>
    `;

    f.reset();

  } catch (err) {
    $('#orderMessage').innerHTML = `
      <div class="error">${esc(err.message)}</div>
    `;
  }
});

// ORDER TRACKING

function renderTracking(o) {
  const status = esc(o.status || 'Enquiry received');

  const courierLink = o.tracking_url
    ? safeUrl(o.tracking_url)
    : '';

  return `
    <div class="status-card">

      <h3>${esc(o.product_name)}</h3>

      <p>
        <b>Tracking ID:</b>
        ${esc(o.tracking_code)}
      </p>

      <p>
        <b>Quantity:</b>
        ${esc(o.quantity)}
      </p>

      <p>
        <b>Order Status:</b>
        <span class="status-pill">${status}</span>
      </p>

      ${
        o.courier
          ? `<p><b>Courier Partner:</b> ${esc(o.courier)}</p>`
          : ''
      }

      ${
        o.courier_tracking
          ? `<p><b>AWB / Tracking Number:</b> ${esc(o.courier_tracking)}</p>`
          : ''
      }

      ${
        o.tracking_note
          ? `
            <div class="tracking-update">
              <b>Latest Delivery Update</b>
              <p>${esc(o.tracking_note)}</p>
            </div>
          `
          : ''
      }

      ${
        courierLink
          ? `
            <p>
              <a
                class="text-link"
                href="${courierLink}"
                target="_blank"
                rel="noopener noreferrer"
              >
                Track shipment on courier website →
              </a>
            </p>
          `
          : ''
      }

      <p>
        <small>
          Last updated:
          ${o.updated_at
            ? new Date(o.updated_at + 'Z').toLocaleString('en-IN')
            : 'Not available'}
        </small>
      </p>

    </div>
  `;
}

$('#trackForm').addEventListener('submit', async e => {
  e.preventDefault();

  const d = Object.fromEntries(new FormData(e.currentTarget));

  $('#trackResult').textContent = 'Checking your order…';

  try {
    const o = await api('/api/orders/track', {
      method: 'POST',
      body: JSON.stringify(d)
    });

    $('#trackResult').innerHTML = renderTracking(o);

  } catch (err) {
    $('#trackResult').innerHTML = `
      <div class="error">${esc(err.message)}</div>
    `;
  }
});

// CUSTOMER ACCOUNT

$('#accountBtn').onclick = () => {
  window.location.href = '/login';
};

document.querySelectorAll('[data-auth]').forEach(b => {
  b.onclick = () => {
    authMode = b.dataset.auth;

    document.querySelectorAll('[data-auth]').forEach(x => {
      x.classList.toggle('active', x === b);
    });

    $('#authTitle').textContent =
      authMode === 'login'
        ? 'Welcome back'
        : 'Create your account';

    $('#registerFields').hidden = authMode !== 'register';
    $('#authMessage').textContent = '';
  };
});

async function refreshAccount() {
  try {
    const r = await api('/api/auth/me');

    if (r.user) {
      $('#authTitle').textContent = `Hello, ${r.user.name}`;
      $('#authForm').hidden = true;

      const orders = await api('/api/orders/mine');

      $('#accountOrders').innerHTML = `
        <button class="btn btn-outline" id="logoutBtn">
          Sign out
        </button>

        <h3>Your Enquiries & Delivery Tracking</h3>

        ${
          orders.length
            ? orders.map(o => renderTracking(o)).join('')
            : 'No enquiries linked to this account yet.'
        }
      `;

      $('#logoutBtn').onclick = async () => {
        await api('/api/auth/logout', {
          method: 'POST'
        });

        $('#authForm').hidden = false;
        $('#accountOrders').innerHTML = '';
        $('#authTitle').textContent = 'Welcome back';
      };

    } else {
      $('#authForm').hidden = false;
      $('#accountOrders').innerHTML = '';
    }

  } catch (e) {
    $('#authForm').hidden = false;
  }
}

// LOGIN / REGISTER

$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();

  const d = Object.fromEntries(new FormData(e.currentTarget));

  try {
    await api(`/api/auth/${authMode}`, {
      method: 'POST',
      body: JSON.stringify(d)
    });

    $('#authMessage').textContent = 'Signed in successfully.';

    await refreshAccount();

  } catch (err) {
    $('#authMessage').innerHTML = `
      <div class="error">${esc(err.message)}</div>
    `;
  }
});

// FOOTER YEAR

$('#year').textContent = new Date().getFullYear();

// INITIALIZE

loadProducts().catch(e => console.error(e));
