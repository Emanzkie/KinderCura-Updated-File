import React, { useEffect, useState } from 'react';

export default function AcceptInvitation() {
  const [code, setCode] = useState('');
  const [info, setInfo] = useState(null);
  const [message, setMessage] = useState(null);
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const q = params.get('code');
      if (q) {
        setCode(q);
        verify(q);
      }
    } catch (e) {
      // ignore in non-browser env
    }
  }, []);

  async function verify(c) {
    setMessage(null);
    try {
      const res = await fetch(`/api/v2/guardians/verify/${encodeURIComponent(c)}`);
      const body = await res.json();
      setInfo(body);
    } catch (err) {
      console.error(err);
      setMessage('Failed to verify invitation.');
    }
  }

  async function accept() {
    setMessage(null);
    if (!token) return setMessage('You must be logged in to accept this invitation.');
    try {
      const res = await fetch('/api/v2/guardians/accept-invitation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code }),
      });
      const body = await res.json();
      if (res.ok && body.success) {
        setMessage('Invitation accepted. You now have access to the child profile.');
      } else {
        setMessage(body.error || JSON.stringify(body));
      }
    } catch (err) {
      console.error(err);
      setMessage('Failed to accept invitation.');
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 720 }}>
      <h2>Accept Guardian Invitation</h2>
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', marginBottom: 6 }}>Invitation code or link</label>
        <input value={code} onChange={(e) => setCode(e.target.value)} style={{ padding: 8, minWidth: 360 }} placeholder="Paste code or use ?code=..." />
        <button onClick={() => verify(code)} style={{ marginLeft: 8, padding: '8px 12px' }}>
          Verify
        </button>
      </div>

      {info && (
        <div style={{ marginTop: 12, padding: 12, background: '#fafafa', borderRadius: 6 }}>
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(info, null, 2)}</pre>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <button onClick={accept} style={{ padding: '8px 12px' }}>
          Accept
        </button>
      </div>

      {message && <div style={{ marginTop: 16, color: '#333' }}>{message}</div>}

      {!token && (
        <div style={{ marginTop: 12, color: 'darkred' }}>
          You are not logged in. Create an account or log in, then return to accept the invitation.
        </div>
      )}
    </div>
  );
}
