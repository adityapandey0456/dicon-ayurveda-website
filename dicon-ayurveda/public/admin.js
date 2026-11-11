
const $ = s => document.querySelector(s);

async function api(url, opts = {}) {
  const r = await fetch(url, {
    credentials: 'same-origin',
    ...opts,
    headers: {
      ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(opts.headers || {})
    }
  });

  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}

let orders = [], products = [];

const ORDER_STATUSES = [
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

$('#loginForm').onsubmit = async e => {
  e.preventDefault();

  const d = Object.fromEntries(new FormData(e.currentTarget));

  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(d)
    });

    await boot();
  } catch (err) {
    $('#loginMsg').textContent = err.message;
  }
};

async function boot() {
  const me = await api('/api/auth/me');

  if (!me.user || me.user.role !== 'admin') return;

  $('#loginPanel').hidden = true;
  $('#dashboard').hidden = false;

  await Promise.all([
    loadOrders(),
    loadProducts()
  ]);
}

async function loadOrders() {
  orders = await api('/api/admin/orders');

  $('#totalOrders').textContent = orders.length;

  $('#pendingOrders').textContent = orders.filter(o =>
    ['Enquiry received', 'Confirmed', 'Processing'].includes(o.status)
  ).length;

  $('#ordersBody').innerHTML = orders.map(o => `
    <tr>
      <td>
        <b>${esc(o.tracking_code)}</b>
        <br>
        <small>${new Date(o.created_at + 'Z').toLocaleDateString('en-IN')}</small>
      </td>

      <td>
        ${esc(o.customer_name)}
        <br>${esc(o.phone)}
        <br>${esc(o.email || '')}
        <br><small>${esc(o.address)}</small>
      </td>

      <td>
        ${esc(o.product_name)}
        <br>Qty: ${o.quantity}
        <br><small>${esc(o.notes || '')}</small>
      </td>

      <td>
        <select data-status="${o.id}">
          ${ORDER_STATUSES.map(s => `
            <option value="${s}" ${s === o.status ? 'selected' : ''}>
              ${s}
            </option>
          `).join('')}
        </select>
      </td>

      <td>
        <input
          data-courier="${o.id}"
          placeholder="Courier partner"
          value="${esc(o.courier || '')}"
        >

        <input
          data-track="${o.id}"
          placeholder="AWB / Tracking number"
          value="${esc(o.courier_tracking || '')}"
        >

        <input
          data-track-url="${o.id}"
          placeholder="Courier tracking URL"
          value="${esc(o.tracking_url || '')}"
        >

        <textarea
          data-track-note="${o.id}"
          placeholder="Latest location / delivery update"
          rows="2"
        >${esc(o.tracking_note || '')}</textarea>

        ${
          o.tracking_url
            ? `<a href="${safeUrl(o.tracking_url)}" target="_blank" rel="noopener noreferrer">Open tracking page</a>`
            : ''
        }
      </td>

      <td>
        <button class="btn btn-primary" data-save="${o.id}">
          Save Update
        </button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="6">No enquiries yet.</td></tr>';

  document.querySelectorAll('[data-save]').forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.save;

      const status = $(`[data-status="${id}"]`).value;
      const courier = $(`[data-courier="${id}"]`).value.trim();
      const courierTracking = $(`[data-track="${id}"]`).value.trim();
      const trackingUrl = $(`[data-track-url="${id}"]`).value.trim();
      const trackingNote = $(`[data-track-note="${id}"]`).value.trim();

      try {
        b.disabled = true;
        b.textContent = 'Saving...';

        await api(`/api/admin/orders/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status,
            courier,
            courierTracking,
            trackingUrl,
            trackingNote
          })
        });

        b.textContent = 'Saved';
        await loadOrders();

      } catch (err) {
        alert(err.message);
        b.disabled = false;
        b.textContent = 'Save Update';
      }
    };
  });
}

async function loadProducts() {
  products = await api('/api/products');

  $('#totalProducts').textContent = products.length;

  $('#productsList').innerHTML = products.map(p => `
    <div class="product-item">
      <img src="${esc(p.image)}" alt="">
      <div>
        <b>${esc(p.name)}</b>
        <br>
        ${p.price == null ? 'Price on enquiry' : '₹' + p.price}
      </div>
      <button class="btn btn-outline" data-remove="${p.id}">
        Remove
      </button>
    </div>
  `).join('') || 'No active products';

  document.querySelectorAll('[data-remove]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Remove this product from the website?')) return;

      try {
        await api(`/api/admin/products/${b.dataset.remove}`, {
          method: 'DELETE'
        });

        await loadProducts();
      } catch (err) {
        alert(err.message);
      }
    };
  });
}

$('#productForm').onsubmit = async e => {
  e.preventDefault();

  const f = new FormData(e.currentTarget);

  try {
    await api('/api/admin/products', {
      method: 'POST',
      body: f
    });

    $('#productMsg').textContent = 'Product added.';
    e.currentTarget.reset();

    await loadProducts();

  } catch (err) {
    $('#productMsg').textContent = err.message;
  }
};

document.querySelectorAll('[data-tab]').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('[data-tab]').forEach(x => {
      x.classList.toggle('active', x === b);
    });

    $('#ordersTab').hidden = b.dataset.tab !== 'orders';
    $('#productsTab').hidden = b.dataset.tab !== 'products';
  };
});

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

    if (!['http:', 'https:'].includes(url.protocol)) return '#';

    return esc(url.href);
  } catch {
    return '#';
  }
}

boot().catch(() => {});

document.getElementById("adminLogoutBtn")?.addEventListener("click", async () => {
  const button = document.getElementById("adminLogoutBtn");

  button.disabled = true;
  button.textContent = "Logging out...";

  try {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include"
    });

    if (!response.ok) {
      throw new Error("Logout failed");
    }

    window.location.href = "/login?role=admin";

  } catch (error) {
    console.error("Logout error:", error);
    button.disabled = false;
    button.textContent = "Logout";
    alert("Logout nahi ho paya. Please try again.");
  }
});
