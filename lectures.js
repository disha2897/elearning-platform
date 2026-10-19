// lectures.js: add lectures with recorded-video / live-class links, and watch them.
// Links are stored in lecture_media (see 005_lecture_videos.sql) and read with the user's own
// token, so the database rules decide who can see them.
module.exports = function (app, { requireLogin, requireRole, safe, admin }) {
  const teacher = [requireLogin, requireRole('teacher')];

  // Only https links are accepted
  function cleanLink(v, label) {
    const s = String(v || '').trim();
    if (!s) return { value: null };
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:' || s.length > 500) throw new Error('bad');
      return { value: u.href };
    } catch (e) {
      return { error: 'The ' + label + ' link must be a full https:// link (up to 500 characters).' };
    }
  }

  function readMedia(b) {
    const video = cleanLink(b.video_url, 'video');
    const live = cleanLink(b.live_url, 'live class');
    if (video.error || live.error) return { error: video.error || live.error };
    if (!video.value && !live.value) return { error: 'Please add a video link, a live class link, or both.' };
    let start = null;
    if (b.live_start) {
      const d = new Date(b.live_start);
      if (isNaN(d.getTime())) return { error: 'The live class date and time is not valid.' };
      start = d.toISOString();
    }
    return { media: { video_url: video.value, live_url: live.value, live_start: start } };
  }

  app.post('/api/courses/:id/lectures', ...teacher, safe(async (req, res) => {
    const courseId = Number(req.params.id);
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!Number.isInteger(courseId)) return res.status(400).json({ error: 'Invalid course.' });
    if (!title || title.length > 150) return res.status(400).json({ error: 'Please enter a lecture title (up to 150 characters).' });
    const type = String(b.type || '').trim();
    if (!type || type.length > 40) return res.status(400).json({ error: 'Please choose the lecture type.' });
    const m = readMedia(b);
    if (m.error) return res.status(400).json({ error: m.error });
    const course = await admin.from('course').select('course_id').eq('course_id', courseId).maybeSingle();
    if (!course.data) return res.status(404).json({ error: 'Course not found.' });

    const row = {
      course_id: courseId, lecture_title: title, lecture_type: type,
      lecture_date: b.date || new Date().toISOString().slice(0, 10)
    };
    // The lecture is linked to the teacher who adds it (the faculty id column is found automatically)
    const facultyKey = Object.keys(req.profile).find((k) => /^faculty.*_?id$/.test(k)) || (req.profile.id != null ? 'id' : null);
    if (facultyKey) row.faculty_id = req.profile[facultyKey];
    const ins = await admin.from('lecture').insert(row).select('lecture_id').single();
    if (ins.error) {
      console.error('Could not add lecture:', ins.error.message);
      return res.status(400).json({ error: 'Could not save the lecture: ' + ins.error.message });
    }

    const med = await req.db.from('lecture_media').insert({ lecture_id: ins.data.lecture_id, ...m.media });
    if (med.error) {
      console.error('Could not save lecture links:', med.error.message);
      await admin.from('lecture').delete().eq('lecture_id', ins.data.lecture_id); // do not keep a half-made lecture
      return res.status(400).json({ error: med.error.message });
    }
    res.json({ lecture_id: ins.data.lecture_id });
  }));

  // The lecture types already used in your database, so the form offers values your table accepts
  app.get('/api/lecture-types', ...teacher, safe(async (req, res) => {
    const r = await admin.from('lecture').select('lecture_type').limit(500);
    const types = [...new Set((r.data || []).map((x) => x.lecture_type).filter(Boolean))];
    res.json(types);
  }));

  app.put('/api/lectures/:id/media', ...teacher, safe(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid lecture.' });
    const m = readMedia(req.body || {});
    if (m.error) return res.status(400).json({ error: m.error });
    const r = await req.db.from('lecture_media').upsert({ lecture_id: id, ...m.media }, { onConflict: 'lecture_id' });
    if (r.error) return res.status(400).json({ error: r.error.message });
    res.json({ message: 'Lecture links saved.' });
  }));

  // One lecture with its links. Students need paid or active-demo access to the course.
  app.get('/api/lectures/:id/watch', requireLogin, safe(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid lecture.' });
    const lec = await admin.from('lecture').select('lecture_id, lecture_title, lecture_type, lecture_date, course_id')
      .eq('lecture_id', id).maybeSingle();
    if (!lec.data) return res.status(404).json({ error: 'Lecture not found.' });

    let completed = false;
    if (req.role === 'student') {
      const sid = req.profile.student_id;
      const acc = await admin.from('student_course').select('access_type, expires_at')
        .eq('student_id', sid).eq('course_id', lec.data.course_id).maybeSingle();
      const ok = acc.data && (acc.data.access_type === 'paid' || new Date(acc.data.expires_at).getTime() > Date.now());
      if (!ok) return res.status(403).json({ error: 'Start a free demo or enroll in this course to watch its lectures.' });
      const lp = await req.db.from('lecture_progress').select('lecture_id').eq('student_id', sid).eq('lecture_id', id).maybeSingle();
      completed = !!lp.data;
    }
    const med = await req.db.from('lecture_media').select('video_url, live_url, live_start').eq('lecture_id', id).maybeSingle();
    if (med.error) return res.status(500).json({ error: med.error.message });
    res.json({ lecture: lec.data, media: med.data || null, completed });
  }));
};