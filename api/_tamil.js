// DigiSmart ERP — Tamil lines for parent messages (Oct 2026)
// Files starting with "_" are not public API endpoints on Vercel.
//
// When the super admin switches on "Tamil messages" for a school
// (schools.has_tamil_msgs = true), every fixed parent message shows the
// English first and the simple Tamil just below it, in the same message.
// The Tamil here is written once by hand, never machine-translated, so
// the words stay correct. Names, subjects and lessons stay as typed.

const TA_MONTHS = ['ஜன.', 'பிப்.', 'மார்.', 'ஏப்.', 'மே', 'ஜூன்', 'ஜூலை', 'ஆக.', 'செப்.', 'அக்.', 'நவ.', 'டிச.'];

// '2026-10-23' → '23 அக்.'
function taDate(iso) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return String(iso || '');
  return d.getUTCDate() + ' ' + TA_MONTHS[d.getUTCMonth()];
}

// English and Tamil in one message: English first, Tamil on the next line
function both(en, ta) {
  return ta ? en + '\n' + ta : en;
}

// ── Discipline items ──
// code → [button label, English words, Tamil words]
const DISCIPLINE = {
  uniform: ['Uniform', 'without proper uniform', 'சரியான சீருடை இல்லாமல்'],
  shoes:   ['Shoes / socks', 'without shoes / socks', 'ஷூ / சாக்ஸ் இல்லாமல்'],
  nails:   ['Nails not cut', 'with nails not cut', 'நகம் வெட்டாமல்'],
  hair:    ['Hair not neat', 'with hair not neat', 'தலைமுடி சீராக இல்லாமல்'],
  books:   ['Books / notebooks', 'without books / notebooks', 'புத்தகம் / நோட்டு இல்லாமல்'],
  idcard:  ['ID card', 'without ID card', 'அடையாள அட்டை (ID card) இல்லாமல்']
};
const DISCIPLINE_CODES = Object.keys(DISCIPLINE);

function joinEn(parts) {
  if (parts.length <= 1) return parts.join('');
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

// One combined message for all of the day's items
function disciplineMessage(name, isoDate, niceEn, codes, tamil) {
  const list = DISCIPLINE_CODES.filter(c => codes.indexOf(c) !== -1);
  const en = 'Your child ' + name + ' came to school on ' + niceEn + ' '
    + joinEn(list.map(c => DISCIPLINE[c][1]))
    + '. Kindly send your ward neatly from tomorrow.';
  if (!tamil) return en;
  const ta = 'உங்கள் குழந்தை ' + name + ', ' + taDate(isoDate) + ' அன்று '
    + list.map(c => DISCIPLINE[c][2]).join(', ')
    + ' பள்ளிக்கு வந்தார். நாளை முதல் ஒழுங்காக அனுப்பவும்.';
  return both(en, ta);
}

// ── Homework / class test (Tamil part only; the English is built in defaulters.js) ──
function defaulterTamil(kind, name, isoDate, subject, lesson, marks, total) {
  const where = subject + ' – ' + lesson;
  const on = taDate(isoDate);
  if (kind === 'homework') {
    return 'உங்கள் குழந்தை ' + name + ', ' + on + ' அன்று கொடுத்த ' + where
      + ' வீட்டுப்பாடத்தை எழுதவில்லை. வீட்டுப்பாடம் எழுத உதவவும்.';
  }
  if (kind === 'test_not_written') {
    return 'உங்கள் குழந்தை ' + name + ', ' + on + ' அன்று நடந்த ' + where
      + ' வகுப்புத் தேர்வை எழுதவில்லை / படித்து வரவில்லை. நன்றாகப் படிக்க உதவவும்.';
  }
  if (kind === 'test_absent') {
    return 'உங்கள் குழந்தை ' + name + ', ' + on + ' அன்று நடந்த ' + where
      + ' வகுப்புத் தேர்வுக்கு வரவில்லை. இந்தப் பாடத்தை வீட்டில் படிக்க உதவவும்.';
  }
  if (kind === 'test_low_marks') {
    return 'உங்கள் குழந்தை ' + name + ', ' + on + ' அன்று நடந்த ' + where
      + ' வகுப்புத் தேர்வில் ' + total + '-க்கு ' + marks + ' மதிப்பெண் பெற்றார். இந்தப் பாடத்தில் வீட்டில் கூடுதல் கவனம் செலுத்தவும்.';
  }
  return '';
}

// ── Phone alerts ──
function absentTamil(name, isoDate) {
  return name + ' இன்று (' + taDate(isoDate) + ') பள்ளிக்கு வரவில்லை எனக் குறிக்கப்பட்டுள்ளது. தவறு என்றால், பள்ளியைத் தொடர்பு கொள்ளவும்.';
}
function birthdayTamil(name) {
  return 'இனிய பிறந்தநாள் வாழ்த்துகள், ' + name + '! இந்த ஆண்டு மகிழ்ச்சியாக அமைய பள்ளியின் அனைவரும் வாழ்த்துகிறோம்.';
}
function resultsTamil(examName) {
  return examName + ' மதிப்பெண்கள் வந்துவிட்டன. பார்க்க இங்கே தொடவும்.';
}

module.exports = {
  taDate, both,
  DISCIPLINE, DISCIPLINE_CODES, disciplineMessage,
  defaulterTamil, absentTamil, birthdayTamil, resultsTamil
};
