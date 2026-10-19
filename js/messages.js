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

// Words that suggest the text is on a banknote.
const MONEY_RE = /DOLLAR|EURO|DINAR|POUND|STERLING|RESERVE|TENDER|BANK|CENTRAL|[$€£¥]|\bUSD\b|\bEUR\b|\bRSD\b|БАНКА|ДИНАР/i;

const TOTAL = MESSAGES.reduce((sum, [, w]) => sum + w, 0);

export function isMoneyText(text) {
  return MONEY_RE.test(text);
}

// Stable choice per piece of text, so a sign keeps its message.
export function pickMessage(text, moneyMode) {
  if (moneyMode || isMoneyText(text)) return MONEY_MESSAGE;
  let n = hash(text.toUpperCase().replace(/[^A-Z0-9]/g, '')) % TOTAL;
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
