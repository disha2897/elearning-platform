require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_KEY, SUPABASE_SECRET_KEY, TEACHER_CODE } = process.env;
if (!SUPABASE_URL || !SUPABASE_KEY || !SUPABASE_SECRET_KEY || !TEACHER_CODE) {
  console.error('Missing values in .env. You need SUPABASE_URL, SUPABASE_KEY, SUPABASE_SECRET_KEY and TEACHER_CODE.');
  process.exit(1);
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };

// Client for visitors who are not logged in
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, options);

// Admin client (secret key). Only used on the server.
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, options);

// Client used only to send "forgot password" emails (the link carries the login tokens in the address)
const resetClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, flowType: 'implicit' }
});

// Client that acts as one specific logged-in user (so the database rules apply to them)
const clientFor = (token) =>
  createClient(SUPABASE_URL, SUPABASE_KEY, {
    ...options,
    global: { headers: { Authorization: 'Bearer ' + token } }
  });

const app = express();
app.set('trust proxy', 1); // so the site address is right when the app runs behind a host like Render
app.use(express.json());
app.use(express.static('public'));

const DEMO_DAYS = 30;
const PAYMENT_METHODS = ['UPI', 'Card', 'Net Banking'];
const GRACE_MS = 60 * 1000; // extra time allowed for a test submission to arrive
const DAY_MS = 24 * 60 * 60 * 1000;
// Optional: set SITE_URL in .env (for example https://my-site.onrender.com) so reset emails link to the right place
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');

// Wraps a route so a crash becomes a friendly error instead of stopping the server
const safe = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  });

// Finds out whether a login belongs to a student or a teacher
async function findProfile(userId) {
  const s = await admin.from('students').select('*').eq('auth_id', userId).maybeSingle();
  if (s.data) return { role: 'student', profile: s.data };
  const t = await admin.from('faculty').select('*').eq('auth_id', userId).maybeSingle();
  if (t.data) return { role: 'teacher', profile: t.data };
  return null;
}

// Does this student currently have access (paid, or an unexpired demo) to a course?
async function hasAccess(studentId, courseId) {
  const r = await admin.from('student_course').select('access_type, expires_at')
    .eq('student_id', studentId).eq('course_id', courseId).maybeSingle();
  if (!r.data) return false;
  return r.data.access_type === 'paid' || new Date(r.data.expires_at).getTime() > Date.now();
}

// Students who currently have access (paid, or an unexpired demo) to a course
async function activeStudentIds(courseId) {
  const r = await admin.from('student_course').select('student_id, access_type, expires_at').eq('course_id', courseId);
  const now = Date.now();
  return (r.data || [])
    .filter((x) => x.access_type === 'paid' || new Date(x.expires_at).getTime() > now)
    .map((x) => x.student_id);
}

// An assignment with no "assigned_to" list is for the whole course; otherwise only for the listed students
const visibleTo = (assignment, studentId) =>
  !assignment.assigned_to || assignment.assigned_to.includes(studentId);

// Deadline as text in Indian time, used inside notification messages
const fmtDue = (iso) =>
  new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
  });

// Saves notifications. A row whose dedupe_key already exists is skipped, so nothing is sent twice.
async function notify(rows) {
  if (!rows.length) return;
  const r = await admin.from('notification').upsert(rows, { onConflict: 'dedupe_key', ignoreDuplicates: true });
  if (r.error) console.error('Could not save notifications:', r.error.message);
}

// Creates "deadline is close" reminders for one student. Runs whenever the bell is refreshed,
// so no timer or scheduled job is needed. Each assignment gets at most one reminder per stage.
async function createReminders(studentId) {
  const acc = await admin.from('student_course').select('course_id, access_type, expires_at').eq('student_id', studentId);
  const now = Date.now();
  const courseIds = (acc.data || [])
    .filter((x) => x.access_type === 'paid' || new Date(x.expires_at).getTime() > now)
    .map((x) => x.course_id);
  if (!courseIds.length) return;

  const list = await admin.from('assignment')
    .select('assignment_id, course_id, title, due_date, assigned_to')
    .in('course_id', courseIds)
    .gt('due_date', new Date(now).toISOString())
    .lte('due_date', new Date(now + 3 * DAY_MS).toISOString());
  const mine = (list.data || []).filter((a) => visibleTo(a, studentId));
  if (!mine.length) return;

  const subs = await admin.from('assignment_submission').select('assignment_id')
    .eq('student_id', studentId).in('assignment_id', mine.map((a) => a.assignment_id));
  const done = new Set((subs.data || []).map((s) => s.assignment_id));

  const courses = await admin.from('course').select('course_id, course_name').in('course_id', courseIds);
  const names = {};
  (courses.data || []).forEach((c) => { names[c.course_id] = c.course_name; });

  const rows = [];
  for (const a of mine) {
    if (done.has(a.assignment_id)) continue;
    const urgent = new Date(a.due_date).getTime() - now <= DAY_MS;
    rows.push({
      student_id: studentId,
      course_id: a.course_id,
      assignment_id: a.assignment_id,
      type: 'reminder',
      message: (urgent ? 'Due in less than 24 hours: "' : 'Deadline coming up: "') + a.title + '" in ' +
        (names[a.course_id] || 'your course') + ' (due ' + fmtDue(a.due_date) + '). You have not submitted it yet.',
      dedupe_key: (urgent ? 'r24:' : 'r72:') + a.assignment_id + ':' + studentId
    });
  }
  await notify(rows);
}

