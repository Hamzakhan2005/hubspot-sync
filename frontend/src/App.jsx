import { useEffect, useState, useCallback } from "react";

const API = import.meta.env.VITE_API_URL;

// Pick up token from OAuth redirect (#token=...)
if (location.hash.startsWith("#token=")) {
  localStorage.setItem("token", location.hash.slice(7));
  history.replaceState(null, "", location.pathname);
}

async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${localStorage.getItem("token")}`,
    },
  });
  if (r.status === 401) {
    localStorage.removeItem("token");
    throw new Error("unauthorized");
  }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [contacts, setContacts] = useState({ contacts: [], total: 0 });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const hasToken = !!localStorage.getItem("token");

  const loadStatus = useCallback(
    () =>
      api("/api/status")
        .then(setStatus)
        .catch(() => setStatus(null)),
    []
  );
  const loadContacts = useCallback(() => {
    setLoading(true);
    api(`/api/contacts?page=${page}&q=${encodeURIComponent(search)}`)
      .then(setContacts)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [page, search]);

  useEffect(() => {
    if (hasToken) loadStatus();
  }, [hasToken, loadStatus]);
  useEffect(() => {
    if (status?.connected) loadContacts();
  }, [status?.connected, loadContacts]);

  // Poll while sync is running so contacts appear progressively
  useEffect(() => {
    if (!status?.connected) return;
    const s = status.sync?.status;
    if (s === "completed" || s === "failed") return;
    const t = setInterval(() => {
      loadStatus();
      loadContacts();
    }, 3000);
    return () => clearInterval(t);
  }, [status, loadStatus, loadContacts]);

  const connect = async () => {
    const { url } = await api("/auth/hubspot/url").catch(async () =>
      (await fetch(API + "/auth/hubspot/url")).json()
    );
    location.href = url;
  };

  return (
    <div
      style={{
        fontFamily: "sans-serif",
        maxWidth: 900,
        margin: "20px auto",
        padding: 12,
      }}
    >
      <h2>HubSpot Contact Sync</h2>
      <div style={{ padding: 10, background: "#f4f4f4", marginBottom: 12 }}>
        {status?.connected ? (
          <>
            <b>Connected</b> (Hub {status.hubId}) · Sync:{" "}
            <b>{status.sync?.status || "pending"}</b> ·{" "}
            {status.sync?.synced_count ?? 0} contacts
            {status.sync?.last_error && (
              <div style={{ color: "crimson" }}>
                Error: {status.sync.last_error}
              </div>
            )}
          </>
        ) : (
          <span>Not connected </span>
        )}{" "}
        <button onClick={connect}>
          {status?.connected ? "Reconnect HubSpot" : "Connect HubSpot"}
        </button>
      </div>
      {error && <div style={{ color: "crimson" }}>{error}</div>}

      {status?.connected && (
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ flex: 1 }}>
            <input
              placeholder="Search..."
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
            />
            {loading && <div>Loading…</div>}
            <ul style={{ padding: 0, listStyle: "none" }}>
              {contacts.contacts.map((c) => (
                <li
                  key={c.id}
                  onClick={() => setSelected(c.id)}
                  style={{
                    cursor: "pointer",
                    padding: 6,
                    borderBottom: "1px solid #ddd",
                    background: selected === c.id ? "#e8f0ff" : "",
                  }}
                >
                  {[c.firstname, c.lastname].filter(Boolean).join(" ") ||
                    "(no name)"}
                  <br />
                  <small>{c.email}</small>
                </li>
              ))}
            </ul>
            <button disabled={page === 1} onClick={() => setPage(page - 1)}>
              Prev
            </button>{" "}
            Page {page} of {Math.max(1, Math.ceil(contacts.total / 20))}{" "}
            <button
              disabled={page * 20 >= contacts.total}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
          <div style={{ flex: 1 }}>
            {selected ? <Detail id={selected} /> : <i>Select a contact</i>}
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ id }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    () =>
      api(`/api/contacts/${id}`)
        .then(setData)
        .catch((e) => setMsg(e.message)),
    [id]
  );
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  // refresh while any note is still pending
  useEffect(() => {
    if (!data?.notes.some((n) => n.sync_status === "pending")) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [data, load]);

  const add = async () => {
    setSaving(true);
    setMsg("");
    try {
      await api(`/api/contacts/${id}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: text }),
      });
      setText("");
      setMsg("Note saved, syncing to HubSpot…");
      load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setSaving(false);
    }
  };
  const retry = (nid) =>
    api(`/api/notes/${nid}/retry`, { method: "POST" }).then(load);

  if (!data) return <div>Loading…</div>;
  const c = data.contact;
  return (
    <div>
      <h3>{[c.firstname, c.lastname].join(" ")}</h3>
      <div>
        {c.email}
        <br />
        {c.phone}
        <br />
        {c.company}
      </div>
      <h4>Notes</h4>
      <textarea
        rows={3}
        style={{ width: "100%" }}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button disabled={saving || !text.trim()} onClick={add}>
        {saving ? "Saving…" : "Add note"}
      </button>
      <div>{msg}</div>
      {data.notes.map((n) => (
        <div key={n.id} style={{ borderBottom: "1px solid #ddd", padding: 6 }}>
          {n.body}
          <br />
          <small>
            {new Date(n.created_at).toLocaleString()} · {n.sync_status}
            {n.sync_status === "failed" && (
              <>
                {" "}
                ·{" "}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    retry(n.id);
                  }}
                >
                  retry
                </a>
              </>
            )}
          </small>
        </div>
      ))}
    </div>
  );
}
