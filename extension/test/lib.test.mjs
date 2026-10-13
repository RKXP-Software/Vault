// Testes das partes puras da extensão. Uso: node --test extension/test
import assert from 'node:assert/strict'
import test from 'node:test'
import { baseDomain, hostOf, isSecurePage, matchesUrl } from '../lib/match.js'
import { parsePairCode } from '../lib/pair.js'

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')

test('casa o domínio registrável (subdomínios e www)', () => {
  assert.equal(matchesUrl('https://github.com/login', 'https://gist.github.com/x'), true)
  assert.equal(matchesUrl('github.com', 'https://www.github.com/'), true)
  assert.equal(matchesUrl('https://drive.google.com', 'https://accounts.google.com/signin'), true)
})

test('não casa sites parecidos nem de outro dono', () => {
  assert.equal(matchesUrl('https://github.com', 'https://github.com.evil.io/login'), false)
  assert.equal(matchesUrl('https://github.com', 'https://githuub.com'), false)
  assert.equal(matchesUrl('https://paypal.com', 'https://paypal-secure.com'), false)
  assert.equal(matchesUrl('', 'https://github.com'), false)
  assert.equal(matchesUrl('https://github.com', ''), false)
})

test('sufixos de dois níveis (com.br, co.uk) não misturam donos diferentes', () => {
  assert.equal(baseDomain('www.itau.com.br'), 'itau.com.br')
  assert.equal(matchesUrl('https://banco.com.br', 'https://outro.com.br'), false)
  assert.equal(matchesUrl('https://app.banco.com.br', 'https://www.banco.com.br'), true)
  assert.equal(baseDomain('bbc.co.uk'), 'bbc.co.uk')
})

test('IPs e localhost só casam consigo mesmos', () => {
  assert.equal(matchesUrl('http://192.168.1.1', 'http://192.168.1.1/admin'), true)
  assert.equal(matchesUrl('http://192.168.1.1', 'http://10.0.0.1'), false)
  assert.equal(hostOf('localhost:3000/x'), 'localhost')
})

test('só preenche em https (ou localhost)', () => {
  assert.equal(isSecurePage('https://exemplo.com'), true)
  assert.equal(isSecurePage('http://exemplo.com'), false)
  assert.equal(isSecurePage('http://localhost:1430'), true)
  assert.equal(isSecurePage('chrome://extensions'), false)
  assert.equal(isSecurePage('lixo'), false)
})

test('lê o código de pareamento do app', () => {
  const code = 'vault1:' + b64url({ v: 1, t: Math.floor(Date.now() / 1000), rt: 'refresh-123', sk: 'AAAAA-BBBBB' })
  assert.deepEqual(parsePairCode(`  ${code}\n`), { refreshToken: 'refresh-123', secretKey: 'AAAAA-BBBBB' })
})

test('recusa código inválido ou expirado', () => {
  assert.throws(() => parsePairCode(''), /inválido/)
  assert.throws(() => parsePairCode('outro:abc'), /inválido/)
  assert.throws(() => parsePairCode('vault1:%%%'), /inválido/)
  assert.throws(() => parsePairCode('vault1:' + b64url({ t: 1 })), /inválido/)
  const old = 'vault1:' + b64url({ v: 1, t: Math.floor(Date.now() / 1000) - 3600, rt: 'x', sk: 'y' })
  assert.throws(() => parsePairCode(old), /expirou/)
})
