# DICON AYURVEDA — Website + Admin + Order Tracking

A responsive storefront for DIACARE Herbal Powder, customer account registration/sign-in, order enquiries, private order tracking, and an admin dashboard for product and order management.

## Included
- Customer storefront with the supplied DIACARE front/back label photos.
- Product catalogue; admin can add products and remove products from the public store.
- Order enquiry form creates a unique tracking ID.
- Customer can track an enquiry using tracking ID + phone number.
- Customer account area and linked enquiry list.
- Admin login, enquiry list, order status updates, courier/AWB fields.
- Optional SMTP email and WhatsApp Cloud API notifications.
- SQLite database; persistent data stored in `data/` when deployed with Docker.

## Before going live
1. Confirm the business/product details, selling price, pack size, ingredients, directions, manufacturer/licence information, and return/shipping policies.
2. Have the applicable AYUSH/FSSAI/legal labelling and advertising requirements checked. The website intentionally avoids claims that DIACARE cures or treats diabetes.
3. Set a strong admin password and a long random `SESSION_SECRET` in `.env`.
4. Configure your domain and HTTPS reverse proxy (Nginx) before accepting customer details.
5. Configure email and WhatsApp Cloud API if you want automated outbound notifications. WhatsApp click-to-chat remains available without Cloud API.
6. Set up regular backups of `data/` and `public/uploads/`.

## Run locally
Requires Node.js 20+ and build tools for `better-sqlite3`.

```bash
cp .env.example .env
# Edit .env: set ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_SECRET, BUSINESS_PHONE
npm install
npm start
```

Open `http://localhost:3000` for the shop and `http://localhost:3000/admin` for admin. The admin account is created on first boot from `ADMIN_EMAIL` and `ADMIN_PASSWORD`. If you change these values later, update the admin account in the database or create a new admin via a controlled database migration; the environment variables do not reset an existing account.

## Deploy on your KVM VPS with Docker
Install Docker Engine + Docker Compose plugin on Ubuntu, then upload this folder to the VPS.

```bash
cp .env.example .env
nano .env
# Set a unique SESSION_SECRET, ADMIN_EMAIL, strong ADMIN_PASSWORD,
# BUSINESS_PHONE=917737241466 and BASE_URL=https://your-domain
mkdir -p data
sudo docker compose up -d --build
sudo docker compose logs -f
```

The app listens only on `127.0.0.1:3000`. Put Nginx in front and proxy to `http://127.0.0.1:3000`, then issue an SSL certificate with Certbot. Example Nginx location:

```nginx
server {
  server_name your-domain.in www.your-domain.in;
  client_max_body_size 6m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

After enabling HTTPS, keep `NODE_ENV=production`. The session cookie is then marked secure. If the site is behind Nginx and you use secure cookies, add `app.set('trust proxy', 1)` before session middleware in `server.js` (recommended for reverse proxy deployments).

## Email notifications
After creating a domain mailbox, set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, and `BUSINESS_EMAIL` in `.env`, then restart the service.

## WhatsApp notifications
For automatic business-side WhatsApp messages, create/configure a Meta WhatsApp Business Cloud API app and set `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`. The current implementation sends a plain text message to `BUSINESS_PHONE`; Meta production messaging rules/templates and recipient opt-in may apply. Without these credentials, customers can still open a prefilled WhatsApp message after submitting the enquiry.

## Important current behaviour
- Orders are enquiries until an admin marks them Confirmed; no online payment is collected.
- Price is intentionally blank / “Price shared on enquiry” until the business confirms the actual price.
- Customer accounts are optional. Guest enquiries can be tracked with tracking ID + the same phone number.
- Customer account order list includes enquiries submitted while signed in.
- Admin is created only when `ADMIN_EMAIL` is set at first startup.
