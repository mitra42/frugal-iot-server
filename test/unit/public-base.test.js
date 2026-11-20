/**
 * lib/public-base.js - the address links are built from. Behind a proxy the request's own Host is the
 * proxy's 127.0.0.1:8080, which is how a chart link from production pointed at localhost.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { publicBase } from '../../lib/public-base.js';

function appWith(config) {
  const app = express();
  app.set('trust proxy', 1); // as frugal-iot-server.js sets it
  app.get('/', (req, res) => res.send(publicBase(req, config)));
  return app;
}

describe('publicBase', () => {
  it('server.yaml baseurl wins, without a trailing slash', async () => {
    const r = await request(appWith({ server: { baseurl: 'https://farm.example.org/' }, email: { baseurl: 'https://other' } })).get('/');
    expect(r.text).toBe('https://farm.example.org');
  });
  it('email.yaml baseurl still counts, for a server set up before server.yaml had one', async () => {
    expect((await request(appWith({ email: { baseurl: 'https://mail.example.org' } })).get('/')).text).toBe('https://mail.example.org');
  });
  it('otherwise what a proxy says it forwarded', async () => {
    const r = await request(appWith({})).get('/').set('Host', '127.0.0.1:8080')
      .set('X-Forwarded-Host', 'farm.example.org').set('X-Forwarded-Proto', 'https');
    expect(r.text).toBe('https://farm.example.org');
  });
  it('and with no proxy, the request itself', async () => {
    expect((await request(appWith({})).get('/').set('Host', 'frugaliot.local:8080')).text).toBe('http://frugaliot.local:8080');
  });
});