// Adds up the marks of a test's questions and saves the total on the test
async function recalcTotal(testId) {
  const q = await admin.from('question').select('marks').eq('test_id', testId);
  const total = (q.data || []).reduce((sum, x) => sum + x.marks, 0);
  await admin.from('test').update({ total_marks: total }).eq('test_id', testId);
  return total;
}

// Checks the login token and works out the role
const requireLogin = safe(async (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Please log in first.' });
  const db = clientFor(token);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
  const found = await findProfile(data.user.id);
  if (!found) return res.status(403).json({ error: 'This account has no student or teacher profile.' });
  req.user = data.user;
  req.db = db;
  req.role = found.role;
  req.profile = found.profile;
  next();
});

// Only lets one role through
const requireRole = (role) => (req, res, next) => {
  if (req.role !== role) {
    return res.status(403).json({ error: 'This action is only for ' + role + 's.' });
  }
  next();
};

// ---------- SIGNUP / LOGIN ----------
app.post('/api/signup', safe(async (req, res) => {
  const { role, name, email, password, teacherCode, qualification, specialization } = req.body;
  if (role !== 'student' && role !== 'teacher') {
    return res.status(400).json({ error: 'Please choose student or teacher.' });
  }
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Please fill in your name, email and password.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (role === 'teacher' && String(teacherCode || '').trim() !== TEACHER_CODE) {
    return res.status(403).json({ error: 'Wrong teacher code.' });
  }

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
    app_metadata: { role }
  });
  if (created.error) return res.status(400).json({ error: created.error.message });
  const userId = created.data.user.id;

  const table = role === 'teacher' ? 'faculty' : 'students';
  const row = role === 'teacher'
    ? { name, email, auth_id: userId, qualification: qualification || null, specialization: specialization || null }
    : { name, email, auth_id: userId };
  const inserted = await admin.from(table).insert(row);
  if (inserted.error) {
    await admin.auth.admin.deleteUser(userId);
    const msg = inserted.error.code === '23505'
      ? 'A profile with this email already exists. Please use a different email.'
      : inserted.error.message;
    return res.status(400).json({ error: msg });
  }
  res.json({ message: 'Account created.' });
}));

app.post('/api/login', safe(async (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Please enter your email and password.' });
  }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  const found = await findProfile(data.user.id);
  if (!found) return res.status(403).json({ error: 'This account has no student or teacher profile.' });
  if (role && role !== found.role) {
    return res.status(403).json({ error: 'This is a ' + found.role + ' account. Please use the ' + found.role + ' login.' });
  }
  res.json({ token: data.session.access_token, role: found.role });
}));

// ---------- FORGOT / RESET PASSWORD ----------
// Step 1: the user types their email. Supabase emails them a link that opens this site.
app.post('/api/forgot-password', safe(async (req, res) => {
  const email = String(req.body.email || '').trim();
  if (!email) return res.status(400).json({ error: 'Please enter your email.' });
  const base = SITE_URL || (req.protocol + '://' + req.get('host'));
  const { error } = await resetClient.auth.resetPasswordForEmail(email, { redirectTo: base });
  if (error) {
    console.error('Password reset email error:', error.message);
    if (error.status === 429) {
      return res.status(429).json({ error: 'Too many reset emails were requested. Please wait a few minutes and try again.' });
    }
  }
  // Same answer whether or not the email exists, so nobody can use this to find out who has an account
  res.json({ message: 'If an account exists for that email, a password reset link has been sent. Please check your inbox and spam folder.' });
}));

// Step 2: the page sends the token from the email link plus the new password.
app.post('/api/reset-password', safe(async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Please enter a new password.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  }
  const updated = await admin.auth.admin.updateUserById(data.user.id, { password });
  if (updated.error) return res.status(400).json({ error: updated.error.message });
  res.json({ message: 'Your password was changed. You can log in now.' });
}));

