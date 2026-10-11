require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY in your .env file.');
  process.exit(1);
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };

// Client for visitors who are not logged in
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, options);

// Client that acts as one specific logged-in user (so the database rules apply to them)
const clientFor = (token) =>
  createClient(SUPABASE_URL, SUPABASE_KEY, {
    ...options,
    global: { headers: { Authorization: 'Bearer ' + token } }
  });

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Wraps a route so a crash becomes a friendly error instead of stopping the server
const safe = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  });

// Checks the login token. Routes that use this are only for logged-in users.
const requireLogin = safe(async (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Please log in first.' });
  const db = clientFor(token);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
  req.user = data.user;
  req.db = db;
  next();
});

// Finds the student row that belongs to the logged-in user
async function myStudent(req) {
  const { data } = await req.db.from('students').select('*').eq('auth_id', req.user.id).maybeSingle();
  return data;
}

// ---------- SIGNUP / LOGIN ----------
app.post('/api/signup', safe(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Please fill in your name, email and password.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const { error } = await supabase.auth.signUp({ email, password, options: { data: { name } } });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Account created. You can log in now.' });
}));

app.post('/api/login', safe(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Please enter your email and password.' });
  }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ token: data.session.access_token });
}));

// Who am I? Also creates the student profile the first time
app.get('/api/me', requireLogin, safe(async (req, res) => {
  let student = await myStudent(req);
  if (!student) {
    const created = await req.db.from('students').insert({
      name: (req.user.user_metadata && req.user.user_metadata.name) || req.user.email,
      email: req.user.email,
      auth_id: req.user.id
    }).select().single();
    if (created.error) {
      const msg = created.error.code === '23505'
        ? 'A student with this email already exists. Please sign up with a different email.'
        : created.error.message;
      return res.status(400).json({ error: msg });
    }
    student = created.data;
  }
  const enrolled = await req.db.from('student_course').select('course_id').eq('student_id', student.student_id);
  if (enrolled.error) return res.status(500).json({ error: enrolled.error.message });
  res.json({ student, enrolled: enrolled.data.map((r) => r.course_id) });
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
    .select('lecture_title, lecture_type, lecture_date, faculty(name)')
    .eq('course_id', id)
    .order('lecture_date');
  const tests = await supabase
    .from('test')
    .select('test_name, test_date, duration, total_marks')
    .eq('course_id', id)
    .order('test_date');
  if (lectures.error || tests.error) {
    return res.status(500).json({ error: (lectures.error || tests.error).message });
  }
  res.json({ lectures: lectures.data, tests: tests.data });
}));

// Add a new course (logged-in users only)
app.post('/api/courses', requireLogin, safe(async (req, res) => {
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

// ---------- ENROLL / UNENROLL (logged-in users, for themselves only) ----------
app.post('/api/enroll', requireLogin, safe(async (req, res) => {
  const courseId = Number(req.body.course_id);
  if (!courseId) return res.status(400).json({ error: 'Please choose a course.' });
  const me = await myStudent(req);
  if (!me) return res.status(400).json({ error: 'Student profile not found.' });
  const { error } = await req.db.from('student_course').insert({ student_id: me.student_id, course_id: courseId });
  if (error) {
    const msg = error.code === '23505' ? 'You are already enrolled in this course.' : error.message;
    return res.status(400).json({ error: msg });
  }
  res.json({ message: 'Enrolled!' });
}));

app.delete('/api/enroll/:courseId', requireLogin, safe(async (req, res) => {
  const me = await myStudent(req);
  if (!me) return res.status(400).json({ error: 'Student profile not found.' });
  const { error } = await req.db.from('student_course').delete()
    .eq('student_id', me.student_id)
    .eq('course_id', req.params.courseId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Unenrolled.' });
}));

// ---------- STUDENTS (logged-in users only) ----------
app.get('/api/students', requireLogin, safe(async (req, res) => {
  const { data, error } = await req.db.from('students').select('student_id, name, email, address').order('student_id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

app.get('/api/students/:id', requireLogin, safe(async (req, res) => {
  const id = req.params.id;
  const student = await req.db.from('students').select('*').eq('student_id', id).single();
  const courses = await req.db
    .from('student_course')
    .select('course(course_name, category)')
    .eq('student_id', id);
  const attempts = await req.db
    .from('attempts')
    .select('score, test(test_name, total_marks)')
    .eq('student_id', id);
  const payments = await req.db
    .from('payment')
    .select('amount, payment_date, payment_method, payment_status, course(course_name)')
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running at http://localhost:' + PORT));