import { useRef, useState } from 'react';
import { api } from '../lib/api';

export function AddRepoPage(props: { onDone: (repoId: number) => void }) {
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const submitClone = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await api.cloneRepo(url);
      setMessage(`clone queued (repository #${res.repositoryId}). Watch progress under Repositories.`);
      setUrl('');
      props.onDone(res.repositoryId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitUpload = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await api.uploadRepo(file);
      setMessage(`upload queued (repository #${res.repositoryId}). Watch progress under Repositories.`);
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      props.onDone(res.repositoryId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Add repository</h1>
      <section className="panel">
        <h2>Clone from remote URL</h2>
        <p className="muted">The repository is deeply cloned (full history) into local storage.</p>
        <div className="row">
          <input
            type="text"
            style={{ minWidth: 380, padding: '8px', border: '1px solid var(--line)', borderRadius: 6 }}
            placeholder="https://github.com/DaveGamble/cJSON.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="primary" disabled={busy || !url.trim()} onClick={submitClone}>
            clone &amp; analyse
          </button>
        </div>
      </section>
      <section className="panel">
        <h2>Upload zip</h2>
        <p className="muted">The zip must contain the repository including its .git directory.</p>
        <div className="row">
          <input type="file" accept=".zip,application/zip" ref={fileInput} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button className="primary" disabled={busy || !file} onClick={submitUpload}>
            upload &amp; analyse
          </button>
        </div>
      </section>
      {message && (
        <section className="panel">
          <p>{message}</p>
        </section>
      )}
      {error && (
        <section className="panel">
          <p className="error-text">{error}</p>
        </section>
      )}
    </>
  );
}
