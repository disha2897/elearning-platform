// announcements.js: a teacher sends a message to every student who currently has access to a course.
// It uses your existing notification table, so students see it in the bell.
module.exports = function (app, { requireLogin, requireRole, safe, admin }) {
  app.post('/api/courses/:id/announce', requireLogin, requireRole('teacher'), safe(async (req, res) => {
    const courseId = Number(req.params.id);
    const text = String((req.body || {}).message || '').trim();
    if (!Number.isInteger(courseId)) return res.status(400).json({ error: 'Invalid course.' });
    if (text.length < 3 || text.length > 500) {
      return res.status(400).json({ error: 'Please write an announcement of 3 to 500 characters.' });
    }
    const course = await admin.from('course').select('course_id, course_name').eq('course_id', courseId).maybeSingle();
    if (!course.data) return res.status(404).json({ error: 'Course not found.' });

    const enrol = await admin.from('student_course').select('student_id, access_type, expires_at').eq('course_id', courseId);
    const now = Date.now();
    const ids = (enrol.data || [])
      .filter((x) => x.access_type === 'paid' || new Date(x.expires_at).getTime() > now)
      .map((x) => x.student_id);
    if (!ids.length) return res.status(400).json({ error: 'No students currently have access to this course.' });

    const stamp = Date.now();
    const build = (type) => ids.map((sid) => ({
      student_id: sid, course_id: courseId, assignment_id: null, type,
      message: 'Announcement from ' + course.data.course_name + ': ' + text,
      dedupe_key: 'ann:' + courseId + ':' + stamp + ':' + sid
    }));
    let r = await admin.from('notification').insert(build('announcement'));
    if (r.error) r = await admin.from('notification').insert(build('reminder')); // in case the type column only allows known types
    if (r.error) {
      console.error('Could not send announcement:', r.error.message);
      return res.status(400).json({ error: 'Could not send the announcement: ' + r.error.message });
    }
    res.json({ sent: ids.length });
  }));
};