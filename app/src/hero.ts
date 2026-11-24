// Draws the big "hero" block of a lens card (number, word or icon) as a picture.
// The lens text font is small and ASCII-only; an image container can show bold type
// and simple icons. Drawn white-on-black: the glasses map brightness to their green.

import type { Hero, HeroIcon } from './format'

export const HERO_W = 280 // image containers: width 20..288
export const HERO_H = 144 // height 20..144

const FONT = `-apple-system, "SF Pro Display", "Helvetica Neue", Inter, "DejaVu Sans", Arial, sans-serif`

/** A stable key: same hero => same picture (lets the display skip re-sending it). */
export const heroKey = (h: Hero) => `${h.icon ?? ''}|${h.kicker ?? ''}|${h.big ?? ''}|${h.unit ?? ''}|${h.level === undefined ? '' : Math.round(h.level * 6)}`

/** Render to PNG bytes. Browser-only (uses a canvas). */
export async function renderHero(h: Hero): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = HERO_W
  canvas.height = HERO_H
  const g = canvas.getContext('2d')!
  g.fillStyle = '#000'
  g.fillRect(0, 0, HERO_W, HERO_H)
  g.textBaseline = 'alphabetic'

  const hasBig = !!h.big
  // Kicker row (with an optional small icon in front of it).
  let kx = 4
  if (h.icon && hasBig) {
    drawIcon(g, h.icon, 4, 6, 26, 0.85)
    kx = 38
  }
  if (h.kicker) {
    g.fillStyle = '#b8b8b8'
    g.font = `700 22px ${FONT}`
    // Icon-only heroes centre their label over the icon; number heroes align left.
    if (!hasBig) kx = Math.max(4, (HERO_W - spacedWidth(g, h.kicker, 2)) / 2)
    spaced(g, h.kicker, kx, 28, 2)
  }

  if (hasBig) {
    // Big number: as large as fits next to its unit.
    const unit = h.unit ?? ''
    g.font = `700 26px ${FONT}`
    const unitW = unit ? g.measureText(unit).width + 10 : 0
    let size = 92
    for (; size > 34; size -= 4) {
      g.font = `800 ${size}px ${FONT}`
      if (g.measureText(h.big!).width + unitW <= HERO_W - 8) break
    }
    g.fillStyle = '#fff'
    g.font = `800 ${size}px ${FONT}`
    const base = 44 + size * 0.86
    g.fillText(h.big!, 4, Math.min(base, HERO_H - 8))
    if (unit) {
      const bw = g.measureText(h.big!).width
      g.fillStyle = '#d0d0d0'
      g.font = `700 26px ${FONT}`
      g.fillText(unit, 4 + bw + 10, Math.min(base, HERO_H - 8))
    }
  } else if (h.icon) {
    // Icon-only hero (listening, working, reconnecting): centred under the kicker.
    drawIcon(g, h.icon, HERO_W / 2 - 36, 40, 72, 1, h.level)
  }

  const blob: Blob = await new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'))
  return new Uint8Array(await blob.arrayBuffer())
}

function spacedWidth(g: CanvasRenderingContext2D, text: string, gap: number) {
  let w = 0
  for (const ch of text) w += g.measureText(ch).width + gap
  return w - gap
}

function spaced(g: CanvasRenderingContext2D, text: string, x: number, y: number, gap: number) {
  for (const ch of text) {
    g.fillText(ch, x, y)
    x += g.measureText(ch).width + gap
  }
}

/** Simple line icons, drawn in a size×size box at (x, y). */
function drawIcon(g: CanvasRenderingContext2D, icon: HeroIcon, x: number, y: number, size: number, alpha = 1, level?: number) {
  const s = size
  g.save()
  g.translate(x, y)
  g.strokeStyle = `rgba(255,255,255,${alpha})`
  g.fillStyle = `rgba(255,255,255,${alpha})`
  g.lineWidth = Math.max(2.5, s / 11)
  g.lineCap = 'round'
  g.lineJoin = 'round'
  const circle = () => {
    g.beginPath()
    g.arc(s / 2, s / 2, s / 2 - g.lineWidth, 0, Math.PI * 2)
    g.stroke()
  }
  switch (icon) {
    case 'check':
      circle()
      g.beginPath()
      g.moveTo(s * 0.28, s * 0.52)
      g.lineTo(s * 0.44, s * 0.68)
      g.lineTo(s * 0.73, s * 0.36)
      g.stroke()
      break
    case 'cross':
      circle()
      g.beginPath()
      g.moveTo(s * 0.34, s * 0.34)
      g.lineTo(s * 0.66, s * 0.66)
      g.moveTo(s * 0.66, s * 0.34)
      g.lineTo(s * 0.34, s * 0.66)
      g.stroke()
      break
    case 'warn':
      g.beginPath()
      g.moveTo(s / 2, s * 0.08)
      g.lineTo(s * 0.94, s * 0.9)
      g.lineTo(s * 0.06, s * 0.9)
      g.closePath()
      g.stroke()
      g.beginPath()
      g.moveTo(s / 2, s * 0.38)
      g.lineTo(s / 2, s * 0.62)
      g.stroke()
      g.beginPath()
      g.arc(s / 2, s * 0.76, g.lineWidth * 0.6, 0, Math.PI * 2)
      g.fill()
      break
    case 'coin':
      circle()
      g.font = `800 ${Math.round(s * 0.5)}px ${FONT}`
      g.textAlign = 'center'
      g.fillText('G', s / 2, s * 0.68)
      break
    case 'link':
      g.beginPath()
      g.ellipse(s * 0.36, s * 0.5, s * 0.22, s * 0.14, -Math.PI / 4, 0, Math.PI * 2)
      g.ellipse(s * 0.64, s * 0.5, s * 0.22, s * 0.14, -Math.PI / 4, 0, Math.PI * 2)
      g.stroke()
      break
    case 'dots':
      for (const k of [0.25, 0.5, 0.75]) {
        g.beginPath()
        g.arc(s * k, s / 2, s * 0.07, 0, Math.PI * 2)
        g.fill()
      }
      break
    case 'mic': {
      // Capsule + stand, with sound arcs that grow with the live level.
      const w = s * 0.32
      const h = s * 0.5
      const mx = s / 2 - w / 2
      g.beginPath()
      g.roundRect(mx, s * 0.06, w, h, w / 2)
      g.fill()
      g.beginPath()
      g.arc(s / 2, s * 0.34, s * 0.3, 0.1 * Math.PI, 0.9 * Math.PI)
      g.moveTo(s / 2, s * 0.64)
      g.lineTo(s / 2, s * 0.84)
      g.moveTo(s * 0.34, s * 0.86)
      g.lineTo(s * 0.66, s * 0.86)
      g.stroke()
      const lv = Math.max(0, Math.min(1, level ?? 0))
      for (let i = 1; i <= 3; i++) {
        if (lv < i / 3.2) break
        g.globalAlpha = 1 - (i - 1) * 0.25
        for (const side of [-1, 1]) {
          g.beginPath()
          g.arc(s / 2, s * 0.32, s * (0.38 + i * 0.16), side < 0 ? Math.PI * 0.82 : -Math.PI * 0.18, side < 0 ? Math.PI * 1.18 : Math.PI * 0.18)
          g.stroke()
        }
      }
      g.globalAlpha = 1
      break
    }
  }
  g.restore()
}
