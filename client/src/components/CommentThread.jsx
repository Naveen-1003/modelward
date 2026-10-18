import React, { useCallback, useEffect, useRef, useState } from "react";
import api, { extractError } from "../api/axios.js";
import { useToast } from "../context/ToastContext.jsx";
import { Loading, ErrorBox } from "./ui.jsx";
import { MAX_COMMENT, fmtDateTime, roleLabel, useMounted } from "./featureUtils.js";

// Immutable discussion thread on a version (oldest first).
export default function CommentThread({ versionId }) {
  const toast = useToast();
  const mounted = useMounted();
  const reqId = useRef(0);
  const currentVersion = useRef(versionId); // which version the thread is showing right now
  currentVersion.current = versionId;
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const { data } = await api.get(`/versions/${versionId}/comments`);
      if (id === reqId.current) {
        setComments(Array.isArray(data.comments) ? data.comments : []);
        setError("");
      }
    } catch (err) {
      if (id === reqId.current) setError(extractError(err));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [versionId]);

  useEffect(() => {
    setComments([]);
    setBody("");
    setLoading(true);
    load();
    return () => {
      reqId.current += 1; // drop in-flight responses for the old version
    };
  }, [load]);

  async function post(e) {
    e.preventDefault();
    const text = body.trim();
    if (!text || posting) return;
    const postedTo = versionId;
    setPosting(true);
    try {
      await api.post(`/versions/${postedTo}/comments`, { body: text });
      if (!mounted.current) return;
      toast.success("Comment posted");
      // The user may have switched versions meanwhile: that draft and list are not ours to touch.
      if (currentVersion.current === postedTo) {
        setBody("");
        await load();
      }
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      if (mounted.current) setPosting(false);
    }
  }

  const tooLong = body.length > MAX_COMMENT;

  return (
    <section className="section comment-thread" aria-label="Discussion">
      <div className="section-head">
        <h3>Discussion</h3>
        <span className="muted">{comments.length} {comments.length === 1 ? "comment" : "comments"}</span>
      </div>
      <ErrorBox>{error}</ErrorBox>
      {loading ? (
        <Loading rows={1} />
      ) : comments.length === 0 ? (
        <p className="muted small">No comments yet.</p>
      ) : (
        <ul className="comment-list">
          {comments.map((c) => (
            <li key={c._id} className="comment">
              <div className="comment-meta">
                <strong>{c.authorName}</strong>
                <span className="muted small">{roleLabel(c.authorRole)}</span>
                <time className="muted small mono" dateTime={c.createdAt}>{fmtDateTime(c.createdAt)}</time>
              </div>
              <p className="comment-body">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={post} className="comment-form">
        <label>
          Add a comment
          <textarea
            rows={3}
            value={body}
            maxLength={MAX_COMMENT}
            onChange={(e) => setBody(e.target.value)}
            aria-describedby={`cc-count-${versionId}`}
          />
        </label>
        <div className="form-foot">
          <span id={`cc-count-${versionId}`} className={`hint mono${tooLong ? " over" : ""}`}>
            {body.length}/{MAX_COMMENT}
          </span>
          <button type="submit" disabled={posting || !body.trim() || tooLong} aria-busy={posting}>
            {posting ? "Posting…" : "Post comment"}
          </button>
        </div>
      </form>
    </section>
  );
}
