'use strict';

const IMAGE_URL = 'green.png'; // картинка, которая открывается при запуске

// Цвета волос: тень, основной тон и блик. Рисунок теней берётся из исходных волос.
const DYES = [
  { id: 'brown', name: 'Шатен',   shadow: '#3a2214', base: '#7b4b2a', highlight: '#ad7642' },
  { id: 'blond', name: 'Блондин', shadow: '#a8742f', base: '#e6bd5f', highlight: '#f8e6a8' },
  { id: 'black', name: 'Брюнет',  shadow: '#141012', base: '#2f2726', highlight: '#5a4a44' },
  { id: 'red',   name: 'Рыжий',   shadow: '#7c2b0d', base: '#c9551b', highlight: '#f2913f' },
];

// Ключевые цвета волос на исходной картинке: диапазоны оттенка в градусах.
// Берётся первый, который занимает заметную часть картинки.
const KEYS = [
  { from: 75, to: 180 },  // зелёный хромакей
  { from: 320, to: 347 }, // маджента
];
// Уровни светлоты в таблице цвета, на которые приходятся тень и основной тон; блик — 255.
const TONE_SHADOW = 32;
const TONE_BASE = 128;
const HUE_FEATHER = 6;      // мягкий край диапазона, градусы
const MIN_COVERAGE = 0.015; // доля картинки, с которой ключ считается найденным
const FADE_MS = 160;

const canvas = document.getElementById('sheet');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const notice = document.getElementById('notice');
const dyesField = document.getElementById('dyes');
const dyesRow = document.getElementById('dyes-row');
const stage = document.getElementById('stage');
const fileInput = document.getElementById('file');

let source; // пиксели исходной картинки
let frame;  // пиксели, которые сейчас на экране
let hair;   // { index, tone, weight }: где волосы, насколько светлые, насколько уверенно
let shown = { lut: new Float32Array(768), amount: 0 };
let fade = 0;
let selectedId = 'original'; // выбранный цвет сохраняется при смене картинки

const smoothstep = (lo, hi, x) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbToHex = (rgb) => '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');

function showNotice(html) {
  notice.innerHTML = html;
  notice.hidden = false;
}

// Таблица цвета на 256 уровней светлоты: чёрный контур → тень → основной тон → блик.
function buildLut({ shadow, base, highlight }) {
  const [s, b, h] = [shadow, base, highlight].map(hexToRgb);
  const black = [0, 0, 0];
  const lut = new Float32Array(768);
  for (let i = 0; i < 256; i++) {
    const [from, to, t] =
      i < TONE_SHADOW ? [black, s, i / TONE_SHADOW]
      : i < TONE_BASE ? [s, b, (i - TONE_SHADOW) / (TONE_BASE - TONE_SHADOW)]
      : [b, h, (i - TONE_BASE) / (255 - TONE_BASE)];
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = from[c] + (to[c] - from[c]) * t;
  }
  return lut;
}

// Находит волосы по ключевому цвету и запоминает для каждого пикселя светлоту и вес маски.
function findHair(data) {
  const count = data.length / 4;
  const hue = new Float32Array(count);
  const sat = new Float32Array(count);
  const val = new Float32Array(count);

  for (let i = 0, p = 0; i < count; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    let h = 0;
    if (delta > 0) {
      if (max === r) h = ((g - b) / delta + 6) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
    }
    hue[i] = h * 60;
    sat[i] = max ? delta / max : 0;
    val[i] = max / 255;
  }

  const key = KEYS.find(({ from, to }) => {
    let hits = 0;
    for (let i = 0; i < count; i++) {
      if (hue[i] >= from && hue[i] <= to && sat[i] > 0.45 && val[i] > 0.2) hits++;
    }
    return hits / count >= MIN_COVERAGE;
  });
  if (!key) return null;

  const weightAt = (i) => {
    const off = Math.max(key.from - hue[i], hue[i] - key.to, 0);
    if (off >= HUE_FEATHER) return 0;
    return (1 - off / HUE_FEATHER) * smoothstep(0.12, 0.28, sat[i]) * smoothstep(0.03, 0.09, val[i]);
  };

  // Волосы закрашены плоскими тонами, поэтому тень, основной тон и блик — это пики
  // на гистограмме светлоты (шкала 0–255).
  const histogram = new Float32Array(256);
  let total = 0;
  let mass = 0;
  for (let i = 0; i < count; i++) {
    const w = weightAt(i);
    if (w === 0) continue;
    total++;
    mass += w;
    histogram[Math.round(val[i] * 255)] += w;
  }
  const peak = (lo, hi, fallback) => {
    let best = fallback;
    let bestMass = mass * 0.015; // слабее этого — не пик, а шум
    for (let v = Math.max(0, Math.round(lo)); v <= Math.min(255, Math.round(hi)); v++) {
      let around = 0;
      for (let j = Math.max(0, v - 4); j <= Math.min(255, v + 4); j++) around += histogram[j];
      if (around > bestMass) { bestMass = around; best = v; }
    }
    return best;
  };
  const mid = peak(26, 255, 128);
  const dark = Math.max(1, Math.min(mid - 1, peak(15, mid * 0.8, mid * 0.5)));
  const light = Math.max(mid + 1, peak(mid * 1.2, 255, Math.min(255, mid * 1.5)));

  const index = new Uint32Array(total);
  const tone = new Uint8Array(total);
  const weight = new Uint8Array(total);
  const buckets = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]; // суммы r, g, b и счётчик

  for (let i = 0, k = 0; i < count; i++) {
    const w = weightAt(i);
    if (w === 0) continue;
    const v = val[i] * 255;
    let t;
    if (v <= dark) t = TONE_SHADOW * (v / dark);
    else if (v <= mid) t = TONE_SHADOW + (TONE_BASE - TONE_SHADOW) * ((v - dark) / (mid - dark));
    else t = TONE_BASE + (255 - TONE_BASE) * Math.min(1, (v - mid) / (light - mid));
    index[k] = i;
    tone[k] = Math.round(t);
    weight[k] = Math.round(w * 255);
    if (w > 0.9) {
      const bucket = Math.abs(tone[k] - TONE_SHADOW) < 10 ? 0 : Math.abs(tone[k] - TONE_BASE) < 12 ? 1 : tone[k] > 240 ? 2 : -1;
      if (bucket >= 0) {
        const sum = buckets[bucket];
        sum[0] += data[i * 4]; sum[1] += data[i * 4 + 1]; sum[2] += data[i * 4 + 2]; sum[3]++;
      }
    }
    k++;
  }

  const [shadow, base, highlight] = buckets.map(([r, g, b, n]) => (n ? rgbToHex([r / n, g / n, b / n]) : '#888888'));
  return { index, tone, weight, original: { shadow, base, highlight } };
}

