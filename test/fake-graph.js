// A fake Meta Graph API for tests: checks tokens and appsecret_proof, and remembers what it was sent.
import http from 'node:http';
import crypto from 'node:crypto';

export const TOKEN = 'EAAGtesttokenABCDEFx9Z1', SECRET = 'appsecret0123456789abcdef', PHONE = '1111', WABA = '2222', APP = '3333';
const hmac = (k, v) => crypto.createHmac('sha256', k).update(v).digest('hex');

export async function startFakeGraph() {
  const g = { sent: [], subscription: null, subscribed: false, profile: { about: 'Hello', websites: [] }, templatesCreated: [], deleted: [], media: [], broadcasts: [] };
  const graph = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const err = (code, message, status = 400) => send(status, { error: { message, code, type: 'OAuthException' } });
    const auth = req.headers.authorization || '';
    if (url.pathname === '/realtime/v1/api/broadcast') { // fake Supabase Realtime
      if (req.headers.apikey !== 'anon-test-key') return send(401, { message: 'bad key' });
      g.broadcasts.push(...JSON.parse(raw).messages);
      return send(202, {});
    }
    if (url.pathname.startsWith('/file/')) {
      if (auth !== `Bearer ${TOKEN}`) return err(190, 'bad token', 401);
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end('JPEGDATA');
    }
    const p = url.pathname.replace(/^\/v\d+\.\d+\//, '');
    const body = req.headers['content-type']?.includes('json') ? JSON.parse(raw) : null;
    if (p === `${APP}/subscriptions`) {
      if (auth !== `Bearer ${APP}|${SECRET}`) return err(190, 'app token required', 401);
      if (req.method === 'POST') {
        const cb = url.searchParams.get('callback_url');
        g.subscription = { object: url.searchParams.get('object'), callback_url: cb, verify_token: url.searchParams.get('verify_token'), fields: url.searchParams.get('fields') };
        return send(200, { success: true });
      }
      return send(200, { data: g.subscription ? [{ object: g.subscription.object, callback_url: g.subscription.callback_url, active: true, fields: [{ name: 'messages', version: 'v21.0' }] }] : [] });
    }
    const tok = auth.replace('Bearer ', '');
    if (tok !== TOKEN) return err(190, 'Invalid OAuth access token.', 401);
    if (url.searchParams.get('appsecret_proof') !== hmac(SECRET, TOKEN)) return err(100, 'Invalid appsecret_proof provided in the API argument');
    const key = `${req.method} ${p}`;
    if (key === `GET ${PHONE}`) return send(200, { id: PHONE, display_phone_number: '+1 555-0100', verified_name: 'Test Shop', quality_rating: 'GREEN' });
    if (key === `GET ${WABA}`) return send(200, { id: WABA, name: 'Test WABA' });
    if (key === 'GET app') return send(200, { id: APP, name: 'Test App' });
    if (key === `POST ${PHONE}/messages`) {
      g.sent.push(body);
      if (body.status === 'read') return send(200, { success: true });
      if (body.to === '15550000047') return err(131047, 'Re-engagement message');
      return send(200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.out${g.sent.length}` }] });
    }
    if (key === `POST ${PHONE}/media`) { g.media.push(raw.toString('latin1')); return send(200, { id: '9001' }); }
    if (key === 'GET 5001') return send(200, { url: `http://127.0.0.1:${graph.address().port}/file/5001`, mime_type: 'image/jpeg' });
    if (key === `POST ${PHONE}/register`) { g.registered = body; return send(200, { success: true }); }
    if (key === `GET ${PHONE}/whatsapp_business_profile`) return send(200, { data: [{ ...g.profile, messaging_product: 'whatsapp' }] });
    if (key === `POST ${PHONE}/whatsapp_business_profile`) { const { messaging_product, ...rest } = body; g.profile = rest; return send(200, { success: true }); }
    if (key === `GET ${WABA}/message_templates`) {
      if (url.searchParams.get('after') === 'page2') return send(200, { data: [{ name: 'rejected_one', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', language: 'en', category: 'MARKETING', components: [] }] });
      return send(200, {
        data: [{ name: 'hello_world', status: 'APPROVED', language: 'en_US', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}' }] },
          { name: 'waiting_one', status: 'PENDING', language: 'hi', category: 'UTILITY', components: [] }],
        paging: { cursors: { after: 'page2' }, next: 'https://graph.facebook.com/next' },
      });
    }
    if (key === `POST ${WABA}/message_templates`) { g.templatesCreated.push(body); return send(200, { id: '777', status: 'PENDING', category: body.category }); }
    if (key === `DELETE ${WABA}/message_templates`) { g.deleted.push(url.searchParams.get('name')); return send(200, { success: true }); }
    if (key === `POST ${WABA}/subscribed_apps`) { g.subscribed = true; return send(200, { success: true }); }
    if (key === `GET ${WABA}/subscribed_apps`) return send(200, { data: g.subscribed ? [{ whatsapp_business_api_data: { id: APP, name: 'Test App' } }] : [] });
    err(100, `Unknown path ${key}`);
  });
  await new Promise(r => graph.listen(0, '127.0.0.1', r));
  return { graph, g };
}
