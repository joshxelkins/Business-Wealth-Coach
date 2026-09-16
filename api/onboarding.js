const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_TO_EMAIL = 'josh@businesswealthcoach.uk';
const DEFAULT_FROM_EMAIL = 'Business Wealth Coach <onboarding@businesswealthcoach.uk>';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://business-wealth-coach.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function clean(value, max = 2000) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().slice(0, max);
}

function escapeHtml(value) {
  return clean(value, 4000)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br>');
}

function parseUrlEncoded(body) {
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(req.body);

  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function normalisePayload(payload, contentType) {
  if (payload && typeof payload === 'object' && !Buffer.isBuffer(payload)) return payload;
  const body = String(payload || '');
  if (contentType.includes('application/json')) return JSON.parse(body || '{}');
  return parseUrlEncoded(body);
}

function required(data, field, label) {
  const value = clean(data[field], 4000);
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function buildEmail(data) {
  const rows = [
    ['Name', data.name],
    ['Email', data.email],
    ['WhatsApp number', data.whatsapp || 'Not provided'],
    ['Business name', data.business],
    ['Business type', data.businessType],
    ['Package interest', data.package],
    ['Current turnover', data.turnover || 'Not provided'],
    ['What they want help with', data.priority],
  ];

  const tableRows = rows.map(([label, value]) => `
    <tr>
      <th align="left" style="padding:10px 12px;border-bottom:1px solid #222;color:#12dfe3;width:180px;vertical-align:top;">${escapeHtml(label)}</th>
      <td style="padding:10px 12px;border-bottom:1px solid #222;color:#f7f7f7;vertical-align:top;">${escapeHtml(value)}</td>
    </tr>`).join('');

  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#050505;color:#fff;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:720px;margin:0 auto;padding:32px;">
      <p style="color:#f43c7b;font-size:12px;letter-spacing:.18em;text-transform:uppercase;font-weight:700;">New onboarding</p>
      <h1 style="font-size:30px;line-height:1.1;margin:0 0 20px;">Business Wealth Coach onboarding received</h1>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#0b0b0b;border:1px solid #222;border-radius:12px;overflow:hidden;">
        ${tableRows}
      </table>
    </div>
  </body>
</html>`;

  const text = rows.map(([label, value]) => `${label}: ${clean(value, 4000)}`).join('\n');
  return { html, text };
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, message: 'Method not allowed.' });
  }

  try {
    const contentType = req.headers['content-type'] || '';
    const rawPayload = await readBody(req);
    const payload = normalisePayload(rawPayload, contentType);

    if (clean(payload.website)) {
      return json(res, 200, { ok: true });
    }

    const data = {
      name: required(payload, 'name', 'Name'),
      email: required(payload, 'email', 'Email address'),
      whatsapp: clean(payload.whatsapp, 100),
      business: required(payload, 'business', 'Business name'),
      businessType: required(payload, 'businessType', 'Business type'),
      package: clean(payload.package, 100) || 'Not sure yet',
      turnover: clean(payload.turnover, 200),
      priority: required(payload, 'priority', 'What you want help with'),
    };

    if (!/^\S+@\S+\.\S+$/.test(data.email)) {
      return json(res, 400, { ok: false, message: 'Please enter a valid email address.' });
    }

    if (!process.env.RESEND_API_KEY) {
      return json(res, 500, { ok: false, message: 'Email service is not configured yet.' });
    }

    const { html, text } = buildEmail(data);
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || DEFAULT_FROM_EMAIL,
        to: [process.env.ONBOARDING_TO_EMAIL || DEFAULT_TO_EMAIL],
        reply_to: data.email,
        subject: `New BWC onboarding: ${data.name} - ${data.business}`,
        html,
        text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Resend onboarding email failed:', error);
      return json(res, 502, { ok: false, message: 'The form could not be sent. Please try again or message on WhatsApp.' });
    }

    const acceptsHtml = String(req.headers.accept || '').includes('text/html') && !contentType.includes('application/json');
    if (acceptsHtml) {
      res.statusCode = 303;
      res.setHeader('Location', '/onboarding.html?submitted=1');
      return res.end();
    }

    return json(res, 200, { ok: true });
  } catch (error) {
    console.error('Onboarding form error:', error && error.message ? error.message : error);
    return json(res, 400, { ok: false, message: error.message || 'The form could not be sent.' });
  }
};
