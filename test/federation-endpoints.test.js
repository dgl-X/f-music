import assert from 'node:assert/strict';
import test from 'node:test';
import { federationAddressClass, resolveFederationEndpoint } from '../src/federation-endpoints.js';

test('endpoint address classes block SSRF targets', () => {
  assert.equal(federationAddressClass('127.0.0.1'), 'loopback');
  assert.equal(federationAddressClass('169.254.169.254'), 'link-local');
  assert.equal(federationAddressClass('192.168.1.20'), 'private');
  assert.equal(federationAddressClass('203.0.113.8'), 'reserved');
  assert.equal(federationAddressClass('8.8.8.8'), 'public');
  assert.equal(federationAddressClass('::1'), 'loopback');
  assert.equal(federationAddressClass('0:0:0:0:0:0:0:1'), 'loopback');
  assert.equal(federationAddressClass('fd00::1'), 'private');
  assert.equal(federationAddressClass('0:0:0:0:0:ffff:7f00:1'), 'loopback');
  assert.equal(federationAddressClass('::ffff:c0a8:101'), 'private');
  assert.equal(federationAddressClass('::ffff:8.8.8.8'), 'public');
});

test('public endpoint rejects private DNS answers and all redirects by construction', async () => {
  const privateResolver = async () => [{ address: '192.168.1.20', family: 4 }];
  await assert.rejects(() => resolveFederationEndpoint('https://node.example', 'public', privateResolver), error => error.code === 'endpoint_address_forbidden');
  const mappedResolver = async () => [{ address: '0:0:0:0:0:ffff:7f00:1', family: 6 }];
  await assert.rejects(() => resolveFederationEndpoint('https://node.example', 'public', mappedResolver), error => error.code === 'endpoint_address_forbidden');
  await assert.rejects(() => resolveFederationEndpoint('https://node.example/path', 'public', async () => []), error => error.code === 'invalid_endpoint');
});

test('private endpoint requires an exact RFC1918 address', async () => {
  const value = await resolveFederationEndpoint('https://192.168.1.20:8443', 'private');
  assert.equal(value.addresses[0].address, '192.168.1.20');
  await assert.rejects(() => resolveFederationEndpoint('https://node.lan', 'private'), error => error.code === 'private_ip_required');
  await assert.rejects(() => resolveFederationEndpoint('https://127.0.0.1', 'private'), error => error.code === 'endpoint_address_forbidden');
});
