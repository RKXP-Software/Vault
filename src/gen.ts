// Gerador de senhas (crypto.getRandomValues com amostragem sem viés) e medidor de força.

export interface GenOptions {
  length: number
  lower: boolean
  upper: boolean
  digits: boolean
  symbols: boolean
}

export const defaultGen: GenOptions = { length: 20, lower: true, upper: true, digits: true, symbols: true }

const SETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
}

function randInt(max: number): number {
  const lim = Math.floor(0x100000000 / max) * max
  const buf = new Uint32Array(1)
  do crypto.getRandomValues(buf)
  while (buf[0] >= lim)
  return buf[0] % max
}

export function generate(o: GenOptions): string {
  const sets = (Object.keys(SETS) as (keyof typeof SETS)[]).filter((k) => o[k]).map((k) => SETS[k])
  if (!sets.length) return ''
  const all = sets.join('')
  const out = sets.map((s) => s[randInt(s.length)]) // garante um de cada tipo escolhido
  while (out.length < o.length) out.push(all[randInt(all.length)])
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out.slice(0, o.length).join('')
}

/** 0 a 4. Estimativa simples por tamanho e variedade — serve de orientação, não de garantia. */
export function strength(p: string): number {
  if (!p) return 0
  let pool = 0
  if (/[a-z]/.test(p)) pool += 26
  if (/[A-Z]/.test(p)) pool += 26
  if (/\d/.test(p)) pool += 10
  if (/[^a-zA-Z0-9]/.test(p)) pool += 30
  const bits = p.length * Math.log2(pool || 1)
  return bits < 36 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4
}

export const strengthLabel = ['', 'Fraca', 'Razoável', 'Boa', 'Forte']