function paint(lut, amount) {
  const { index, tone, weight } = hair;
  const src = source.data;
  const out = frame.data;
  for (let k = 0; k < index.length; k++) {
    const p = index[k] * 4;
    const t = tone[k] * 3;
    const a = (weight[k] / 255) * amount;
    out[p] = src[p] + (lut[t] - src[p]) * a;
    out[p + 1] = src[p + 1] + (lut[t + 1] - src[p + 1]) * a;
    out[p + 2] = src[p + 2] + (lut[t + 2] - src[p + 2]) * a;
  }
  ctx.putImageData(frame, 0, 0);
}

// Плавно переводит волосы к выбранному цвету; lut === null возвращает исходный.
function dyeHair(lut) {
  cancelAnimationFrame(fade);
  const from = { lut: shown.amount === 0 && lut ? lut : shown.lut.slice(), amount: shown.amount };
  const to = { lut: lut || from.lut, amount: lut ? 1 : 0 };
  const instant = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const started = performance.now();

  const step = (now) => {
    const t = instant ? 1 : Math.min(1, (now - started) / FADE_MS);
    const mixed = new Float32Array(768);
    for (let i = 0; i < 768; i++) mixed[i] = from.lut[i] + (to.lut[i] - from.lut[i]) * t;
    shown = { lut: mixed, amount: from.amount + (to.amount - from.amount) * t };
    paint(shown.lut, shown.amount);
    if (t < 1) fade = requestAnimationFrame(step);
  };
  step(started);
}

function addSwatch({ id, name, shadow, base, highlight }, lut) {
  const label = document.createElement('label');
  label.className = 'dye';
  label.style.setProperty('--shadow', shadow);
  label.style.setProperty('--base', base);
  label.style.setProperty('--highlight', highlight);
  label.innerHTML =
    `<input type="radio" name="dye" value="${id}"${id === selectedId ? ' checked' : ''}>` +
    '<svg viewBox="0 0 64 64" aria-hidden="true"><use href="#tuft"/></svg>' +
    `<span class="dye__name">${name}</span>`;
  label.querySelector('input').addEventListener('change', () => {
    selectedId = id;
    dyeHair(lut);
  });
  dyesRow.append(label);
}

// Показывает картинку, находит на ней волосы и собирает образцы цвета.
function showImage(image) {
  cancelAnimationFrame(fade);
  hair = null;
  shown = { lut: new Float32Array(768), amount: 0 };
  dyesRow.replaceChildren();
  dyesField.disabled = true;
  notice.hidden = true;

  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  document.documentElement.style.setProperty('--ratio', canvas.width / canvas.height);
  ctx.drawImage(image, 0, 0);

  try {
    source = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    showNotice(
      'Браузер не даёт читать пиксели картинки, когда страница открыта как файл. ' +
      'Загрузите картинку кнопкой выше или запустите в этой папке ' +
      '<code>python3 -m http.server 8123</code> и откройте <code>http://localhost:8123</code>.'
    );
    return;
  }

  hair = findHair(source.data);
  if (!hair) {
    showNotice(
      'На картинке не нашлось волос ключевого цвета. Нужны ярко-зелёные или маджентовые волосы: ' +
      'загрузите другую картинку или добавьте свой цвет в список <code>KEYS</code> в <code>app.js</code>.'
    );
    return;
  }

  frame = new ImageData(new Uint8ClampedArray(source.data), canvas.width, canvas.height);
  addSwatch({ id: 'original', name: 'Исходный', ...hair.original }, null);
  for (const dye of DYES) {
    const lut = buildLut(dye);
    addSwatch(dye, lut);
    if (dye.id === selectedId) {
      shown = { lut, amount: 1 };
      paint(lut, 1);
    }
  }
  dyesField.disabled = false;
}

async function loadImage(url, failure) {
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    showNotice(failure);
    return;
  }
  showImage(image);
}

function loadFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  loadImage(url, 'Не удалось открыть этот файл как картинку. Подойдут PNG, JPEG и WebP.')
    .finally(() => URL.revokeObjectURL(url));
}

fileInput.addEventListener('change', () => {
  loadFile(fileInput.files[0]);
  fileInput.value = ''; // чтобы тот же файл можно было выбрать повторно
});

// Картинку можно перетащить в любое место страницы.
document.addEventListener('dragover', (event) => {
  event.preventDefault();
  stage.classList.add('is-drop');
});
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) stage.classList.remove('is-drop');
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  stage.classList.remove('is-drop');
  loadFile(event.dataTransfer.files[0]);
});

loadImage(IMAGE_URL, `Не удалось загрузить <code>${IMAGE_URL}</code>. Положите файл рядом со страницей или загрузите картинку кнопкой выше.`);
