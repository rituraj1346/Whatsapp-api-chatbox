// The whole server as one Netlify Function. netlify.toml sends /api, /webhook, the manifest and icons here.
import serverless from 'serverless-http';
import { app } from '../../src/app.js';

const TEXT = /^(text\/|application\/(json|manifest\+json)|image\/svg\+xml)/;

export const handler = serverless(app, {
  basePath: '/.netlify/functions/app',
  binary: headers => !TEXT.test(String(headers['content-type'] || '')), // photos, audio and documents go out as base64
});
