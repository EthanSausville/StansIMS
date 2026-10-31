// Security questions and confirming who you are (current password or
// answers). The answers are hashed and checked only by the database
// (public.set_security_answers / public.check_identity); this file has the
// question list, the "too easy" checks shown while typing, and the forms.
import { h, toast, niceError, passwordProblem, PASSWORD_RULE, MIN_PASSWORD } from './ui.js';
import { sb, state } from './store.js';

// Each question with its most common answers (written the way they're
// compared: lower case, no spaces or punctuation). An answer on its list gets
// a warning; the person can still keep it after being told.
export const QUESTIONS = [
  { key: 'pet', text: 'What was the name of your first pet?', common: ['max', 'bella', 'buddy', 'charlie', 'lucy', 'daisy', 'molly', 'bailey', 'rocky', 'lucky', 'fluffy', 'spot', 'tiger', 'sadie'] },
  { key: 'street', text: 'What street did you grow up on?', common: ['main', 'mainstreet', 'mainst', 'oak', 'oakstreet', 'maple', 'maplestreet', 'elm', 'elmstreet', 'park', 'parkavenue', 'washington', 'pine', 'cedar', 'first', 'firststreet', 'second', 'church'] },
  { key: 'car', text: 'What was the make and model of your first car?', common: ['hondacivic', 'toyotacorolla', 'hondaaccord', 'toyotacamry', 'fordfocus', 'fordmustang', 'fordf150', 'chevycavalier', 'jeepwrangler', 'nissanaltima', 'fordescort', 'ford', 'honda', 'toyota', 'chevy'] },
  { key: 'city', text: 'In what city were you born?', common: ['newyork', 'newyorkcity', 'nyc', 'chicago', 'losangeles', 'houston', 'philadelphia', 'detroit', 'boston', 'pittsburgh', 'cleveland', 'columbus', 'brooklyn'] },
  { key: 'school', text: 'What was the name of your elementary school?', common: ['lincoln', 'lincolnelementary', 'washington', 'washingtonelementary', 'jefferson', 'roosevelt', 'franklin', 'kennedy', 'stmarys', 'central', 'centralelementary', 'eastside', 'westside'] },
  { key: 'nickname', text: 'What was your childhood nickname?', common: ['buddy', 'bubba', 'junior', 'jr', 'sis', 'kiddo', 'princess', 'peanut', 'bud', 'tiger', 'sissy', 'champ', 'none'] },
  { key: 'friend', text: 'What was the first name of your best friend as a child?', common: ['michael', 'mike', 'chris', 'john', 'david', 'matt', 'sarah', 'jessica', 'ashley', 'jennifer', 'emily', 'james'] },
  { key: 'parents', text: 'In what city did your parents meet?', common: ['newyork', 'nyc', 'chicago', 'losangeles', 'detroit', 'boston', 'philadelphia', 'pittsburgh', 'cleveland', 'houston', 'college', 'school', 'church'] },
  { key: 'job', text: 'What was your first job?', common: ['mcdonalds', 'cashier', 'babysitter', 'babysitting', 'lifeguard', 'waiter', 'waitress', 'server', 'paperroute', 'paperboy', 'burgerking', 'walmart', 'busboy', 'dishwasher'] },
  { key: 'sibling', text: 'What is your oldest sibling’s middle name?', common: ['marie', 'lynn', 'ann', 'anne', 'michael', 'james', 'lee', 'elizabeth', 'rose', 'john', 'david', 'joseph', 'none'] },
  { key: 'teacher', text: 'What was the last name of your favorite teacher?', common: ['smith', 'johnson', 'williams', 'brown', 'jones', 'miller', 'davis', 'wilson', 'anderson', 'taylor', 'thomas', 'moore'] },
  { key: 'food', text: 'What food did you hate most as a child?', common: ['broccoli', 'brusselsprouts', 'spinach', 'peas', 'liver', 'mushrooms', 'onions', 'asparagus', 'beets', 'cauliflower', 'tomatoes', 'carrots'] },
];
export const questionText = (key) => QUESTIONS.find((q) => q.key === key)?.text || key;

