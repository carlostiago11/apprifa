const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { tokenCipher, isValidTaxId, buildPixRequest, remoteStatus, validateRemote, remoteFinancials, publicPayload } = require('../lib/pix');

test('OAuth: criptografia autenticada, IV aleatorio e falha com chave errada', () => {
  const cipher = tokenCipher(crypto.randomBytes(32).toString('base64'));
  const value = cipher.encrypt('segredo-ficticio');
  assert.ok(value.startsWith('enc:v1:'));
  assert.ok(!value.includes('segredo-ficticio'));
  assert.notEqual(value, cipher.encrypt('segredo-ficticio'));
  assert.equal(cipher.decrypt(value), 'segredo-ficticio');
  assert.throws(() => tokenCipher(crypto.randomBytes(32).toString('base64')).decrypt(value));
  assert.throws(() => tokenCipher('').encrypt('token'));
  assert.throws(() => tokenCipher('').decrypt(value));
  assert.throws(() => tokenCipher('invalid'));
});

test('PIX: CPF/CNPJ, sobrenome composto, expiracao e comissao sobre valor com desconto', () => {
  const args = { payment: { id: 7, tenantId: 2, amount: 27, expiresAt: '2026-09-05T12:30:00Z' }, user: { id: 8, name: 'Maria da Silva', email: 'teste@example.com', taxId: '529.982.247-25' }, raffle: { id: 3 }, numbers: [1, 2, 3], feePercent: 10 };
  const body = buildPixRequest(args);
  assert.equal(body.application_fee, 2.7);
  assert.equal(body.payer.last_name, 'da Silva');
  assert.deepEqual(body.payer.identification, { type: 'CPF', number: '52998224725' });
  assert.equal(body.date_of_expiration, '2026-09-05T12:30:00.000+00:00');
  args.user.taxId = '11.222.333/0001-81';
  assert.equal(buildPixRequest(args).payer.identification.type, 'CNPJ');
  args.user.taxId = '';
  assert.throws(() => buildPixRequest(args));
  assert.equal(isValidTaxId('123.456.789-01'), false);
  assert.equal(isValidTaxId('11.111.111/1111-11'), false);
});

test('PIX: somente estados conclusivos liberam reservas e respostas divergentes sao rejeitadas', () => {
  for (const status of ['unknown', 'refunded', 'charged_back', 'in_process']) assert.equal(remoteStatus(status), 'pendente');
  assert.equal(remoteStatus('cancelled'), 'falhou');
  assert.equal(remoteStatus('approved'), 'pago');
  const local = { amount: 27, providerAccountId: '123', externalId: '1', payload: { externalReference: 'ref' } };
  const remote = { id: 1, transaction_amount: 27, collector_id: 123, external_reference: 'ref', payment_method_id: 'pix', currency_id: 'BRL' };
  validateRemote(local, remote);
  for (const field of ['id', 'transaction_amount', 'collector_id', 'external_reference', 'payment_method_id', 'currency_id']) assert.throws(() => validateRemote(local, { ...remote, [field]: 'errado' }));
  assert.deepEqual(publicPayload({ gatewayRequest: { payer: 'privado' }, qrCodeText: 'PIX' }), { qrCodeText: 'PIX' });
});

test('PIX: valida a comissao e separa tarifa, comissao e liquido do vendedor', () => {
  const local = { amount: 27, marketplaceFeeAmount: 2.7, providerAccountId: '123', externalId: '1', payload: { externalReference: 'ref' } };
  const remote = { id: 1, transaction_amount: 27, application_fee: 2.7, collector_id: 123,
    external_reference: 'ref', payment_method_id: 'pix', currency_id: 'BRL',
    fee_details: [{ type: 'application_fee', amount: 2.7 }, { type: 'mercadopago_fee', amount: 0.55 }],
    transaction_details: { net_received_amount: 23.75 } };
  validateRemote(local, remote);
  assert.deepEqual(remoteFinancials(remote), { marketplaceFee: 2.7, mercadoPagoFee: 0.55, sellerNet: 23.75 });
  assert.throws(() => validateRemote(local, { ...remote, application_fee: 1 }));
});
