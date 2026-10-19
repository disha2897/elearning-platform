// progress.js: course progress for students, and the tracking views for teachers.
// Progress is always calculated from real records, never stored as a percentage.
//
// FORMULA: every lecture, every assignment given to the student, and every test that has at
// least one question counts as one learning unit. A unit is complete when:
//   lecture    -> the student pressed "Mark as completed" (row in lecture_progress)
//   assignment -> a submission exists (opening it does not count)
//   test       -> the attempt has been submitted (score recorded)
// Overall % = completed units / total units, rounded. A course with no units shows 0%
// and the status "No activities". Overdue = not submitted and past the deadline.
module.exports = function (app, { requireLogin, requireRole, safe, admin }) {
  const student = [requireLogin, requireRole('student')];
  const teacher = [requireLogin, requireRole('teacher')];
  const visibleTo = (a, sid) => !a.assigned_to || a.assigned_to.includes(sid);
  const isActive = (r) => r.access_type === 'paid' || new Date(r.expires_at).getTime() > Date.now();
  const pct = (d, t) => (t ? Math.round((d * 100) / t) : 0);
  const rows = async (query) => { const r = await query; if (r.error) throw new Error(r.error.message); return r.data || []; };

  // Progress for each student in studentIds: { studentId: [one object per course] }
  async function build(studentIds, onlyCourse) {
    const out = {};
    studentIds.forEach((id) => { out[id] = []; });
    if (!studentIds.length) return out;
    let q = admin.from('student_course').select('student_id, course_id, access_type, expires_at').in('student_id', studentIds);
    if (onlyCourse) q = q.eq('course_id', onlyCourse);
    const enrol = await rows(q);
    const courseIds = [...new Set(enrol.map((e) => e.course_id))];
    if (!courseIds.length) return out;

    const [courses, lectures, tests, assignments] = await Promise.all([
      rows(admin.from('course').select('course_id, course_name').in('course_id', courseIds)),
      rows(admin.from('lecture').select('lecture_id, lecture_title, course_id').in('course_id', courseIds)),
      rows(admin.from('test').select('test_id, test_name, course_id, total_marks').in('course_id', courseIds)),
      rows(admin.from('assignment').select('assignment_id, course_id, title, due_date, assigned_to').in('course_id', courseIds))
    ]);
    const lecIds = lectures.map((l) => l.lecture_id);
    const testIds = tests.map((t) => t.test_id);
    const asIds = assignments.map((a) => a.assignment_id);
    const [qs, lp, subs, att] = await Promise.all([
      testIds.length ? rows(admin.from('question').select('test_id').in('test_id', testIds)) : [],
      lecIds.length ? rows(admin.from('lecture_progress').select('student_id, lecture_id').in('student_id', studentIds).in('lecture_id', lecIds)) : [],
      asIds.length ? rows(admin.from('assignment_submission').select('student_id, assignment_id, marks, graded_at').in('student_id', studentIds).in('assignment_id', asIds)) : [],
      testIds.length ? rows(admin.from('attempts').select('student_id, test_id, score, submitted_at').in('student_id', studentIds).in('test_id', testIds)) : []
    ]);
    const names = {}; courses.forEach((c) => { names[c.course_id] = c.course_name; });
    const hasQuestions = new Set(qs.map((x) => x.test_id));
    const lpSet = new Set(lp.map((x) => x.student_id + ':' + x.lecture_id));
    const subMap = new Map(subs.map((x) => [x.student_id + ':' + x.assignment_id, x]));
    const attMap = new Map(att.map((x) => [x.student_id + ':' + x.test_id, x]));
    const now = Date.now();

    for (const e of enrol) {
      const sid = e.student_id;
      const lec = lectures.filter((l) => l.course_id === e.course_id)
        .map((l) => ({ lecture_id: l.lecture_id, title: l.lecture_title, done: lpSet.has(sid + ':' + l.lecture_id) }));
      const asg = assignments.filter((a) => a.course_id === e.course_id && visibleTo(a, sid))
        .sort((a, b) => new Date(a.due_date) - new Date(b.due_date)).map((a) => {
          const s = subMap.get(sid + ':' + a.assignment_id);
          const overdue = !s && new Date(a.due_date).getTime() < now;
          return { assignment_id: a.assignment_id, title: a.title, due_date: a.due_date,
            status: s ? (s.graded_at ? 'graded' : 'submitted') : (overdue ? 'overdue' : 'pending'),
            marks: s && s.graded_at ? s.marks : null };
        });
      const tst = tests.filter((t) => t.course_id === e.course_id && hasQuestions.has(t.test_id)).map((t) => {
        const a = attMap.get(sid + ':' + t.test_id);
        const done = !!a && (a.score != null || !!a.submitted_at);
        return { test_id: t.test_id, name: t.test_name, done, score: done ? a.score : null, total_marks: t.total_marks };
      });
      const lDone = lec.filter((x) => x.done).length;
      const aDone = asg.filter((x) => x.status === 'submitted' || x.status === 'graded').length;
      const aOver = asg.filter((x) => x.status === 'overdue').length;
      const tDone = tst.filter((x) => x.done).length;
      const total = lec.length + asg.length + tst.length;
      const done = lDone + aDone + tDone;
      const overall = pct(done, total);
      let status = 'In progress';
      if (!total) status = 'No activities';
      else if (overall === 100) status = 'Completed';
      else if (aOver > 0) status = 'Behind';
      else if (done === 0) status = 'Not started';
      out[sid].push({
        course_id: e.course_id, course_name: names[e.course_id] || 'Course',
        access: e.access_type === 'paid' ? 'Paid' : (isActive(e) ? 'Demo' : 'Demo ended'),
        overall_pct: overall, status, pending_count: total - done,
        lectures: { total: lec.length, done: lDone, remaining: lec.length - lDone, pct: pct(lDone, lec.length), items: lec },
        assignments: { total: asg.length, done: aDone, pending: asg.length - aDone - aOver, overdue: aOver, pct: pct(aDone, asg.length), items: asg },
        tests: { total: tst.length, done: tDone, pending: tst.length - tDone, pct: pct(tDone, tst.length), items: tst }
      });
    }
    return out;
  }

  // A student's own progress in every course (the id comes from the login token, never from the request)
  app.get('/api/progress/me', ...student, safe(async (req, res) => {
    const sid = req.profile.student_id;
    res.json((await build([sid]))[sid]);
  }));

  // Which lectures of this student are completed (used for the buttons in the course page)
  app.get('/api/courses/:id/lecture-status', ...student, safe(async (req, res) => {
    const r = await req.db.from('lecture_progress').select('lecture_id').eq('student_id', req.profile.student_id);
    if (r.error) return res.status(500).json({ error: r.error.message });
    res.json(r.data.map((x) => x.lecture_id));
  }));

  app.post('/api/lectures/:id/complete', ...student, safe(async (req, res) => {
    const id = Number(req.params.id);
    const sid = req.profile.student_id;
    const done = req.body.done !== false;
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid lecture.' });
    const lec = await admin.from('lecture').select('lecture_id, course_id').eq('lecture_id', id).maybeSingle();
    if (lec.error) return res.status(500).json({ error: lec.error.message });
    if (!lec.data) return res.status(404).json({ error: 'Lecture not found.' });
    const acc = await admin.from('student_course').select('access_type, expires_at')
      .eq('student_id', sid).eq('course_id', lec.data.course_id).maybeSingle();
    if (!acc.data || !isActive(acc.data)) {
      return res.status(403).json({ error: 'Start a free demo or enroll in this course first.' });
    }
    const r = done
      ? await req.db.from('lecture_progress').upsert({ student_id: sid, lecture_id: id }, { onConflict: 'student_id,lecture_id', ignoreDuplicates: true })
      : await req.db.from('lecture_progress').delete().eq('student_id', sid).eq('lecture_id', id);
    if (r.error) return res.status(400).json({ error: r.error.message });
    res.json({ message: done ? 'Lecture marked as completed.' : 'Lecture marked as not completed.' });
  }));

  // ---------- TEACHERS ----------
  // Everyone enrolled in a course, with summary numbers. Optional ?q=name-or-email and ?status=
  app.get('/api/progress/course/:id', ...teacher, safe(async (req, res) => {
    const courseId = Number(req.params.id);
    if (!Number.isInteger(courseId)) return res.status(400).json({ error: 'Invalid course.' });
    const ids = (await rows(admin.from('student_course').select('student_id').eq('course_id', courseId))).map((x) => x.student_id);
    const people = ids.length ? await rows(admin.from('students').select('student_id, name, email').in('student_id', ids).order('name')) : [];
    const prog = await build(ids, courseId);
    let list = people.map((p) => ({ student: p, progress: prog[p.student_id][0] })).filter((r) => r.progress);
    const summary = {
      students: list.length,
      avg_pct: list.length ? Math.round(list.reduce((s, r) => s + r.progress.overall_pct, 0) / list.length) : 0,
      with_pending: list.filter((r) => r.progress.pending_count > 0).length,
      not_started: list.filter((r) => r.progress.status === 'Not started').length,
      behind: list.filter((r) => r.progress.status === 'Behind').length
    };
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) list = list.filter((r) => String(r.student.name || '').toLowerCase().includes(q) || String(r.student.email || '').toLowerCase().includes(q));
    if (req.query.status) list = list.filter((r) => r.progress.status === req.query.status);
    res.json({ summary, rows: list });
  }));

  app.get('/api/progress/student/:id', ...teacher, safe(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid student.' });
    const s = await admin.from('students').select('student_id, name, email').eq('student_id', id).maybeSingle();
    if (!s.data) return res.status(404).json({ error: 'Student not found.' });
    res.json({ student: s.data, courses: (await build([id]))[id] });
  }));
  // A certificate is only given when the student's own progress in the course is 100%
  app.get('/api/certificate/:courseId', ...student, safe(async (req, res) => {
    const courseId = Number(req.params.courseId);
    const sid = req.profile.student_id;
    if (!Number.isInteger(courseId)) return res.status(400).json({ error: 'Invalid course.' });
    const p = (await build([sid], courseId))[sid][0];
    if (!p) return res.status(404).json({ error: 'You are not enrolled in this course.' });
    if (p.status !== 'Completed') {
      return res.status(403).json({ error: 'Complete every lecture, assignment and test of this course to get your certificate.' });
    }
    res.json({ student_name: req.profile.name, course_name: p.course_name, issued_on: new Date().toISOString() });
  }));
};