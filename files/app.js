// ============================================================
//  SCHOOLBOOK — app.js  (ES Module, imported by all pages)
//  Supabase backend · no localStorage auth
// ============================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ── ⚙️  CONFIG — replace with your Supabase project values ──
const SUPABASE_URL      = 'https://megyiswltpoziicyujbl.supabase.co';
const SUPABASE_ANON_KEY = 'PASTE_YOUR_SUPABASE_ANON_KEY_HERE';
// ────────────────────────────────────────────────────────────

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── AUTH ─────────────────────────────────────────────────────

export async function getSessionUser() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  return profile || null;
}

export async function requireAuth(allowedRoles = null) {
  const profile = await getSessionUser();
  if (!profile) { location.href = 'index.html'; return null; }
  if (profile.status === 'pending') { location.href = 'pending.html'; return null; }
  if (profile.status === 'rejected') { location.href = 'index.html'; return null; }
  if (allowedRoles && !allowedRoles.includes(profile.role)) {
    location.href = 'dashboard.html'; return null;
  }
  return profile;
}

export async function logout() {
  await supabase.auth.signOut();
  location.href = 'index.html';
}

// ── BOOKINGS ─────────────────────────────────────────────────

export async function getMyBookings(userId) {
  const { data, error } = await supabase
    .from('bookings')
    .select('*, approval_steps(*)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getAllBookings() {
  const { data, error } = await supabase
    .from('bookings')
    .select('*, approval_steps(*), profiles(name, role, school_id)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getBookingById(id) {
  const { data, error } = await supabase
    .from('bookings')
    .select('*, approval_steps(*), profiles(name, role, school_id)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

export async function createBooking(booking, steps) {
  const { data, error } = await supabase
    .from('bookings')
    .insert(booking)
    .select()
    .single();
  if (error) throw error;
  // Insert approval steps linked to the new booking
  const stepsWithId = steps.map(s => ({ ...s, booking_id: data.id }));
  const { error: stErr } = await supabase.from('approval_steps').insert(stepsWithId);
  if (stErr) throw stErr;
  return data;
}

export async function updateBookingStatus(id, status, currentStep) {
  const { error } = await supabase
    .from('bookings')
    .update({ status, current_step: currentStep })
    .eq('id', id);
  if (error) throw error;
}

// ── APPROVAL STEPS ───────────────────────────────────────────

export async function getPendingForApprover(role) {
  const labelMap = {
    faculty:   'Faculty Approval',
    custodian: 'Property Custodian',
    finance:   'Finance Office',
    president: 'School President',
  };
  const label = labelMap[role];
  if (!label) return [];

  const { data, error } = await supabase
    .from('approval_steps')
    .select('*, bookings(*, profiles(name, role, school_id), approval_steps(*))')
    .eq('label', label)
    .eq('status', 'pending');
  if (error) throw error;

  // Only return steps where all prior steps are done
  return (data || []).filter(step => {
    const allSteps = step.bookings?.approval_steps || [];
    return allSteps
      .filter(s => s.step_order < step.step_order && s.status !== 'skipped')
      .every(s => s.status === 'approved');
  });
}

export async function getHistoryForApprover(role) {
  const labelMap = {
    faculty:   'Faculty Approval',
    custodian: 'Property Custodian',
    finance:   'Finance Office',
    president: 'School President',
  };
  const label = labelMap[role];
  if (!label) return [];
  const { data, error } = await supabase
    .from('approval_steps')
    .select('*, bookings(*, profiles(name, role, school_id))')
    .eq('label', label)
    .in('status', ['approved', 'rejected'])
    .order('acted_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function actOnStep(stepId, bookingId, action, note, booking) {
  // 1. Update the step
  await supabase.from('approval_steps').update({
    status: action,
    note: note || (action === 'approved' ? 'Approved.' : 'Rejected.'),
    acted_at: new Date().toISOString(),
  }).eq('id', stepId);

  // 2. Fetch all steps fresh
  const { data: allSteps } = await supabase
    .from('approval_steps')
    .select('*')
    .eq('booking_id', bookingId)
    .order('step_order');

  let newStatus = 'inreview';
  let nextStep = booking.current_step;

  if (action === 'rejected') {
    newStatus = 'rejected';
    // Skip all remaining pending steps
    const remaining = allSteps.filter(s => s.status === 'pending' && s.id !== stepId);
    for (const s of remaining) {
      await supabase.from('approval_steps').update({
        status: 'skipped', note: 'Previous step rejected.', acted_at: new Date().toISOString()
      }).eq('id', s.id);
    }
  } else {
    // Find next pending step
    const nextPending = allSteps.find(s => s.status === 'pending' && s.id !== stepId);
    if (nextPending) {
      nextStep = nextPending.step_order;
      newStatus = 'inreview';
    } else {
      newStatus = 'approved';
      nextStep = allSteps.length;
    }
  }

  await updateBookingStatus(bookingId, newStatus, nextStep);
  return newStatus;
}

// ── CONFLICT CHECK ───────────────────────────────────────────

export async function hasConflict(facility, date, timeStart, timeEnd, excludeId = null) {
  let q = supabase
    .from('bookings')
    .select('id')
    .eq('facility', facility)
    .eq('date', date)
    .neq('status', 'rejected')
    .lt('time_start', timeEnd)
    .gt('time_end', timeStart);
  if (excludeId) q = q.neq('id', excludeId);
  const { data } = await q;
  return !!(data && data.length > 0);
}

// ── NOTIFICATIONS ────────────────────────────────────────────

export async function getNotifications(userId) {
  const { data } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
  return data || [];
}

export async function addNotification(userId, message) {
  if (!userId) return;
  await supabase.from('notifications').insert({ user_id: userId, message });
}

export async function markNotifsRead(userId) {
  await supabase.from('notifications').update({ read: true }).eq('user_id', userId).eq('read', false);
}

// ── PROFILES (admin) ─────────────────────────────────────────

export async function getAllProfiles() {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function updateProfileStatus(id, status) {
  const { error } = await supabase.from('profiles').update({ status }).eq('id', id);
  if (error) throw error;
}

export async function updateProfileRole(id, role) {
  const { error } = await supabase.from('profiles').update({ role }).eq('id', id);
  if (error) throw error;
}

// ── FORMAT HELPERS ───────────────────────────────────────────

export function formatDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-PH', { year:'numeric', month:'short', day:'numeric' });
}
export function formatDateTime(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-PH', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}
export function formatTime(t) {
  if (!t) return '—';
  const [h,m] = t.split(':').map(Number);
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`;
}
export function statusBadge(status) {
  const map = {
    pending:  ['status-pending',  'Pending'],
    inreview: ['status-inreview', 'In Review'],
    approved: ['status-approved', 'Approved'],
    rejected: ['status-rejected', 'Rejected'],
    skipped:  ['status-pending',  'N/A'],
  };
  const [cls, label] = map[status] || ['status-pending', status];
  return `<span class="status ${cls}">${label}</span>`;
}
export function stepIcon(s) { return s==='approved'||s==='skipped'?'✓':s==='rejected'?'✕':'·'; }
export function stepClass(s) { return s==='approved'||s==='skipped'?'done':s==='rejected'?'rejected':'pending'; }

export function showToast(message, type='info') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const icons = { info:'ℹ️', success:'✅', error:'❌', warning:'⚠️' };
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span>${icons[type]}</span><span>${message}</span>`;
  c.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ── NAV ──────────────────────────────────────────────────────

export function renderNav(user) {
  const roleNav = {
    student:   ['dashboard.html','book.html','my-bookings.html','calendar.html'],
    faculty:   ['dashboard.html','book.html','my-bookings.html','approvals.html','calendar.html'],
    custodian: ['dashboard.html','approvals.html','calendar.html'],
    finance:   ['dashboard.html','approvals.html','calendar.html'],
    president: ['dashboard.html','approvals.html','calendar.html','admin.html'],
  };
  const labels = {
    'dashboard.html':'Dashboard','book.html':'Book Facility',
    'my-bookings.html':'My Bookings','approvals.html':'Approvals',
    'calendar.html':'Calendar','admin.html':'Admin',
  };
  const links = (roleNav[user.role]||roleNav.student);
  const current = location.pathname.split('/').pop();
  const initials = user.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();

  return `
    <nav class="navbar">
      <a href="dashboard.html" class="nav-brand"><div class="dot"></div>SchoolBook</a>
      <div class="nav-links">
        ${links.map(h=>`<a href="${h}" class="${current===h?'active':''}">${labels[h]}</a>`).join('')}
      </div>
      <div class="nav-user">
        <button id="notif-btn" onclick="window._toggleNotifs()" style="background:transparent;border:none;cursor:pointer;position:relative;color:var(--text2);font-size:1.2rem;">
          🔔
          <span id="notif-badge" style="display:none;position:absolute;top:-4px;right:-4px;background:var(--danger);color:#fff;border-radius:50%;width:16px;height:16px;font-size:0.6rem;align-items:center;justify-content:center;"></span>
        </button>
        <div style="text-align:right;">
          <div style="font-size:0.85rem;font-weight:600;">${user.name}</div>
          <div style="font-size:0.72rem;color:var(--text3);">${user.school_id}</div>
          <span class="role-badge ${user.role}">${user.role}</span>
        </div>
        <div class="avatar" onclick="window._logout()" title="Logout">${initials}</div>
      </div>
    </nav>
    <div id="notif-panel" style="display:none;position:fixed;top:70px;right:1.5rem;z-index:150;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);width:320px;box-shadow:0 16px 40px rgba(0,0,0,0.5);">
      <div style="padding:1rem 1.2rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
        <span style="font-family:'Syne',sans-serif;font-weight:700;">Notifications</span>
        <button onclick="window._markRead()" style="background:transparent;border:none;cursor:pointer;font-size:0.75rem;color:var(--accent);">Mark all read</button>
      </div>
      <div id="notif-list" style="max-height:340px;overflow-y:auto;padding:0.5rem;"></div>
    </div>
    <div class="toast-container" id="toast-container"></div>
  `;
}

export async function initNotifs(user) {
  const notifs = await getNotifications(user.id);
  const unread = notifs.filter(n => !n.read).length;
  const badge = document.getElementById('notif-badge');
  if (badge && unread > 0) {
    badge.textContent = unread;
    badge.style.display = 'flex';
  }
  const list = document.getElementById('notif-list');
  if (list) {
    list.innerHTML = notifs.length ? notifs.map(n => `
      <div style="padding:10px 12px;border-radius:8px;margin-bottom:4px;background:${n.read?'transparent':'rgba(59,130,246,0.06)'};border:1px solid ${n.read?'transparent':'rgba(59,130,246,0.1)'};">
        <div style="font-size:0.85rem;color:var(--text);">${n.message}</div>
        <div style="font-size:0.72rem;color:var(--text3);margin-top:3px;">${formatDateTime(n.created_at)}</div>
      </div>
    `).join('') : '<div style="padding:1.5rem;text-align:center;color:var(--text3);font-size:0.85rem;">No notifications yet.</div>';
  }

  window._toggleNotifs = () => {
    const p = document.getElementById('notif-panel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
  };
  window._logout = logout;
  window._markRead = async () => {
    await markNotifsRead(user.id);
    if (badge) badge.style.display = 'none';
  };

  document.addEventListener('click', e => {
    const p = document.getElementById('notif-panel');
    const btn = document.getElementById('notif-btn');
    if (p && !p.contains(e.target) && btn && !btn.contains(e.target)) {
      p.style.display = 'none';
    }
  });
}
