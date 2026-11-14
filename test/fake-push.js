// Loaded into the test server with --import. Replaces web-push's network send with a recorder,
// but still runs the real generateRequestDetails, so VAPID keys, subject and payload encryption are checked.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const webpush = createRequire(import.meta.url)('web-push');
const LOG = process.env.PUSH_LOG;

webpush.sendNotification = async (subscription, payload, options) => {
  const details = webpush.generateRequestDetails(subscription, payload, options);
  fs.appendFileSync(LOG, JSON.stringify({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options, headers: details.headers }) + '\n');
  if (subscription.endpoint.includes('gone')) throw new webpush.WebPushError('Gone', 410, {}, '', subscription.endpoint);
  return { statusCode: 201, body: '', headers: {} };
};
