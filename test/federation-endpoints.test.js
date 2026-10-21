import assert from 'node:assert/strict';
import test from 'node:test';
import { federationAddressClass, resolveFederationEndpoint } from '../src/federation-endpoints.js';

test('transition, documentation and reserved endpoints cannot bypass public filtering', async () => {
  const addresses=['240.0.0.1','255.255.255.255','192.88.99.1','::127.0.0.1','64:ff9b::7f00:1','64:ff9b:1::1','100::1','2001::1','2002:7f00:1::1','3fff::1','5f00::1','fec0::1'];
  for(const address of addresses){
    assert.equal(federationAddressClass(address),'reserved',address);
    await assert.rejects(resolveFederationEndpoint('https://node.example','public',async()=>[{address,family:address.includes(':')?6:4}]),error=>error.code==='endpoint_address_forbidden');
  }
  assert.equal(federationAddressClass('2606:4700:4700::1111'),'public');
  assert.equal(federationAddressClass('2001:4860:4860::8888'),'public');
  assert.equal(federationAddressClass('::ffff:240.0.0.1'),'reserved');
  await assert.rejects(resolveFederationEndpoint('https://node.example','public',async()=>[
    {address:'8.8.8.8',family:4},{address:'64:ff9b::7f00:1',family:6},
  ]),error=>error.code==='endpoint_address_forbidden');
  await assert.rejects(resolveFederationEndpoint('https://node.example','other'),error=>error.code==='invalid_endpoint_scope');
});

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