// Who am I? For students this also lists course access and test attempts
app.get('/api/me', requireLogin, safe(async (req, res) => {
  let access = [];
  let attempts = [];
  if (req.role === 'student') {
    const sid = req.profile.student_id;
    const r = await req.db.from('student_course')
      .select('course_id, access_type, expires_at')
      .eq('student_id', sid);
    if (r.error) return res.status(500).json({ error: r.error.message });
    const now = Date.now();
    access = r.data.map((x) => ({
      course_id: x.course_id,
      access_type: x.access_type,
      expires_at: x.expires_at,
      active: x.access_type === 'paid' || new Date(x.expires_at).getTime() > now
    }));
    const a = await req.db.from('attempts').select('test_id, score, submitted_at').eq('student_id', sid);
    if (a.error) return res.status(500).json({ error: a.error.message });
    attempts = a.data;
  }
  res.json({ role: req.role, profile: req.profile, access, attempts, demoUsed: !!req.profile.demo_used_at });
}));

// ---------- COURSES (anyone can view) ----------
app.get('/api/courses', safe(async (req, res) => {
  const { data, error } = await supabase.from('course').select('*').order('course_id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

app.get('/api/courses/:id', safe(async (req, res) => {
  const id = req.params.id;
  const lectures = await supabase
    .from('lecture')
    .select('lecture_id, lecture_title, lecture_type, lecture_date, faculty(name)')
    .eq('course_id', id)
    .order('lecture_date');
  const tests = await supabase
    .from('test')
    .select('test_id, test_name, test_date, duration, total_marks')
    .eq('course_id', id)
    .order('test_date');
  if (lectures.error || tests.error) {
    return res.status(500).json({ error: (lectures.error || tests.error).message });
  }
  res.json({ lectures: lectures.data, tests: tests.data });
}));

// Add a new course (teachers only)
app.post('/api/courses', requireLogin, requireRole('teacher'), safe(async (req, res) => {
  const { course_name, description, duration, fee, category } = req.body;
  if (!course_name || !category) {
    return res.status(400).json({ error: 'Course name and category are required.' });
  }
  if (Number(duration) < 0 || Number(fee) < 0) {
    return res.status(400).json({ error: 'Duration and fee cannot be negative.' });
  }
  const { data, error } = await req.db.from('course').insert({
    course_name,
    description: description || null,
    duration: duration ? Number(duration) : null,
    fee: fee ? Number(fee) : null,
    category
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

// ---------- FREE DEMO (students only, one per account) ----------
app.post('/api/demo', requireLogin, requireRole('student'), safe(async (req, res) => {
  const courseId = Number(req.body.course_id);
  if (!courseId) return res.status(400).json({ error: 'Please choose a course.' });
  const studentId = req.profile.student_id;

  const course = await admin.from('course').select('course_id').eq('course_id', courseId).maybeSingle();
  if (!course.data) return res.status(404).json({ error: 'Course not found.' });

  const existing = await admin.from('student_course').select('course_id')
    .eq('student_id', studentId).eq('course_id', courseId).maybeSingle();
  if (existing.data) return res.status(400).json({ error: 'You already have access to this course.' });

  const claim = await admin.from('students')
    .update({ demo_used_at: new Date().toISOString() })
    .eq('student_id', studentId)
    .is('demo_used_at', null)
    .select('student_id');
  if (claim.error) return res.status(500).json({ error: claim.error.message });
  if (!claim.data.length) return res.status(400).json({ error: 'You have already used your free demo.' });

  const expires = new Date(Date.now() + DEMO_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const inserted = await admin.from('student_course').insert({
    student_id: studentId,
    course_id: courseId,
    access_type: 'demo',
    expires_at: expires
  });
  if (inserted.error) {
    await admin.from('students').update({ demo_used_at: null }).eq('student_id', studentId);
    return res.status(400).json({ error: inserted.error.message });
  }
  res.json({ message: 'Your ' + DEMO_DAYS + '-day free demo has started.', expires_at: expires });
}));

// ---------- FAKE PAYMENT + ENROLL (students only) ----------
app.post('/api/pay', requireLogin, requireRole('student'), safe(async (req, res) => {
  const courseId = Number(req.body.course_id);
  const method = req.body.method;
  const shouldFail = req.body.simulate === 'fail';
  if (!courseId) return res.status(400).json({ error: 'Please choose a course.' });
  if (!PAYMENT_METHODS.includes(method)) {
    return res.status(400).json({ error: 'Please choose a payment method.' });
  }
  const studentId = req.profile.student_id;

  const course = await admin.from('course').select('course_id, course_name, fee')
    .eq('course_id', courseId).maybeSingle();
  if (!course.data) return res.status(404).json({ error: 'Course not found.' });
  if (course.data.fee == null) return res.status(400).json({ error: 'This course has no fee set.' });

  const existing = await admin.from('student_course').select('access_type')
    .eq('student_id', studentId).eq('course_id', courseId).maybeSingle();
  if (existing.data && existing.data.access_type === 'paid') {
    return res.status(400).json({ error: 'You are already enrolled in this course.' });
  }

  const payment = await admin.from('payment').insert({
    student_id: studentId,
    course_id: courseId,
    amount: course.data.fee,
    payment_date: new Date().toISOString().slice(0, 10),
    payment_method: method,
    payment_status: shouldFail ? 'Failed' : 'Paid'
  }).select().single();
  if (payment.error) return res.status(400).json({ error: payment.error.message });

  if (!shouldFail) {
    const access = await admin.from('student_course').upsert(
      { student_id: studentId, course_id: courseId, access_type: 'paid', expires_at: null },
      { onConflict: 'student_id,course_id' }
    );
    if (access.error) return res.status(500).json({ error: access.error.message });
  }
  res.json({ status: payment.data.payment_status, payment: payment.data, course_name: course.data.course_name });
}));

// ---------- TESTS: TEACHER SIDE ----------
// Create a test
app.post('/api/tests', requireLogin, requireRole('teacher'), safe(async (req, res) => {
  const { course_id, test_name, duration, test_date } = req.body;
  const mins = Number(duration);
  if (!course_id || !test_name) {
    return res.status(400).json({ error: 'Please enter a test name.' });
  }
  if (!Number.isInteger(mins) || mins < 1 || mins > 300) {
    return res.status(400).json({ error: 'Duration must be a whole number between 1 and 300 minutes.' });
  }
  const course = await admin.from('course').select('course_id').eq('course_id', Number(course_id)).maybeSingle();
  if (!course.data) return res.status(404).json({ error: 'Course not found.' });
  const { data, error } = await admin.from('test').insert({
    course_id: Number(course_id),
    test_name,
    duration: mins,
    test_date: test_date || new Date().toISOString().slice(0, 10),
    total_marks: 0
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

// Everything a teacher needs to manage one test: questions (with answers) and results
app.get('/api/tests/:id/manage', requireLogin, requireRole('teacher'), safe(async (req, res) => {
  const id = Number(req.params.id);
  const test = await admin.from('test').select('*').eq('test_id', id).maybeSingle();
  if (!test.data) return res.status(404).json({ error: 'Test not found.' });
  const questions = await admin.from('question').select('*').eq('test_id', id).order('question_id');
  const results = await admin.from('attempts').select('score, submitted_at, students(name)').eq('test_id', id);
  const err = questions.error || results.error;
  if (err) return res.status(500).json({ error: err.message });
  res.json({ test: test.data, questions: questions.data, results: results.data });
}));

// Add a question
app.post('/api/tests/:id/questions', requireLogin, requireRole('teacher'), safe(async (req, res) => {
  const id = Number(req.params.id);
  const { question_text, option_a, option_b, option_c, option_d } = req.body;
  const correct = String(req.body.correct_option || '').toLowerCase();
  const marks = req.body.marks === '' || req.body.marks == null ? 1 : Number(req.body.marks);
  if (!question_text || !option_a || !option_b || !option_c || !option_d) {
    return res.status(400).json({ error: 'Please fill in the question and all four options.' });
  }
  if (!['a', 'b', 'c', 'd'].includes(correct)) {
    return res.status(400).json({ error: 'Please choose the correct option.' });
  }
  if (!Number.isInteger(marks) || marks < 1 || marks > 100) {
    return res.status(400).json({ error: 'Marks must be a whole number between 1 and 100.' });
  }
  const test = await admin.from('test').select('test_id').eq('test_id', id).maybeSingle();
  if (!test.data) return res.status(404).json({ error: 'Test not found.' });
  const { data, error } = await admin.from('question').insert({
    test_id: id, question_text, option_a, option_b, option_c, option_d, correct_option: correct, marks
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  const total = await recalcTotal(id);
  res.json({ question: data, total_marks: total });
}));

// Delete a question
app.delete('/api/questions/:id', requireLogin, requireRole('teacher'), safe(async (req, res) => {
  const id = Number(req.params.id);
  const q = await admin.from('question').select('test_id').eq('question_id', id).maybeSingle();
  if (!q.data) return res.status(404).json({ error: 'Question not found.' });
  const { error } = await admin.from('question').delete().eq('question_id', id);
  if (error) return res.status(400).json({ error: error.message });
  await recalcTotal(q.data.test_id);
  res.json({ message: 'Deleted.' });
}));

// ---------- TESTS: STUDENT SIDE ----------
// Start (or resume) a test. Questions are sent WITHOUT the correct answers.
app.post('/api/tests/:id/start', requireLogin, requireRole('student'), safe(async (req, res) => {
  const testId = Number(req.params.id);
  const studentId = req.profile.student_id;

  const test = await admin.from('test')
    .select('test_id, course_id, test_name, duration, total_marks').eq('test_id', testId).maybeSingle();
  if (!test.data) return res.status(404).json({ error: 'Test not found.' });
  if (!(await hasAccess(studentId, test.data.course_id))) {
    return res.status(403).json({ error: 'Start a free demo or enroll in this course to take its tests.' });
  }

  const questions = await admin.from('question')
    .select('question_id, question_text, option_a, option_b, option_c, option_d, marks')
    .eq('test_id', testId).order('question_id');
  if (questions.error) return res.status(500).json({ error: questions.error.message });
  if (!questions.data.length) return res.status(400).json({ error: 'This test has no questions yet.' });

  const found = await admin.from('attempts').select('*')
    .eq('student_id', studentId).eq('test_id', testId).maybeSingle();
  let attempt = found.data;
  const limitMs = test.data.duration * 60 * 1000;

  if (attempt && (attempt.score != null || attempt.submitted_at)) {
    return res.status(400).json({ error: 'You have already taken this test.' });
  }

  if (attempt && attempt.started_at) {
    // Resuming a test that was started earlier
    const elapsed = Date.now() - new Date(attempt.started_at).getTime();
    if (elapsed > limitMs + GRACE_MS) {
      await admin.from('attempts')
        .update({ score: 0, submitted_at: new Date().toISOString() })
        .eq('student_id', studentId).eq('test_id', testId);
      return res.status(400).json({ error: 'Time ran out for this test earlier, so your score was recorded as 0.' });
    }
  } else {
    const created = await admin.from('attempts')
      .insert({ student_id: studentId, test_id: testId, started_at: new Date().toISOString() })
      .select().single();
    if (created.error) return res.status(400).json({ error: created.error.message });
    attempt = created.data;
  }

  const elapsed = Date.now() - new Date(attempt.started_at).getTime();
  const secondsLeft = Math.max(0, Math.floor((limitMs - elapsed) / 1000));
  res.json({ test: test.data, questions: questions.data, seconds_left: secondsLeft });
}));

// Submit answers. The server does the marking.
app.post('/api/tests/:id/submit', requireLogin, requireRole('student'), safe(async (req, res) => {
  const testId = Number(req.params.id);
  const studentId = req.profile.student_id;

  const test = await admin.from('test').select('duration').eq('test_id', testId).maybeSingle();
  if (!test.data) return res.status(404).json({ error: 'Test not found.' });

  const found = await admin.from('attempts').select('*')
    .eq('student_id', studentId).eq('test_id', testId).maybeSingle();
  const attempt = found.data;
  if (!attempt || !attempt.started_at || attempt.score != null || attempt.submitted_at) {
    return res.status(400).json({ error: 'There is no test in progress to submit.' });
  }

  const limitMs = test.data.duration * 60 * 1000;
  const late = Date.now() - new Date(attempt.started_at).getTime() > limitMs + GRACE_MS;

  const questions = await admin.from('question').select('*').eq('test_id', testId).order('question_id');
  if (questions.error) return res.status(500).json({ error: questions.error.message });

  const answers = req.body.answers || {};
  let score = 0;
  let total = 0;
  const review = questions.data.map((q) => {
    const given = String(answers[q.question_id] || '').toLowerCase();
    const isCorrect = given === q.correct_option;
    total += q.marks;
    if (isCorrect) score += q.marks;
    const label = (letter) => letter ? letter.toUpperCase() + '. ' + q['option_' + letter] : 'No answer';
    return {
      question_text: q.question_text,
      your: ['a', 'b', 'c', 'd'].includes(given) ? label(given) : 'No answer',
      correct: label(q.correct_option),
      is_correct: isCorrect
    };
  });
  if (late) score = 0;

  const saved = await admin.from('attempts')
    .update({ score, submitted_at: new Date().toISOString() })
    .eq('student_id', studentId).eq('test_id', testId);
  if (saved.error) return res.status(500).json({ error: saved.error.message });

  res.json({ score, total, late, review });
}));

// ---------- ASSIGNMENTS: TEACHER SIDE ----------
// Students who can be given an assignment in a course (paid or active demo)
app.get('/api/courses/:id/students', requireLogin, requireRole('teacher'), safe(async (req, res) => {
  const ids = await activeStudentIds(Number(req.params.id));
  if (!ids.length) return res.json([]);
  const r = await admin.from('students').select('student_id, name, email').in('student_id', ids).order('name');
  if (r.error) return res.status(500).json({ error: r.error.message });
  res.json(r.data);
}));

// Create an assignment and notify the students who receive it
app.post('/api/assignments', requireLogin, requireRole('teacher'), safe(async (req, res) => {
  const { course_id, title, description, due_date, max_marks, student_ids } = req.body;
  const courseId = Number(course_id);
  const marks = max_marks === '' || max_marks == null ? 10 : Number(max_marks);
  const due = new Date(due_date);
  if (!courseId || !String(title || '').trim()) {
    return res.status(400).json({ error: 'Please enter a title for the assignment.' });
  }
  if (!due_date || isNaN(due.getTime())) {
    return res.status(400).json({ error: 'Please choose a deadline.' });
  }
  if (due.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'The deadline must be in the future.' });
  }
  if (!Number.isInteger(marks) || marks < 1 || marks > 1000) {
    return res.status(400).json({ error: 'Maximum marks must be a whole number between 1 and 1000.' });
  }
  const course = await admin.from('course').select('course_id, course_name').eq('course_id', courseId).maybeSingle();
  if (!course.data) return res.status(404).json({ error: 'Course not found.' });

  // No students picked = the whole course. Otherwise only the picked students who are enrolled.
  const active = await activeStudentIds(courseId);
  let assignedTo = null;
  if (Array.isArray(student_ids) && student_ids.length) {
    assignedTo = student_ids.map(Number).filter((id) => active.includes(id));
    if (!assignedTo.length) {
      return res.status(400).json({ error: 'None of the selected students are enrolled in this course.' });
    }
  }

  const created = await admin.from('assignment').insert({
    course_id: courseId,
    title: String(title).trim(),
    description: String(description || '').trim() || null,
    due_date: due.toISOString(),
    max_marks: marks,
    assigned_to: assignedTo
  }).select().single();
  if (created.error) return res.status(400).json({ error: created.error.message });
  const a = created.data;

  const recipients = assignedTo || active;
  await notify(recipients.map((sid) => ({
    student_id: sid,
    course_id: courseId,
    assignment_id: a.assignment_id,
    type: 'new_assignment',
    message: 'New assignment in ' + course.data.course_name + ': "' + a.title + '" (due ' + fmtDue(a.due_date) + ').',
    dedupe_key: 'new:' + a.assignment_id + ':' + sid
  })));
  res.json({ assignment: a, notified: recipients.length });
}));

// Submissions for one assignment, and who has not submitted yet
app.get('/api/assignments/:id/submissions', requireLogin, requireRole('teacher'), safe(async (req, res) => {
  const id = Number(req.params.id);
  const found = await admin.from('assignment').select('*').eq('assignment_id', id).maybeSingle();
  if (!found.data) return res.status(404).json({ error: 'Assignment not found.' });
  const a = found.data;
  const course = await admin.from('course').select('course_name').eq('course_id', a.course_id).maybeSingle();

  const subs = await admin.from('assignment_submission')
    .select('submission_id, student_id, answer_text, submitted_at, marks, feedback, graded_at')
    .eq('assignment_id', id).order('submitted_at');
  if (subs.error) return res.status(500).json({ error: subs.error.message });

  const expected = a.assigned_to || await activeStudentIds(a.course_id);
  const wanted = Array.from(new Set(expected.concat(subs.data.map((s) => s.student_id))));
  const people = wanted.length
    ? await admin.from('students').select('student_id, name, email').in('student_id', wanted)
    : { data: [] };
  const byId = {};
  (people.data || []).forEach((p) => { byId[p.student_id] = p; });

  const submissions = subs.data.map((s) => ({ ...s, student: byId[s.student_id] || { name: 'Unknown student' } }));
  const submittedIds = new Set(subs.data.map((s) => s.student_id));
  const notSubmitted = expected.filter((sid) => !submittedIds.has(sid)).map((sid) => byId[sid]).filter(Boolean);

  res.json({
    assignment: a,
    course_name: course.data ? course.data.course_name : '',
    submissions,
    not_submitted: notSubmitted
  });
}));

// Give marks and feedback, then notify the student
app.post('/api/submissions/:id/grade', requireLogin, requireRole('teacher'), safe(async (req, res) => {
  const id = Number(req.params.id);
  const marks = Number(req.body.marks);
  const feedback = String(req.body.feedback || '').trim();
  if (req.body.marks === '' || req.body.marks == null || !Number.isInteger(marks) || marks < 0) {
    return res.status(400).json({ error: 'Please enter marks as a whole number (0 or more).' });
  }
  if (feedback.length > 1000) return res.status(400).json({ error: 'Feedback is too long (1000 characters at most).' });

  const sub = await admin.from('assignment_submission').select('*').eq('submission_id', id).maybeSingle();
  if (!sub.data) return res.status(404).json({ error: 'Submission not found.' });
  const found = await admin.from('assignment').select('*').eq('assignment_id', sub.data.assignment_id).maybeSingle();
  const a = found.data;
  if (marks > a.max_marks) {
    return res.status(400).json({ error: 'Marks cannot be more than ' + a.max_marks + ' for this assignment.' });
  }
  const course = await admin.from('course').select('course_name').eq('course_id', a.course_id).maybeSingle();

  const gradedAt = new Date().toISOString();
  const saved = await admin.from('assignment_submission')
    .update({ marks, feedback: feedback || null, graded_at: gradedAt })
    .eq('submission_id', id);
  if (saved.error) return res.status(500).json({ error: saved.error.message });

  await notify([{
    student_id: sub.data.student_id,
    course_id: a.course_id,
    assignment_id: a.assignment_id,
    type: 'graded',
    message: 'Your assignment "' + a.title + '" in ' + (course.data ? course.data.course_name : 'your course') +
      ' was graded: ' + marks + ' / ' + a.max_marks + '.' + (feedback ? ' Feedback: ' + feedback : ''),
    dedupe_key: 'graded:' + id + ':' + Date.now()
  }]);
  res.json({ message: 'Grade saved and the student was notified.' });
}));

// ---------- ASSIGNMENTS: LIST AND DETAILS (teachers and students) ----------
// All assignments of a course. Students see only theirs, with their own submission status.
app.get('/api/courses/:id/assignments', requireLogin, safe(async (req, res) => {
  const courseId = Number(req.params.id);
  const list = await admin.from('assignment').select('*').eq('course_id', courseId).order('due_date');
  if (list.error) return res.status(500).json({ error: list.error.message });

  if (req.role === 'student') {
    const sid = req.profile.student_id;
    const rows = list.data.filter((a) => visibleTo(a, sid));
    const subs = rows.length
      ? await admin.from('assignment_submission').select('assignment_id, submitted_at, marks, graded_at')
          .eq('student_id', sid).in('assignment_id', rows.map((a) => a.assignment_id))
      : { data: [] };
    const bySub = {};
    (subs.data || []).forEach((s) => { bySub[s.assignment_id] = s; });
    return res.json(rows.map((a) => ({
      assignment_id: a.assignment_id,
      title: a.title,
      due_date: a.due_date,
      max_marks: a.max_marks,
      submission: bySub[a.assignment_id] || null
    })));
  }

  const ids = list.data.map((a) => a.assignment_id);
  const subs = ids.length
    ? await admin.from('assignment_submission').select('assignment_id, graded_at').in('assignment_id', ids)
    : { data: [] };
  const counts = {};
  (subs.data || []).forEach((s) => {
    const c = counts[s.assignment_id] || (counts[s.assignment_id] = { submitted: 0, graded: 0 });
    c.submitted += 1;
    if (s.graded_at) c.graded += 1;
  });
  res.json(list.data.map((a) => ({
    assignment_id: a.assignment_id,
    title: a.title,
    due_date: a.due_date,
    max_marks: a.max_marks,
    given_to: a.assigned_to ? a.assigned_to.length + ' selected' : 'All students',
    submitted: (counts[a.assignment_id] || { submitted: 0 }).submitted,
    graded: (counts[a.assignment_id] || { graded: 0 }).graded
  })));
}));

// One assignment with the logged-in student's own submission
app.get('/api/assignments/:id', requireLogin, requireRole('student'), safe(async (req, res) => {
  const id = Number(req.params.id);
  const sid = req.profile.student_id;
  const found = await admin.from('assignment').select('*').eq('assignment_id', id).maybeSingle();
  if (!found.data) return res.status(404).json({ error: 'Assignment not found.' });
  const a = found.data;
  if (!visibleTo(a, sid)) return res.status(403).json({ error: 'This assignment was not given to you.' });
  const course = await admin.from('course').select('course_name').eq('course_id', a.course_id).maybeSingle();
  const sub = await admin.from('assignment_submission').select('*')
    .eq('assignment_id', id).eq('student_id', sid).maybeSingle();
  res.json({
    assignment: {
      assignment_id: a.assignment_id,
      course_id: a.course_id,
      title: a.title,
      description: a.description,
      due_date: a.due_date,
      max_marks: a.max_marks
    },
    course_name: course.data ? course.data.course_name : '',
    submission: sub.data || null,
    can_submit: await hasAccess(sid, a.course_id)
  });
}));

// ---------- ASSIGNMENTS: STUDENT SUBMITS ----------
// Handing in is allowed after the deadline too, but it is marked late. Changes are allowed until it is graded.
app.post('/api/assignments/:id/submit', requireLogin, requireRole('student'), safe(async (req, res) => {
  const id = Number(req.params.id);
  const sid = req.profile.student_id;
  const answer = String(req.body.answer_text || '').trim();
  if (!answer) return res.status(400).json({ error: 'Please write your answer or paste a link to your work.' });
  if (answer.length > 10000) return res.status(400).json({ error: 'Your answer is too long (10000 characters at most).' });

  const found = await admin.from('assignment').select('*').eq('assignment_id', id).maybeSingle();
  if (!found.data) return res.status(404).json({ error: 'Assignment not found.' });
  const a = found.data;
  if (!visibleTo(a, sid)) return res.status(403).json({ error: 'This assignment was not given to you.' });
  if (!(await hasAccess(sid, a.course_id))) {
    return res.status(403).json({ error: 'Start a free demo or enroll in this course to submit assignments.' });
  }

  const existing = await admin.from('assignment_submission').select('graded_at')
    .eq('assignment_id', id).eq('student_id', sid).maybeSingle();
  if (existing.data && existing.data.graded_at) {
    return res.status(400).json({ error: 'This assignment has already been graded, so it cannot be changed.' });
  }

  const now = new Date();
  const late = now.getTime() > new Date(a.due_date).getTime();
  const saved = await admin.from('assignment_submission').upsert(
    { assignment_id: id, student_id: sid, answer_text: answer, submitted_at: now.toISOString() },
    { onConflict: 'assignment_id,student_id' }
  ).select().single();
  if (saved.error) return res.status(400).json({ error: saved.error.message });

  await notify([{
    student_id: sid,
    course_id: a.course_id,
    assignment_id: id,
    type: 'submitted',
    message: 'Your submission for "' + a.title + '" was received' + (late ? ' (marked late).' : '.'),
    dedupe_key: 'submitted:' + id + ':' + sid + ':' + now.getTime()
  }]);
  res.json({
    message: late ? 'Submitted. It arrived after the deadline, so it is marked late.' : 'Assignment submitted.',
    late
  });
}));

// ---------- NOTIFICATIONS (students) ----------
// The latest notifications and how many are unread. Also creates any deadline reminders that are due.
app.get('/api/notifications', requireLogin, requireRole('student'), safe(async (req, res) => {
  const sid = req.profile.student_id;
  try {
    await createReminders(sid);
  } catch (err) {
    console.error('Could not create reminders:', err.message); // the bell should still work
  }
  const list = await admin.from('notification').select('*')
    .eq('student_id', sid).order('created_at', { ascending: false }).limit(30);
  if (list.error) return res.status(500).json({ error: list.error.message });
  const unread = await admin.from('notification').select('notification_id', { count: 'exact', head: true })
    .eq('student_id', sid).eq('is_read', false);
  res.json({ notifications: list.data, unread: unread.count || 0 });
}));

// Mark one notification (body: { id }) or all of them (no id) as read
app.post('/api/notifications/read', requireLogin, requireRole('student'), safe(async (req, res) => {
  const sid = req.profile.student_id;
  let q = admin.from('notification').update({ is_read: true }).eq('student_id', sid).eq('is_read', false);
  if (req.body.id) q = q.eq('notification_id', Number(req.body.id));
  const r = await q;
  if (r.error) return res.status(500).json({ error: r.error.message });
  res.json({ message: 'Done.' });
}));

// ---------- STUDENTS ----------
// Teachers can list all students
app.get('/api/students', requireLogin, requireRole('teacher'), safe(async (req, res) => {
  const { data, error } = await req.db.from('students').select('student_id, name, email, address').order('student_id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

// A student can open only their own details; a teacher can open any student
app.get('/api/students/:id', requireLogin, safe(async (req, res) => {
  const id = req.params.id;
  if (req.role === 'student' && Number(id) !== req.profile.student_id) {
    return res.status(403).json({ error: 'You can only view your own details.' });
  }
  const student = await req.db.from('students').select('*').eq('student_id', id).single();
  const courses = await req.db
    .from('student_course')
    .select('access_type, expires_at, course(course_name, category)')
    .eq('student_id', id);
  const attempts = await req.db
    .from('attempts')
    .select('score, test(test_name, total_marks)')
    .eq('student_id', id);
  const payments = await req.db
    .from('payment')
    .select('payment_id, amount, payment_date, payment_method, payment_status, course(course_name)')
    .eq('student_id', id)
    .order('payment_date');
  const err = student.error || courses.error || attempts.error || payments.error;
  if (err) return res.status(500).json({ error: err.message });
  res.json({
    student: student.data,
    courses: courses.data,
    attempts: attempts.data,
    payments: payments.data
  });
}));

// Bookstore, cart and orders (see bookstore.js)
require('./bookstore')(app, { requireLogin, requireRole, safe });
// Course progress and teacher tracking (see progress.js)
require('./progress')(app, { requireLogin, requireRole, safe, admin });
// Lecture videos and live classes (see lectures.js)
require('./lectures')(app, { requireLogin, requireRole, safe, admin });
// Announcements to a course's students (see announcements.js)
require('./announcements')(app, { requireLogin, requireRole, safe, admin });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running at http://localhost:' + PORT));