// Same as public.normalize_answer: not case sensitive, spaces and punctuation ignored.
export const normalizeAnswer = (a) => String(a || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const WEAK = new Set(['none', 'null', 'nothing', 'na', 'idk', 'dontknow', 'unknown', 'test', 'testing', 'password', 'asdf', 'qwerty', 'abcd', 'abc123',
  'yes', 'nope', 'same', 'secret', 'answer', 'stans', 'stansims', '1234', '12345', '123456', '0000']);

// Something that has to change before it can be saved ('' if fine).
export function answerProblem(answer, others = []) {
  const n = normalizeAnswer(answer);
  if (!n) return 'Type an answer.';
  if (n.length < 4) return 'Use at least 4 letters or numbers.';
  if (n.length > 100) return 'Use 100 characters or fewer.';
  if (WEAK.has(n) || /^(.)\1*$/.test(n) || (/^\d+$/.test(n) && n.length < 6)) return 'That’s too easy to guess.';
  if (others.some((o) => o && normalizeAnswer(o) === n)) return 'Use a different answer for each question.';
  const mine = normalizeAnswer((state.user?.email || '').split('@')[0]);
  if (mine && n === mine) return 'Don’t use your email as an answer.';
  return '';
}
// A warning when it's one of the most common answers to that question.
export function answerWarning(key, answer) {
  const n = normalizeAnswer(answer); const q = QUESTIONS.find((x) => x.key === key);
  return q && n && q.common.includes(n) ? 'This is one of the most common answers to this question, so it isn’t secure. Add something only you would know, like “Rex the beagle” instead of “Rex”.' : '';
}

// ---------- the database ----------
// The questions the signed-in person picked ([] if none), or null when the
// database doesn't have security questions yet (before the next deploy).
export async function myQuestions() {
  if (!state.user) return null;
  const { data, error } = await sb.from('security_answers').select('slot,question,updated_at').eq('user_id', state.user.id).order('slot');
  if (error) return null;
  return data || [];
}
export async function questionsByUser() {
  const { data, error } = await sb.from('security_answers').select('user_id,slot,updated_at');
  if (error) return null;
  const m = new Map(); for (const r of data || []) m.set(r.user_id, (m.get(r.user_id) || 0) + 1);
  return m;
}
export async function saveAnswers(items, password) {
  const { data, error } = await sb.rpc('set_security_answers', { p_items: items, p_password: password || null });
  if (error) throw error;
  if (data) throw new Error(data);
}
export async function resetAnswers(userId) {
  const { error } = await sb.rpc('reset_security_answers', { p_user: userId });
  if (error) throw error;
}

// Changes your own password after confirming it's you: { password, current_password } or { password, answers: [{slot, answer}] }.
// Through the Worker when it has its key (the check can't be skipped there);
// otherwise the same database check, then the change from this browser.
export async function changeMyPassword(body) {
  const bad = passwordProblem(body.password); if (bad) throw new Error(bad);
  if (window.__MOCK_PASSWORD_API__) return window.__MOCK_PASSWORD_API__(body);
  const { data: { session } } = await sb.auth.getSession();
  let res = null; let data = null;
  try {
    res = await fetch('/api/account/password', { method: 'POST', headers: { Authorization: `Bearer ${session?.access_token || ''}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), credentials: 'omit', cache: 'no-store' });
    try { data = await res.json(); } catch { /* not JSON */ }
  } catch { /* offline or no Worker */ }
  if (res && res.ok && data?.ok) return;
  if (res && !res.ok && data?.error) throw new Error(data.error);
  // No Worker key (or no Worker): check, then change.
  const { data: ok, error } = await sb.rpc('check_identity', { p_password: body.current_password || null, p_answers: body.current_password ? null : body.answers });
  if (error) throw error;
  if (ok !== true) throw new Error(body.current_password ? 'Your current password isn’t right.' : 'Those answers aren’t right.');
  const { error: e2 } = await sb.auth.updateUser({ password: body.password });
  if (e2) throw new Error(/reauth/i.test(e2.message) ? 'For safety, sign out and back in, then change your password.' : e2.message);
}

// ---------- forms ----------
// Three question pickers with answers, warnings as you type. Returns
// { el, read() } where read() gives the items to save, or throws what to fix.
// The first time it finds only "common answer" warnings it stops to show them;
// asked again with the same answers, it lets them through.
export function questionPicker(existing = []) {
  const rows = [0, 1, 2].map((i) => {
    const picked = existing[i]?.question || QUESTIONS[[0, 2, 4][i]].key;
    const select = h('select', { 'aria-label': `Question ${i + 1}` }, QUESTIONS.map((q) => h('option', { value: q.key, selected: q.key === picked }, q.text)));
    const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: 100, 'aria-label': `Answer ${i + 1}`, placeholder: 'Your answer' });
    const note = h('div', { class: 'sq-note', 'aria-live': 'polite' });
    return { select, input, note, el: h('div', { class: 'sq-row' }, h('label', { class: 'field' }, `Question ${i + 1}`, select), h('label', { class: 'field' }, 'Answer', input), note) };
  });
  let acknowledged = '';
  const refresh = (touched) => {
    const keys = rows.map((r) => r.select.value);
    rows.forEach((r, i) => {
      // A question picked in another row can't be picked again.
      for (const o of r.select.options) o.disabled = keys.some((k, j) => j !== i && k === o.value);
      if (!touched?.has(r)) return;
      const others = rows.filter((x) => x !== r).map((x) => x.input.value);
      const bad = r.input.value ? answerProblem(r.input.value, others) : '';
      const warn = !bad && r.input.value ? answerWarning(r.select.value, r.input.value) : '';
      r.note.textContent = bad || warn; r.note.className = `sq-note ${bad ? 'bad' : warn ? 'warn' : ''}`;
    });
  };
  const touched = new Set();
  for (const r of rows) {
    r.select.addEventListener('change', () => { touched.add(r); refresh(touched); });
    r.input.addEventListener('input', () => { touched.add(r); refresh(touched); });
  }
  refresh();
  return {
    el: h('div', { class: 'sq-list' }, rows.map((r) => r.el)),
    read() {
      rows.forEach((r) => touched.add(r)); refresh(touched);
      const keys = rows.map((r) => r.select.value);
      if (new Set(keys).size < 3) throw new Error('Pick three different questions.');
      for (const r of rows) {
        const bad = answerProblem(r.input.value, rows.filter((x) => x !== r).map((x) => x.input.value));
        if (bad) { r.input.focus(); throw new Error(bad); }
      }
      const items = rows.map((r) => ({ question: r.select.value, answer: r.input.value.trim() }));
      const warned = rows.filter((r) => answerWarning(r.select.value, r.input.value));
      const sig = JSON.stringify(items);
      if (warned.length && acknowledged !== sig) {
        acknowledged = sig; warned[0].input.focus();
        throw new Error(`${warned.length === 1 ? 'One answer is' : `${warned.length} answers are`} among the most common, so ${warned.length === 1 ? 'it isn’t' : 'they aren’t'} secure. Change ${warned.length === 1 ? 'it' : 'them'}, or save again to keep ${warned.length === 1 ? 'it' : 'them'} anyway.`);
      }
      return items;
    },
  };
}

// Answer boxes for your own questions (to confirm it's you).
export function answerBoxes(questions) {
  const inputs = questions.map((q) => h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: 100, 'aria-label': questionText(q.question) }));
  return {
    el: h('div', { class: 'sq-list' }, questions.map((q, i) => h('label', { class: 'field' }, questionText(q.question), inputs[i]))),
    read() {
      if (inputs.some((x) => !x.value.trim())) throw new Error('Answer all of your security questions.');
      return questions.map((q, i) => ({ slot: q.slot, answer: inputs[i].value }));
    },
    clear() { inputs.forEach((x) => { x.value = ''; }); },
  };
}

// The screen shown after signing in until the person has set their questions.
export function setupScreen(app, done) {
  const picker = questionPicker();
  const msg = h('div', { class: 'msg bad', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Save and continue');
  app.replaceChildren(h('div', { class: 'auth' }, h('form', { class: 'sq-setup', onsubmit: async (e) => {
      e.preventDefault(); msg.textContent = '';
      let items; try { items = picker.read(); } catch (err) { msg.className = 'msg warn'; msg.textContent = err.message; return; }
      btn.disabled = true;
      try { await saveAnswers(items); toast('Security questions saved.'); done(); }
      catch (err) { msg.className = 'msg bad'; msg.textContent = niceError(err); btn.disabled = false; }
    } },
    h('h1', null, 'Set up your ', h('span', null, 'security questions')),
    h('p', null, 'Before you continue, pick three questions and answer them. You’ll use them to prove it’s you, for example to change your password or if you forget it.'),
    h('p', { class: 'small muted' }, 'Answers aren’t case sensitive, and spaces and punctuation don’t matter. Make them hard to guess: add a detail only you would know. Nobody, admins included, can see your answers.'),
    picker.el, btn, msg,
    h('div', { class: 'links' }, h('button', { type: 'button', onclick: () => sb.auth.signOut() }, 'Sign out')))));
}

// Settings → My Account: change password (confirmed by current password or
// security answers) and your security questions.
export function accountSecurityCards(rerender) {
  if (accountSecurityCards.st?.user !== state.user?.id) accountSecurityCards.st = { user: state.user?.id, questions: undefined, loading: false, how: 'password', editing: false };
  const st = accountSecurityCards.st;
  if (st.questions === undefined && !st.loading) {
    st.loading = true;
    myQuestions().then((q) => { st.questions = q; }).finally(() => { st.loading = false; rerender(); });
  }
  const hasQ = Array.isArray(st.questions) && st.questions.length > 0;
  if (!hasQ) st.how = 'password';

  // Change password
  const cur = h('input', { type: 'password', autocomplete: 'current-password', maxlength: 200, 'aria-label': 'Current password' });
  const answers = hasQ ? answerBoxes(st.questions) : null;
  const p1 = h('input', { type: 'password', autocomplete: 'new-password', minlength: MIN_PASSWORD, maxlength: 72, 'aria-label': 'New password' });
  const p2 = h('input', { type: 'password', autocomplete: 'new-password', minlength: MIN_PASSWORD, maxlength: 72, 'aria-label': 'New password again' });
  const change = async (e) => {
    e.preventDefault();
    const bad = passwordProblem(p1.value); if (bad) { toast(bad, 'bad'); return; }
    if (p1.value !== p2.value) { toast('The two new passwords don’t match.', 'bad'); return; }
    let body;
    try { body = st.how === 'password' ? { password: p1.value, current_password: cur.value } : { password: p1.value, answers: answers.read() }; }
    catch (err) { toast(err.message, 'bad'); return; }
    if (st.how === 'password' && !cur.value) { toast('Enter your current password.', 'bad'); cur.focus(); return; }
    try { await changeMyPassword(body); toast('Password changed.'); cur.value = ''; p1.value = ''; p2.value = ''; answers?.clear(); }
    catch (err) { toast(niceError(err), 'bad'); }
  };
  const how = hasQ ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Confirm it’s you with' },
    h('button', { type: 'button', 'aria-pressed': String(st.how === 'password'), onclick: () => { st.how = 'password'; rerender(); } }, 'Current password'),
    h('button', { type: 'button', 'aria-pressed': String(st.how === 'answers'), onclick: () => { st.how = 'answers'; rerender(); } }, 'Security questions')) : null;
  const pwCard = h('form', { class: 'set-card', onsubmit: change }, h('h2', null, 'Change password'),
    h('p', { class: 'small muted' }, 'First confirm it’s you.'), how,
    st.how === 'password' ? h('label', { class: 'field' }, 'Current password', cur) : answers.el,
    h('label', { class: 'field' }, `New password (${PASSWORD_RULE})`, p1), h('label', { class: 'field' }, 'New password again', p2),
    h('div', { class: 'set-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Change password')));

  // Security questions
  let qCard;
  if (st.questions === null) qCard = null; // not in the database yet
  else if (st.questions === undefined) qCard = h('section', { class: 'set-card' }, h('h2', null, 'Security questions'), h('p', { class: 'muted' }, 'Loading…'));
  else if (!st.editing) {
    qCard = h('section', { class: 'set-card' }, h('h2', null, 'Security questions'),
      hasQ ? h('ol', { class: 'sq-mine' }, st.questions.map((q) => h('li', null, questionText(q.question)))) : h('p', { class: 'muted' }, 'Not set yet.'),
      h('p', { class: 'small muted' }, 'Your answers are kept scrambled; nobody can see them.'),
      h('div', { class: 'set-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => { st.editing = true; rerender(); } }, hasQ ? 'Change security questions' : 'Set security questions')));
  } else {
    const picker = questionPicker(st.questions);
    const pw = h('input', { type: 'password', autocomplete: 'current-password', maxlength: 200, 'aria-label': 'Current password for questions' });
    qCard = h('form', { class: 'set-card sq-edit', onsubmit: async (e) => {
        e.preventDefault();
        let items; try { items = picker.read(); } catch (err) { toast(err.message, 'bad'); return; }
        if (hasQ && !pw.value) { toast('Enter your current password.', 'bad'); pw.focus(); return; }
        try { await saveAnswers(items, pw.value); toast('Security questions saved.'); st.editing = false; st.questions = undefined; rerender(); }
        catch (err) { toast(niceError(err), 'bad'); }
      } },
      h('h2', null, 'Security questions'), picker.el,
      hasQ ? h('label', { class: 'field' }, 'Current password', pw) : null,
      h('div', { class: 'set-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
        h('button', { class: 'btn', type: 'button', onclick: () => { st.editing = false; rerender(); } }, 'Cancel')));
  }
  return [pwCard, qCard];
}
