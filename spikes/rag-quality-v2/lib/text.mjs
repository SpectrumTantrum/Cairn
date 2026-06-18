// Tokenizer for the lexical baselines: lowercase -> alphanumeric tokens -> drop
// stopwords -> Porter stem. Stemming + stopwords are included so BM25/TF-IDF are a
// FAIR, strong baseline (matching the Anserini/Lucene pipeline behind published BEIR
// BM25 numbers). Understating the lexical baseline would falsely flatter the embedder
// — the exact error we are trying not to repeat.

export const STOP = new Set(
  ('a about above after again against all am an and any are aren as at be because been before being ' +
   'below between both but by can cannot could did do does doing down during each few for from further ' +
   'had has have having he her here hers herself him himself his how i if in into is it its itself just ' +
   'me more most my myself no nor not of off on once only or other our ours ourselves out over own same ' +
   'she should so some such than that the their theirs them themselves then there these they this those ' +
   'through to too under until up very was we were what when where which while who whom why will with ' +
   'you your yours yourself yourselves').split(/\s+/)
);

// Porter stemmer (M.F. Porter, 1980) — canonical compact JS port.
const step2list = { ational:'ate', tional:'tion', enci:'ence', anci:'ance', izer:'ize', bli:'ble', alli:'al',
  entli:'ent', eli:'e', ousli:'ous', ization:'ize', ation:'ate', ator:'ate', alism:'al', iveness:'ive',
  fulness:'ful', ousness:'ous', aliti:'al', iviti:'ive', biliti:'ble', logi:'log' };
const step3list = { icate:'ic', ative:'', alize:'al', iciti:'ic', ical:'ic', ful:'', ness:'' };
const cc = '[^aeiou]', vv = '[aeiouy]', CC = cc + '[^aeiouy]*', VV = vv + '[aeiou]*';
const mgr0 = '^(' + CC + ')?' + VV + CC;
const meq1 = '^(' + CC + ')?' + VV + CC + '(' + VV + ')?$';
const mgr1 = '^(' + CC + ')?' + VV + CC + VV + CC;
const s_v = '^(' + CC + ')?' + vv;

export function stem(w) {
  if (w.length < 3) return w;
  let re, re2, re3, fp, stemw;
  const firstch = w[0];
  if (firstch === 'y') w = 'Y' + w.substr(1);

  // Step 1a
  re = /^(.+?)(ss|i)es$/; re2 = /^(.+?)([^s])s$/;
  if (re.test(w)) w = w.replace(re, '$1$2'); else if (re2.test(w)) w = w.replace(re2, '$1$2');

  // Step 1b
  re = /^(.+?)eed$/; re2 = /^(.+?)(ed|ing)$/;
  if (re.test(w)) { fp = re.exec(w); re = new RegExp(mgr0); if (re.test(fp[1])) w = w.replace(/.$/, ''); }
  else if (re2.test(w)) {
    fp = re2.exec(w); stemw = fp[1]; re2 = new RegExp(s_v);
    if (re2.test(stemw)) {
      w = stemw;
      re = /(at|bl|iz)$/; re2 = new RegExp('([^aeiouylsz])\\1$'); re3 = new RegExp('^' + CC + vv + '[^aeiouwxy]$');
      if (re.test(w)) w = w + 'e';
      else if (re2.test(w)) w = w.replace(/.$/, '');
      else if (re3.test(w)) w = w + 'e';
    }
  }

  // Step 1c
  re = /^(.+?)y$/;
  if (re.test(w)) { fp = re.exec(w); stemw = fp[1]; re = new RegExp(s_v); if (re.test(stemw)) w = stemw + 'i'; }

  // Step 2
  re = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
  if (re.test(w)) { fp = re.exec(w); stemw = fp[1]; const sfx = fp[2]; re = new RegExp(mgr0); if (re.test(stemw)) w = stemw + step2list[sfx]; }

  // Step 3
  re = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
  if (re.test(w)) { fp = re.exec(w); stemw = fp[1]; const sfx = fp[2]; re = new RegExp(mgr0); if (re.test(stemw)) w = stemw + step3list[sfx]; }

  // Step 4
  re = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/; re2 = /^(.+?)(s|t)(ion)$/;
  if (re.test(w)) { fp = re.exec(w); stemw = fp[1]; re = new RegExp(mgr1); if (re.test(stemw)) w = stemw; }
  else if (re2.test(w)) { fp = re2.exec(w); stemw = fp[1] + fp[2]; re2 = new RegExp(mgr1); if (re2.test(stemw)) w = stemw; }

  // Step 5
  re = /^(.+?)e$/;
  if (re.test(w)) { fp = re.exec(w); stemw = fp[1]; re = new RegExp(mgr1); re2 = new RegExp(meq1); re3 = new RegExp('^' + CC + vv + '[^aeiouwxy]$');
    if (re.test(stemw) || (re2.test(stemw) && !re3.test(stemw))) w = stemw; }
  re = /ll$/; re2 = new RegExp(mgr1);
  if (re.test(w) && re2.test(w)) w = w.replace(/.$/, '');

  if (firstch === 'y') w = 'y' + w.substr(1);
  return w;
}

export function tokenize(text) {
  const out = [];
  const raw = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  for (const w of raw) {
    if (w.length < 2) continue;
    if (STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}
