// What the signs really say. Weight = how often a message is picked.
const MESSAGES = [
  ['OBEY', 6],
  ['CONSUME', 4],
  ['CONFORM', 3],
  ['SUBMIT', 3],
  ['STAY ASLEEP', 3],
  ['NO INDEPENDENT THOUGHT', 2],
  ['BUY', 3],
  ['WATCH TV', 2],
  ['SLEEP', 2],
  ['MARRY AND REPRODUCE', 1],
  ['DO NOT QUESTION AUTHORITY', 1],
  ['NO IMAGINATION', 1],
  ['SUBMIT TO AUTHORITY', 1],
];

export const MONEY_MESSAGE = 'THIS IS YOUR GOD';

// Words that suggest money: banknotes, coins, banks, prices. Matched against a Latin
// transliteration, so Serbian Cyrillic (НАРОДНА БАНКА СРБИЈЕ, 100 ДИНАРА) and Serbian
// Latin (NARODNA BANKA SRBIJE, 100 DINARA) both count. DINAP: a Cyrillic Р read as P.
const MONEY_RE = /DOLLAR|EURO|EVRO|DINA[RP]|POUND|STERLING|RESERVE|TENDER|BANK|[$€£¥]|\b(USD|EUR|RSD|DIN)\b/;

// Serbian Cyrillic to Latin, letter for letter.
const CYRILLIC = {
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Ђ: 'DJ', Е: 'E', Ж: 'Z', З: 'Z', И: 'I',
  Ј: 'J', К: 'K', Л: 'L', Љ: 'LJ', М: 'M', Н: 'N', Њ: 'NJ', О: 'O', П: 'P', Р: 'R',
  С: 'S', Т: 'T', Ћ: 'C', У: 'U', Ф: 'F', Х: 'H', Ц: 'C', Ч: 'C', Џ: 'DZ', Ш: 'S',
};

const TOTAL = MESSAGES.reduce((sum, [, w]) => sum + w, 0);

// Upper-case Latin letters only: Cyrillic transliterated, accents (Š, Č, Ž, Ć) dropped.
export function toLatin(text) {
  return text
    .toUpperCase()
    .replace(/[Ѐ-ӿ]/g, (ch) => CYRILLIC[ch] ?? ch)
    .replace(/Đ/g, 'DJ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function isMoneyText(text) {
  return MONEY_RE.test(toLatin(text));
}

// Stable choice per piece of text, so a sign keeps its message.
export function pickMessage(text, moneyMode) {
  if (moneyMode || isMoneyText(text)) return MONEY_MESSAGE;
  let n = hash(toLatin(text)) % TOTAL;
  for (const [msg, w] of MESSAGES) {
    if (n < w) return msg;
    n -= w;
  }
  return 'OBEY';
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
